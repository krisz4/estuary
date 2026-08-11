import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type TicketPriority,
  type TicketStatus,
} from "@helpdesk/contracts";
import type { Comment, Prisma, Ticket } from "@prisma/client";

import { prisma } from "../lib/prisma.js";

/**
 * Explicit row builders for API tests.
 *
 * They are builders, not a fixture set: `makeTicket({ status: "resolved" })`
 * declares exactly the field the assertion depends on and leaves everything else
 * to a valid default. Tests never read from the seed
 * (`docs/features/Seed_Data.md`) — a suite coupled to seed output breaks the day
 * the seed changes, and the seed's realism is worth nothing to an assertion.
 *
 * These write through Prisma directly rather than through the ticket service.
 * That is deliberate: a service test that arranges its data with the same
 * service call it is asserting on cannot fail when that call is wrong.
 */

/* ------------------------------------------------------------------ *
 * Ranks
 * ------------------------------------------------------------------ */

/**
 * The rank columns are mechanical: the index of the value in the contract enum
 * (`docs/engineering/DATABASE.md`). Derived here so a factory row sorts exactly
 * like a row created through the API.
 *
 * Stage 6 introduces `services/ticket-status.ts` as the *only* writer of these
 * columns on production paths. This helper is a test-side mirror, not a second
 * writer — and the invariant is asserted by sorting, never by reading the
 * column, so a drift between the two shows up as a failing test rather than as
 * quietly agreeing wrong answers.
 */
const statusRankOf = (status: TicketStatus): number => TICKET_STATUSES.indexOf(status);
const priorityRankOf = (priority: TicketPriority): number => TICKET_PRIORITIES.indexOf(priority);

/* ------------------------------------------------------------------ *
 * Tickets
 * ------------------------------------------------------------------ */

/**
 * Per-module counter, so titles and emails are distinct without being random.
 * Each test file gets a fresh module registry, hence a fresh count — values are
 * reproducible from the file alone.
 */
let sequence = 0;

export type MakeTicketOverrides = Partial<Prisma.TicketUncheckedCreateInput>;

/**
 * Insert one ticket and return the row.
 *
 * Defaults: `open` / `medium`, assigned, categorised, `createdAt` now. Anything
 * a test cares about is passed in — including `createdAt`, which date-range and
 * paging tests must control rather than hope for.
 *
 * `statusRank` / `priorityRank` follow the final status and priority unless
 * explicitly overridden (overriding them is how a "corrupt row" test arranges
 * its data). `resolvedAt` / `closedAt` follow the status the same way, so a
 * `closed` fixture is not silently missing the timestamps its own invariants
 * require; pass `null` to opt out.
 */
export async function makeTicket(overrides: MakeTicketOverrides = {}): Promise<Ticket> {
  sequence += 1;
  const n = sequence;

  const status = (overrides.status as TicketStatus | undefined) ?? "open";
  const priority = (overrides.priority as TicketPriority | undefined) ?? "medium";
  const now = new Date();

  const impliedResolvedAt = status === "resolved" || status === "closed" ? now : null;
  const impliedClosedAt = status === "closed" ? now : null;

  return prisma.ticket.create({
    data: {
      title: `Test ticket ${n}`,
      description: `Description for test ticket ${n}. Long enough to satisfy the contract bounds.`,
      requesterName: `Requester ${n}`,
      // Stored lowercase — exact-match filtering is case-sensitive on SQLite.
      requesterEmail: `requester${n}@example.com`,
      assignee: `Agent ${n}`,
      category: "software",
      ...overrides,
      status,
      priority,
      statusRank: "statusRank" in overrides ? overrides.statusRank : statusRankOf(status),
      priorityRank: "priorityRank" in overrides ? overrides.priorityRank : priorityRankOf(priority),
      // Key presence, not `??`: `null ?? impliedResolvedAt` is the implied value,
      // so the documented opt-out would silently do nothing and a test arranging
      // a closed ticket with no resolvedAt would be handed a well-formed row and
      // pass vacuously.
      resolvedAt: "resolvedAt" in overrides ? overrides.resolvedAt : impliedResolvedAt,
      closedAt: "closedAt" in overrides ? overrides.closedAt : impliedClosedAt,
    },
  });
}

/**
 * Insert `count` tickets **in order**, one at a time, so ids ascend with the
 * index. `overrides` may be a per-index function — `makeTickets(3, (i) => ({
 * createdAt: new Date(2026, 0, i + 1) }))` — which is what paging and sorting
 * tests need.
 *
 * Sequential on purpose: `Promise.all` here would interleave writes on a
 * single-writer database and make id order non-deterministic.
 */
export async function makeTickets(
  count: number,
  overrides: MakeTicketOverrides | ((index: number) => MakeTicketOverrides) = {},
): Promise<Ticket[]> {
  const rows: Ticket[] = [];
  for (let index = 0; index < count; index += 1) {
    rows.push(await makeTicket(typeof overrides === "function" ? overrides(index) : overrides));
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * Comments
 * ------------------------------------------------------------------ */

export type MakeCommentOverrides = Partial<Prisma.CommentUncheckedCreateInput> & {
  ticketId: number;
};

/**
 * Insert one comment. `ticketId` is required rather than defaulted to a
 * freshly-created ticket: a comment whose parent the test did not name is a
 * comment the test cannot assert about.
 *
 * Note that this does **not** touch `Ticket.updatedAt` — the same guarantee the
 * comment routes make (`docs/features/Comments.md`), so a fixture cannot
 * manufacture a passing test for it.
 */
export async function makeComment(overrides: MakeCommentOverrides): Promise<Comment> {
  sequence += 1;
  const n = sequence;

  return prisma.comment.create({
    data: {
      authorName: `Commenter ${n}`,
      body: `Comment body ${n}`,
      ...overrides,
    },
  });
}
