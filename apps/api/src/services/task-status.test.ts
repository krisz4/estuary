import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type TicketStatus,
  type TicketPriority,
} from "@helpdesk/contracts";
import { describe, expect, it } from "vitest";

import { ApiError } from "../lib/errors.js";
import {
  ALLOWED_TRANSITIONS,
  applyStatusSideEffects,
  applyTicketRanks,
  assertTransition,
  isTransitionAllowed,
  PRIORITY_RANK,
  STATUS_RANK,
} from "./ticket-status.js";

/**
 * Pure unit tests for the lifecycle rules. No database — everything in
 * `ticket-status.ts` is a function of its arguments, and keeping it that way is
 * what lets `ticket.service.ts` fold a guard, two timestamps, and two rank
 * columns into a single write.
 *
 * The behaviour these describe is asserted *again* through the service, against
 * real rows, in `ticket.service.test.ts`. That is not duplication: these say the
 * rules are right, those say the rules are actually applied.
 */

const NOW = new Date("2026-08-11T10:00:00.000Z");
const EARLIER = new Date("2026-08-01T09:00:00.000Z");

describe("rank tables", () => {
  it("ranks statuses in lifecycle order, not alphabetically", () => {
    expect(STATUS_RANK).toEqual({ open: 0, in_progress: 1, resolved: 2, closed: 3 });
  });

  it("ranks priorities by severity, so urgent outranks medium", () => {
    expect(PRIORITY_RANK).toEqual({ low: 0, medium: 1, high: 2, urgent: 3 });

    // The whole point of the column: alphabetical order is meaningless here.
    expect(PRIORITY_RANK.urgent).toBeGreaterThan(PRIORITY_RANK.medium);
    expect(PRIORITY_RANK.high).toBeGreaterThan(PRIORITY_RANK.medium);
  });

  it("covers every value in the contract enums", () => {
    // A status added to the contract without a rank would write `undefined` into
    // an Int column. The tables are derived from these arrays, so this is a
    // regression guard on the derivation, not on a hand-written literal.
    expect(Object.keys(STATUS_RANK).sort()).toEqual([...TICKET_STATUSES].sort());
    expect(Object.keys(PRIORITY_RANK).sort()).toEqual([...TICKET_PRIORITIES].sort());
  });
});

describe("applyTicketRanks", () => {
  it("derives both rank columns when both fields are written", () => {
    expect(applyTicketRanks({ status: "closed", priority: "urgent" })).toEqual({
      status: "closed",
      priority: "urgent",
      statusRank: 3,
      priorityRank: 3,
    });
  });

  it("leaves a rank column absent when its field is not being written", () => {
    // A PATCH that does not mention priority must not rewrite priorityRank —
    // an emitted `priorityRank: undefined` would be a Prisma no-op today but is
    // one refactor away from writing null into a non-nullable column.
    const data = applyTicketRanks({ status: "resolved" });

    expect(data).toEqual({ status: "resolved", statusRank: 2 });
    expect("priorityRank" in data).toBe(false);
  });

  it("passes unrelated fields through untouched", () => {
    expect(applyTicketRanks({ title: "Printer jam", priority: "low" })).toEqual({
      title: "Printer jam",
      priority: "low",
      priorityRank: 0,
    });
  });

  it("does not mutate its argument", () => {
    const input = { status: "closed" as TicketStatus };
    applyTicketRanks(input);

    expect(input).toEqual({ status: "closed" });
  });
});

describe("assertTransition", () => {
  /** Every ordered pair of distinct statuses, so nothing is silently untested. */
  const pairs = TICKET_STATUSES.flatMap((from) =>
    TICKET_STATUSES.filter((to) => to !== from).map((to) => [from, to] as const),
  );

  const ILLEGAL: ReadonlyArray<readonly [TicketStatus, TicketStatus]> = [["closed", "resolved"]];

  const isIllegal = (from: TicketStatus, to: TicketStatus) =>
    ILLEGAL.some(([f, t]) => f === from && t === to);

  it.each(pairs.filter(([from, to]) => !isIllegal(from, to)))("allows %s → %s", (from, to) => {
    expect(() => assertTransition(from, to)).not.toThrow();
    expect(isTransitionAllowed(from, to)).toBe(true);
  });

  it.each(pairs.filter(([from, to]) => isIllegal(from, to)))("rejects %s → %s", (from, to) => {
    expect(() => assertTransition(from, to)).toThrow(ApiError);
    expect(isTransitionAllowed(from, to)).toBe(false);
  });

  it("treats setting the status a ticket already has as allowed", () => {
    // The service short-circuits `X → X` before reaching the guard, but the
    // guard must not be the thing that makes an idempotent PATCH a 409.
    for (const status of TICKET_STATUSES) {
      expect(() => assertTransition(status, status)).not.toThrow();
    }
  });

  it("throws INVALID_STATUS_TRANSITION with from, to, and the allowed list", () => {
    let thrown: unknown;
    try {
      assertTransition("closed", "resolved");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ApiError);
    const error = thrown as ApiError;

    expect(error.code).toBe("INVALID_STATUS_TRANSITION");
    expect(error.status).toBe(409);
    expect(error.details).toEqual({
      from: "closed",
      to: "resolved",
      allowed: ["open", "in_progress"],
    });
    // The client renders the legal options from `details`. A live reference
    // would let a caller mutate `ALLOWED_TRANSITIONS` for the whole process
    // through the error object, so the array must be a copy. Compare the
    // *array* — comparing `error.details` (an object) against the array can
    // never be equal and so can never fail.
    const details = error.details as { allowed: readonly string[] };
    expect(details.allowed).not.toBe(ALLOWED_TRANSITIONS.closed);
    expect(details.allowed).toEqual(ALLOWED_TRANSITIONS.closed);
  });

  /**
   * `status` is an unconstrained `String` column, so a row written by direct SQL
   * or a `db push` experiment can hold a value outside the enum. Dereferencing
   * `ALLOWED_TRANSITIONS[from]` on such a row throws a `TypeError` that reaches
   * the client as a 500. It has to be the documented 409 instead, carrying the
   * bad value so the operator can see what is in the row.
   */
  it("rejects rather than crashes when the current status is outside the enum", () => {
    const bogus = "archived" as TicketStatus;

    expect(isTransitionAllowed(bogus, "open")).toBe(false);
    expect(() => assertTransition(bogus, "open")).toThrow(ApiError);

    try {
      assertTransition(bogus, "open");
    } catch (error) {
      expect((error as ApiError).status).toBe(409);
      expect((error as ApiError).details).toEqual({
        from: "archived",
        to: "open",
        allowed: [],
      });
    }

    // A no-op patch on such a row is still fine — X → X never reaches the table.
    expect(isTransitionAllowed(bogus, bogus)).toBe(true);
  });
});

