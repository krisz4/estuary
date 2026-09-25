import {
  DEFAULT_TICKET_STATUS,
  type CreateTicketInput,
  type Ticket,
  type TicketCategory,
  type TicketFacets,
  type TicketPriority,
  type TicketStatus,
  type UpdateTicketInput,
} from "@helpdesk/contracts";
import type { Prisma } from "@prisma/client";

import { ticketNotFound } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { serializeTicket } from "../lib/serialize.js";
import { applyStatusSideEffects, applyTicketRanks, assertTransition } from "./ticket-status.js";

/**
 * Ticket business logic. Every Prisma call for the resource lives here; nothing
 * in this file knows about `req`, `res`, or HTTP — failures are thrown as
 * `ApiError` and `middleware/errorHandler.ts` is the only thing that writes an
 * error body (`docs/engineering/ARCHITECTURE.md`).
 *
 * The list query (`listTickets`) is deliberately **not** here: it is its own
 * module, `services/ticket-query.ts`.
 */

/* ------------------------------------------------------------------ *
 * Shared read shape
 * ------------------------------------------------------------------ */

/**
 * Comments come back oldest-first, `createdAt` then `id`. The `id` tiebreaker is
 * load-bearing, not decorative: several comments can land inside the same
 * millisecond (the seed does it on purpose), and without a monotonic tiebreaker
 * their order would differ between reads. See `docs/features/Comments.md`.
 */
const withComments = {
  comments: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
} satisfies Prisma.TicketInclude;

/* ------------------------------------------------------------------ *
 * Read
 * ------------------------------------------------------------------ */

export async function getTicket(id: number): Promise<Ticket> {
  const row = await prisma.ticket.findUnique({ where: { id }, include: withComments });
  if (row === null) throw ticketNotFound(id);
  return serializeTicket(row);
}

/**
 * Distinct non-null values actually present in the table, sorted.
 *
 * The assignee list is the only source of options for the list page's assignee
 * filter, and that is what makes case-sensitive exact matching safe: the client
 * sends back a value the database certainly stores, rather than a name a user
 * typed with different capitalisation. Categories are returned despite the enum
 * being fixed, so the filter only offers values that would return rows.
 *
 * `groupBy`, not `findMany` + `distinct`. Prisma's `distinct` is applied **in
 * memory**: it emits a plain `SELECT id, assignee … ORDER BY assignee` and
 * dedupes the result set in the client, so the endpoint would materialise one
 * row per assigned ticket. `groupBy` emits a real `GROUP BY`, which SQLite can
 * satisfy from `Ticket_assignee_idx` and which returns one row per distinct
 * value. Irrelevant at 63 seeded rows; wrong shape to leave in place.
 *
 * Measured, not assumed. `distinct` emits
 * `SELECT id, assignee FROM Ticket WHERE assignee IS NOT NULL ORDER BY assignee`
 * — note the `id`, which alone rules out an index-only plan. `groupBy` emits the
 * `GROUP BY`, and `EXPLAIN QUERY PLAN` reports
 * `SEARCH Ticket USING COVERING INDEX Ticket_assignee_idx`.
 */
export async function getTicketFacets(): Promise<TicketFacets> {
  const [assigneeRows, categoryRows] = await Promise.all([
    prisma.ticket.groupBy({
      by: ["assignee"],
      where: { assignee: { not: null } },
      orderBy: { assignee: "asc" },
    }),
    prisma.ticket.groupBy({
      by: ["category"],
      where: { category: { not: null } },
      orderBy: { category: "asc" },
    }),
  ]);

  return {
    // The `not: null` filter already excludes nulls; the narrowing predicate is
    // for the type checker, which cannot know that from the Prisma types.
    assignees: assigneeRows
      .map((row) => row.assignee)
      .filter((value): value is string => value !== null),
    categories: categoryRows
      .map((row) => row.category)
      .filter((value): value is TicketCategory => value !== null),
  };
}

/* ------------------------------------------------------------------ *
 * Write
 * ------------------------------------------------------------------ */

/**
 * The fields a service may write. Declared here rather than reaching for
 * `Prisma.TicketUncheckedUpdateInput` so that `statusRank` and `priorityRank`
 * are *absent from the type* — the only way they get into a payload is through
 * `applyTicketRanks()`, which adds them.
 */
interface TicketWriteData {
  title?: string;
  description?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  category?: TicketCategory | null;
  requesterName?: string;
  requesterEmail?: string;
  assignee?: string | null;
  resolvedAt?: Date | null;
  closedAt?: Date | null;
}

/** Create writes every non-nullable column, so those fields lose their `?`. */
type TicketCreateData = TicketWriteData &
  Required<
    Pick<
      TicketWriteData,
      "title" | "description" | "status" | "priority" | "requesterName" | "requesterEmail"
    >
  >;

