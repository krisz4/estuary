import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  transitionInputSchema,
  type TaskStatus,
  type TransitionInputRaw,
} from "@estuary/contracts";
import { describe, expect, it } from "vitest";

import {
  applyStatusSideEffects,
  applyTaskRanks,
  PRIORITY_RANK,
  STATUS_RANK,
  statusNoteFor,
} from "./task-status.js";

/**
 * Pure unit tests for the status helpers. No database — everything in
 * `task-status.ts` is a function of its arguments, and keeping it that way is
 * what lets the workflow service fold ranks, timestamps, and the status note
 * into a single write.
 *
 * The behaviour these describe is asserted *again* through the service, against
 * real rows, in `task-workflow.service.test.ts`. That is not duplication: these
 * say the rules are right, those say the rules are actually applied.
 *
 * There is no transition-table test any more: the helpdesk from→to table (and
 * `INVALID_STATUS_TRANSITION`) was retired; what a status requires is the shape
 * of its transition payload, tested at the service and route.
 */

const NOW = new Date("2026-08-11T10:00:00.000Z");
const EARLIER = new Date("2026-08-01T09:00:00.000Z");

/** Transition payloads go through the real schema, as the route sends them. */
const transition = (raw: TransitionInputRaw) => transitionInputSchema.parse(raw);

describe("rank tables", () => {
  it("ranks statuses in lifecycle order, not alphabetically", () => {
    expect(STATUS_RANK).toEqual({
      backlog: 0,
      needs_refinement: 1,
      todo: 2,
      in_progress: 3,
      blocked: 4,
      needs_user_decision: 5,
      needs_user_action: 6,
      needs_qa: 7,
      done: 8,
      deferred: 9,
    });
  });

  it("ranks priorities by severity, so urgent outranks medium", () => {
    expect(PRIORITY_RANK).toEqual({ low: 0, medium: 1, high: 2, urgent: 3 });
  });

  it("covers every value in the contract enums", () => {
    // A status added to the contract without a rank would write `undefined` into
    // an Int column. The tables are derived from these arrays, so this is a
    // regression guard on the derivation, not on a hand-written literal.
    expect(Object.keys(STATUS_RANK).sort()).toEqual([...TASK_STATUSES].sort());
    expect(Object.keys(PRIORITY_RANK).sort()).toEqual([...TASK_PRIORITIES].sort());
  });
});

describe("applyTaskRanks", () => {
  it("derives both rank columns when both fields are written", () => {
    expect(applyTaskRanks({ status: "done", priority: "urgent" })).toEqual({
      status: "done",
      priority: "urgent",
      statusRank: 8,
      priorityRank: 3,
    });
  });

  it("leaves a rank column absent when its field is not being written", () => {
    // A PATCH that does not mention priority must not rewrite priorityRank.
    const data = applyTaskRanks({ status: "blocked" });

    expect(data).toEqual({ status: "blocked", statusRank: 4 });
    expect("priorityRank" in data).toBe(false);
  });

  it("passes unrelated fields through untouched", () => {
    expect(applyTaskRanks({ title: "Fix the build", priority: "low" })).toEqual({
      title: "Fix the build",
      priority: "low",
      priorityRank: 0,
    });
  });

  it("does not mutate its argument", () => {
    const input = { status: "done" as TaskStatus };
    applyTaskRanks(input);

    expect(input).toEqual({ status: "done" });
  });
});

describe("statusNoteFor", () => {
  it("uses the instructions for needs_user_action", () => {
    expect(
      statusNoteFor(
        transition({ to: "needs_user_action", instructions: "Rotate the key in Vault" }),
      ),
    ).toBe("Rotate the key in Vault");
  });

  it("uses the summary for needs_qa", () => {
    expect(statusNoteFor(transition({ to: "needs_qa", summary: "Added retries; run e2e" }))).toBe(
      "Added retries; run e2e",
    );
  });

  it("uses the question for needs_user_decision", () => {
    expect(
      statusNoteFor(
        transition({
          to: "needs_user_decision",
          decision: {
            question: "Keep the v1 route?",
            options: [{ label: "Yes" }, { label: "No" }],
          },
        }),
      ),
    ).toBe("Keep the v1 route?");
  });

  it.each([
    "backlog",
    "needs_refinement",
    "todo",
    "in_progress",
    "blocked",
    "done",
    "deferred",
  ] as const)("uses the reason for %s", (to) => {
    const raw = { to, reason: "Because of the migration" } as TransitionInputRaw;
    expect(statusNoteFor(transition(raw))).toBe("Because of the migration");
  });

  it("is null when the payload carries no text — the previous note does not survive", () => {
    expect(statusNoteFor(transition({ to: "in_progress" }))).toBeNull();
    expect(statusNoteFor(transition({ to: "blocked", blockedBy: [3] }))).toBeNull();
  });
});

describe("applyStatusSideEffects", () => {
  it("stamps startedAt the first time a task enters in_progress", () => {
    expect(applyStatusSideEffects("todo", "in_progress", { startedAt: null }, NOW)).toEqual({
      startedAt: NOW,
    });
  });

  it("never moves or clears startedAt once set", () => {
    expect(applyStatusSideEffects("todo", "in_progress", { startedAt: EARLIER }, NOW)).toEqual({});
    expect(applyStatusSideEffects("in_progress", "todo", { startedAt: EARLIER }, NOW)).toEqual({});
  });

  it("stamps completedAt on done", () => {
    expect(applyStatusSideEffects("needs_qa", "done", { startedAt: EARLIER }, NOW)).toEqual({
      completedAt: NOW,
    });
  });

  it.each(TASK_STATUSES.filter((status) => status !== "done"))(
    "clears completedAt when a done task is reopened to %s",
    (to) => {
      const effects = applyStatusSideEffects("done", to, { startedAt: EARLIER }, NOW);
      expect(effects.completedAt).toBeNull();
    },
  );

  it("does not touch completedAt between two non-done statuses", () => {
    const effects = applyStatusSideEffects("blocked", "todo", { startedAt: null }, NOW);
    expect("completedAt" in effects).toBe(false);
  });

  it("re-stamps completedAt on done → done rather than clearing it", () => {
    expect(applyStatusSideEffects("done", "done", { startedAt: EARLIER }, NOW)).toEqual({
      completedAt: NOW,
    });
  });
});
