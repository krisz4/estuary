import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type TicketPriority,
  type TicketStatus,
} from "@helpdesk/contracts";

import { invalidStatusTransition } from "../lib/errors.js";

/**
 * Status lifecycle, rank derivation, and the timestamp side effects a status
 * change triggers. See `docs/features/Ticket_Status_Lifecycle.md` and
 * `docs/features/Ticket_Priority.md`.
 *
 * Everything here is pure: no Prisma, no `req`/`res`. The service composes these
 * into a single write, which is what makes "ranks and timestamps move in the
 * same update as the status" true by construction rather than by discipline.
 */

/* ------------------------------------------------------------------ *
 * Ranks
 * ------------------------------------------------------------------ */

/**
 * `statusRank` / `priorityRank` exist only so SQLite can order by lifecycle and
 * severity instead of alphabetically (`urgent` sorts before `medium` as text,
 * which is meaningless). They are the index of the value in the contract enum.
 *
 * Built **from** the contract arrays rather than written out as literals: a
 * value added to `TICKET_STATUSES` without a matching entry here would otherwise
 * be a runtime `undefined` written into an `Int` column. Derived this way, the
 * record is exhaustive by construction and the `Record<…>` annotation makes a
 * missing key a compile error too.
 */
const rankOf = <T extends string>(values: readonly T[]): Record<T, number> =>
  Object.fromEntries(values.map((value, index) => [value, index])) as Record<T, number>;

export const STATUS_RANK: Record<TicketStatus, number> = rankOf(TICKET_STATUSES);
export const PRIORITY_RANK: Record<TicketPriority, number> = rankOf(TICKET_PRIORITIES);

/** The subset of a Prisma write payload this module cares about. */
export interface RankableTicketWrite {
  status?: TicketStatus;
  priority?: TicketPriority;
}

/**
 * **The only writer of `statusRank` / `priorityRank`.**
 *
 * Every Prisma write that can touch `status` or `priority` passes its `data`
 * through here, so the derived columns cannot drift from the strings they
 * describe. A raw `prisma.ticket.update({ data: { priority } })` anywhere else
 * corrupts sort order silently — the row still reads back correctly, and only a
 * sorted query notices. That is why the invariant is asserted by *sorting*.
 *
 * A field absent from `data` stays absent from the result: a PATCH that does not
 * mention `priority` must not rewrite `priorityRank`.
 */
export const applyTicketRanks = <T extends RankableTicketWrite>(
  data: T,
): T & { statusRank?: number; priorityRank?: number } => ({
  ...data,
  ...(data.status === undefined ? {} : { statusRank: STATUS_RANK[data.status] }),
  ...(data.priority === undefined ? {} : { priorityRank: PRIORITY_RANK[data.priority] }),
});

/* ------------------------------------------------------------------ *
 * Transitions
 * ------------------------------------------------------------------ */

/**
 * Deliberately permissive: this is a helpdesk, not an approval workflow, and an
 * over-strict table produces support tickets about the ticket system.
 *
 * The single illegal move is `closed → resolved` — a closed ticket reopens to
 * active work, it does not slide back into "awaiting confirmation".
 *
 * `X → X` is not listed anywhere and does not need to be: the service
 * short-circuits an unchanged status before it ever reaches the guard.
 */
export const ALLOWED_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  open: ["in_progress", "resolved", "closed"],
  in_progress: ["open", "resolved", "closed"],
  resolved: ["open", "in_progress", "closed"],
  closed: ["open", "in_progress"],
};

/**
 * The `from` lookup is guarded rather than dereferenced. `status` is an
 * unconstrained `String` column (`docs/engineering/DATABASE.md`), so a row
 * written by direct SQL, a `db push` experiment, or a corrupt-row test fixture
 * can hold a value outside the enum. `ALLOWED_TRANSITIONS[from]` would then be
 * `undefined` and a PATCH would die as a `TypeError` → 500. An unknown current
 * status instead means "no transition out of here is legal", which surfaces as
 * the documented 409 carrying the bad value in `details.from`.
 */
export const isTransitionAllowed = (from: TicketStatus, to: TicketStatus): boolean =>
  from === to || (ALLOWED_TRANSITIONS[from]?.includes(to) ?? false);

/**
 * Throws `INVALID_STATUS_TRANSITION` (409) with `details: { from, to, allowed }`
 * so the client can render the legal options without a second round trip.
 */
export function assertTransition(from: TicketStatus, to: TicketStatus): void {
  if (isTransitionAllowed(from, to)) return;
  throw invalidStatusTransition(from, to, ALLOWED_TRANSITIONS[from] ?? []);
}

/* ------------------------------------------------------------------ *
 * Side effects
 * ------------------------------------------------------------------ */

/** The two derived timestamps, as a Prisma write fragment. */
export interface StatusTimestamps {
  resolvedAt?: Date | null;
  closedAt?: Date | null;
}

/** What the side effects need to know about the row as it stands. */
export interface TicketTimestampState {
  resolvedAt: Date | null;
}

const REOPENED_STATUSES: readonly TicketStatus[] = ["open", "in_progress"];
const CLOSED_OR_RESOLVED: readonly TicketStatus[] = ["resolved", "closed"];

/**
 * The timestamp fragment that belongs in the same write as a status change.
 *
 * | Transition | Effect |
 * | ---------- | ------ |
 * | → `resolved` | `resolvedAt = now` (only if currently null) |
 * | → `closed` | `closedAt = now`; `resolvedAt ??= now` |
 * | `resolved` **or** `closed` → `open` or `in_progress` | both cleared |
 *
 * The third row names both source states on purpose. Phrased as "from a terminal
 * state" it would cover only `closed`, leaving `resolved → in_progress` to strand
 * a `resolvedAt` on a ticket that is demonstrably not resolved.
 *
 * `closed` backfilling `resolvedAt` keeps "closed implies resolved" true for any
 * consumer, at the cost of a ticket closed straight from `open` reporting a
 * resolution time it never really had. That trade is stated in the feature doc.
 *
 * Pure, and `now` is injectable so a test can pin it.
 */
export function applyStatusSideEffects(
  from: TicketStatus,
  to: TicketStatus,
  current: TicketTimestampState,
  now: Date = new Date(),
): StatusTimestamps {
  if (to === "closed") {
    return { closedAt: now, resolvedAt: current.resolvedAt ?? now };
  }

  if (to === "resolved") {
    return current.resolvedAt === null ? { resolvedAt: now } : {};
  }

  // → open / in_progress. Only a reopen clears; open ↔ in_progress leaves the
  // (already null) timestamps alone rather than writing two redundant nulls.
  if (REOPENED_STATUSES.includes(to) && CLOSED_OR_RESOLVED.includes(from)) {
    return { resolvedAt: null, closedAt: null };
  }

  return {};
}