/**
 * A new ticket is always `open`: `createTicketInputSchema` has no `status` field,
 * and `.strict()` rejects a payload that supplies one.
 *
 * `priority` is never undefined here — the schema defaults it to `medium` — so
 * both rank columns are written on every create.
 */
export async function createTicket(input: CreateTicketInput): Promise<Ticket> {
  const data: TicketCreateData = {
    title: input.title,
    description: input.description,
    status: DEFAULT_TICKET_STATUS,
    priority: input.priority,
    category: input.category ?? null,
    requesterName: input.requesterName,
    requesterEmail: input.requesterEmail,
    assignee: input.assignee ?? null,
  };

  const row = await prisma.ticket.create({
    data: applyTicketRanks(data),
    include: withComments,
  });

  return serializeTicket(row);
}

/**
 * Partial update.
 *
 * Three things this does that a naive implementation does not:
 *
 * 1. **Loads the row first.** Existence is checked explicitly rather than caught
 *    as Prisma `P2025` — a 404 that depends on an error code from the driver is
 *    a 404 that changes when the driver does, and the transition guard needs the
 *    current status anyway.
 * 2. **Drops an unchanged `status` from the write.** `X → X` is a success that
 *    performs *no write*. `updatedAt` is `@updatedAt`, so writing an identical
 *    status would still move it and float the ticket to the top of an
 *    `updatedAt` sort with nothing having changed. If status was the only field
 *    in the body, nothing is written at all and the existing row is returned.
 * 3. **Folds the transition guard, the timestamps, and the ranks into one
 *    update**, so a row can never be observed with a new status and stale
 *    derived columns.
 * 4. **Reads and writes inside one transaction.** The guard is a read-then-write
 *    decision, so without one, two concurrent PATCHes both read `open`, one
 *    writes `closed`, and the other — still holding a stale `from` — passes
 *    `assertTransition("open", "resolved")` and lands the row on exactly the
 *    `closed → resolved` state this module exists to forbid. Inside a
 *    transaction SQLite fails the second write rather than applying it.
 *
 * The pre-read selects only what the decision needs. Loading the comment thread
 * here would fetch every comment twice on a normal field update, since the
 * `update` below returns the thread anyway; only the no-write branch has to go
 * back for it.
 */
export async function updateTicket(id: number, input: UpdateTicketInput): Promise<Ticket> {
  const row = await prisma.$transaction(async (tx) => {
    const existing = await tx.ticket.findUnique({
      where: { id },
      select: { id: true, status: true, resolvedAt: true },
    });
    if (existing === null) throw ticketNotFound(id);

    const data: TicketWriteData = {};

    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) data.description = input.description;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.category !== undefined) data.category = input.category;
    if (input.requesterName !== undefined) data.requesterName = input.requesterName;
    if (input.requesterEmail !== undefined) data.requesterEmail = input.requesterEmail;
    if (input.assignee !== undefined) data.assignee = input.assignee;

    // The current status is a String column, constrained to the enum by every
    // write path going through the zod schemas (`docs/engineering/DATABASE.md`).
    const from = existing.status as TicketStatus;

    if (input.status !== undefined && input.status !== from) {
      assertTransition(from, input.status);
      data.status = input.status;
      Object.assign(data, applyStatusSideEffects(from, input.status, existing));
    }

    // Nothing to write: either the body was `{ status: <current> }`, or every
    // field in it resolved to no change. Return the row as it stands, untouched
    // — the thread is fetched here rather than in the pre-read because this is
    // the only branch that needs it.
    if (Object.keys(data).length === 0) {
      return tx.ticket.findUniqueOrThrow({ where: { id }, include: withComments });
    }

    return tx.ticket.update({
      where: { id },
      data: applyTicketRanks(data),
      include: withComments,
    });
  });

  return serializeTicket(row);
}

/**
 * Hard delete. Comments cascade at the database level (FK `onDelete: Cascade`),
 * so nothing here deletes them — enforcing it in application code would leave
 * direct SQL and the seed able to orphan rows.
 *
 * Existence is checked explicitly, for the same reason as PATCH: deleting twice
 * must be a 404, not a 500 dressed up by a `P2025` backstop. The check and the
 * delete share a transaction so that two simultaneous deletes cannot both pass
 * the check and have the loser fall through to the generic `P2025` handler with
 * a `NOT_FOUND` instead of the documented `TICKET_NOT_FOUND`.
 */
export async function deleteTicket(id: number): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.ticket.findUnique({ where: { id }, select: { id: true } });
    if (existing === null) throw ticketNotFound(id);

    await tx.ticket.delete({ where: { id } });
  });
}
