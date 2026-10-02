import { describe, expect, it } from "vitest";
import {
  HISTORY_BUCKETS,
  HISTORY_LONGEST_WAITS,
  HISTORY_MAX_BUCKETS,
  HISTORY_MAX_CYCLE_TIMES,
  HUMAN_WAIT_STATUSES,
  historyQuerySchema,
  historyResponseSchema,
} from "./history.js";

const zeroStats = { count: 0, medianMinutes: null, p90Minutes: null };

const statusCounts = {
  backlog: 0,
  needs_refinement: 0,
  todo: 1,
  in_progress: 0,
  blocked: 0,
  needs_user_decision: 0,
  needs_user_action: 0,
  needs_qa: 0,
  done: 0,
  deferred: 0,
};

const bucket = {
  start: "2026-09-01T00:00:00.000Z",
  end: "2026-09-02T00:00:00.000Z",
  created: 1,
  completed: 0,
  deferred: 0,
  sentBack: 0,
  statusCounts,
  humanWait: zeroStats,
};

const response = {
  from: "2026-09-01T00:00:00.000Z",
  to: "2026-09-08T00:00:00.000Z",
  bucket: "day",
  buckets: [bucket],
  totals: {
    created: 1,
    completed: 0,
    deferred: 0,
    sentBack: 0,
    decisionsRequested: 0,
    decisionsAnswered: 0,
    humanWait: zeroStats,
    cycleTime: zeroStats,
  },
  cycleTimes: [],
  longestWaits: [],
  agents: [],
};

describe("historyQuerySchema", () => {
  it("defaults bucket to day and leaves from/to absent", () => {
    expect(historyQuerySchema.parse({})).toEqual({ bucket: "day" });
  });

  it("accepts an explicit from/to/bucket", () => {
    const parsed = historyQuerySchema.parse({
      from: "2026-09-01T00:00:00Z",
      to: "2026-09-08T00:00:00Z",
      bucket: "week",
    });
    expect(parsed).toEqual({
      from: "2026-09-01T00:00:00Z",
      to: "2026-09-08T00:00:00Z",
      bucket: "week",
    });
  });

  it("rejects to at or before from", () => {
    const result = historyQuerySchema.safeParse({
      from: "2026-09-08T00:00:00Z",
      to: "2026-09-01T00:00:00Z",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["to"]);

    expect(
      historyQuerySchema.safeParse({ from: "2026-09-01T00:00:00Z", to: "2026-09-01T00:00:00Z" })
        .success,
    ).toBe(false);
  });

  it("rejects an unknown bucket", () => {
    expect(historyQuerySchema.safeParse({ bucket: "month" }).success).toBe(false);
  });

  it("accepts repeatable project", () => {
    expect(historyQuerySchema.parse({ project: ["estuary", "billing"] }).project).toEqual([
      "estuary",
      "billing",
    ]);
  });

  it("rejects a date-only from — an instant with an offset is required", () => {
    expect(historyQuerySchema.safeParse({ from: "2026-09-01" }).success).toBe(false);
  });

  it("rejects an unknown parameter", () => {
    expect(historyQuerySchema.safeParse({ groupBy: "project" }).success).toBe(false);
  });
});

describe("historyResponseSchema", () => {
  it("accepts a well-formed response", () => {
    expect(historyResponseSchema.parse(response)).toEqual(response);
  });

  it("requires every statusCounts key on a bucket row", () => {
    const { done: _done, ...incomplete } = statusCounts;
    const broken = { ...response, buckets: [{ ...bucket, statusCounts: incomplete }] };
    expect(historyResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts cycleTimes with a null title (task deleted since)", () => {
    const withCycle = {
      ...response,
      cycleTimes: [
        {
          taskId: 42,
          reference: "TASK-000042",
          title: null,
          actor: "agent:claude-code",
          minutes: 120,
          finishedAt: "2026-09-02T00:00:00.000Z",
        },
      ],
    };
    expect(historyResponseSchema.safeParse(withCycle).success).toBe(true);
  });

  it("accepts an ongoing humanWait stint with endedAt null", () => {
    const withWait = {
      ...response,
      longestWaits: [
        {
          taskId: 7,
          reference: "TASK-000007",
          title: "Needs a decision",
          status: "needs_user_decision",
          minutes: 90,
          startedAt: "2026-09-01T00:00:00.000Z",
          endedAt: null,
        },
      ],
    };
    expect(historyResponseSchema.safeParse(withWait).success).toBe(true);
  });

  it("rejects a humanWait status outside HUMAN_WAIT_STATUSES-adjacent but still valid TaskStatus — status itself is any TaskStatus", () => {
    // `humanWaitSchema.status` is typed as any TaskStatus (a stint's status is
    // whichever human-wait status it was in), not narrowed to the three-value
    // enum — this pins that a valid TaskStatus outside the human-wait set is
    // still schema-valid (the service is what only ever produces the three).
    const withWait = {
      ...response,
      longestWaits: [
        {
          taskId: 7,
          reference: "TASK-000007",
          title: null,
          status: "blocked",
          minutes: 90,
          startedAt: "2026-09-01T00:00:00.000Z",
          endedAt: null,
        },
      ],
    };
    expect(historyResponseSchema.safeParse(withWait).success).toBe(true);
  });

  it("rejects an unknown TaskStatus anywhere status appears", () => {
    const broken = {
      ...response,
      longestWaits: [
        {
          taskId: 7,
          reference: "TASK-000007",
          title: null,
          status: "waiting_room",
          minutes: 90,
          startedAt: "2026-09-01T00:00:00.000Z",
          endedAt: null,
        },
      ],
    };
    expect(historyResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an extra field anywhere in the envelope", () => {
    expect(historyResponseSchema.safeParse({ ...response, extra: true }).success).toBe(false);
  });
});

describe("constants", () => {
  it("HUMAN_WAIT_STATUSES is needs_user_decision, needs_user_action, needs_qa", () => {
    expect(HUMAN_WAIT_STATUSES).toEqual(["needs_user_decision", "needs_user_action", "needs_qa"]);
  });

  it("HISTORY_BUCKETS is hour, day, week", () => {
    expect(HISTORY_BUCKETS).toEqual(["hour", "day", "week"]);
  });

  it("caps are positive integers", () => {
    for (const cap of [HISTORY_MAX_BUCKETS, HISTORY_MAX_CYCLE_TIMES, HISTORY_LONGEST_WAITS]) {
      expect(Number.isInteger(cap)).toBe(true);
      expect(cap).toBeGreaterThan(0);
    }
  });
});