describe("applyStatusSideEffects", () => {
  it("stamps resolvedAt when a ticket is resolved", () => {
    expect(applyStatusSideEffects("in_progress", "resolved", { resolvedAt: null }, NOW)).toEqual({
      resolvedAt: NOW,
    });
  });

  it("keeps an existing resolvedAt when resolving again from a reopened state", () => {
    // "only if currently null" — a ticket that was resolved, reopened without
    // clearing (not reachable today), and resolved again keeps the first stamp.
    expect(applyStatusSideEffects("in_progress", "resolved", { resolvedAt: EARLIER }, NOW)).toEqual(
      {},
    );
  });

  it("stamps closedAt and backfills resolvedAt when a ticket is closed from open", () => {
    // Deliberate: it keeps "closed implies resolved" true for any consumer, at
    // the cost of a resolution time the ticket never really had.
    expect(applyStatusSideEffects("open", "closed", { resolvedAt: null }, NOW)).toEqual({
      closedAt: NOW,
      resolvedAt: NOW,
    });
  });

  it("preserves the original resolvedAt when closing a resolved ticket", () => {
    expect(applyStatusSideEffects("resolved", "closed", { resolvedAt: EARLIER }, NOW)).toEqual({
      closedAt: NOW,
      resolvedAt: EARLIER,
    });
  });

  it("clears both timestamps when reopening a closed ticket to open", () => {
    expect(applyStatusSideEffects("closed", "open", { resolvedAt: EARLIER }, NOW)).toEqual({
      resolvedAt: null,
      closedAt: null,
    });
  });

  it("clears both timestamps when reopening a closed ticket to in_progress", () => {
    expect(applyStatusSideEffects("closed", "in_progress", { resolvedAt: EARLIER }, NOW)).toEqual({
      resolvedAt: null,
      closedAt: null,
    });
  });

  it("clears resolvedAt when a resolved ticket goes back to in_progress", () => {
    // The case the "from a terminal state" phrasing missed: only `closed` is
    // terminal, so this transition was undefined and stranded a resolvedAt on a
    // ticket that is demonstrably not resolved.
    expect(applyStatusSideEffects("resolved", "in_progress", { resolvedAt: EARLIER }, NOW)).toEqual(
      {
        resolvedAt: null,
        closedAt: null,
      },
    );
  });

  it("clears resolvedAt when a resolved ticket is reopened to open", () => {
    expect(applyStatusSideEffects("resolved", "open", { resolvedAt: EARLIER }, NOW)).toEqual({
      resolvedAt: null,
      closedAt: null,
    });
  });

  it("writes no timestamps when moving between the two active states", () => {
    expect(applyStatusSideEffects("open", "in_progress", { resolvedAt: null }, NOW)).toEqual({});
    expect(applyStatusSideEffects("in_progress", "open", { resolvedAt: null }, NOW)).toEqual({});
  });

  it("defaults `now` to the current time", () => {
    const before = Date.now();
    const { resolvedAt } = applyStatusSideEffects("open", "resolved", { resolvedAt: null });
    const after = Date.now();

    expect(resolvedAt).toBeInstanceOf(Date);
    expect((resolvedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((resolvedAt as Date).getTime()).toBeLessThanOrEqual(after);
  });
});

describe("the rank tables and the transition table agree with the contract enums", () => {
  it("lists only real statuses as transition targets", () => {
    for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
      expect(TICKET_STATUSES).toContain(from as TicketStatus);
      for (const target of targets) expect(TICKET_STATUSES).toContain(target);
    }
  });

  it("assigns a distinct rank to every priority", () => {
    const ranks = TICKET_PRIORITIES.map((p: TicketPriority) => PRIORITY_RANK[p]);
    expect(new Set(ranks).size).toBe(TICKET_PRIORITIES.length);
  });
});
