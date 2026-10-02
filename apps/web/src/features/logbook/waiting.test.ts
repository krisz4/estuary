import { describe, expect, it } from "vitest";
import {
  formatWaitDuration,
  isStillWaiting,
  waitingMax,
  waitingSeries,
} from "@/features/logbook/waiting";

const bucket = (medianMinutes: number | null, p90Minutes: number | null) => ({
  start: "2026-09-01T00:00:00.000Z",
  end: "2026-09-02T00:00:00.000Z",
  created: 0,
  completed: 0,
  deferred: 0,
  sentBack: 0,
  statusCounts: {} as never,
  humanWait: { count: medianMinutes === null ? 0 : 4, medianMinutes, p90Minutes },
});

describe("waitingSeries", () => {
  it("carries median/p90/count through, null when there is nothing waiting yet", () => {
    const [point] = waitingSeries([bucket(30, 90)]);
    expect(point).toEqual({
      start: "2026-09-01T00:00:00.000Z",
      end: "2026-09-02T00:00:00.000Z",
      medianMinutes: 30,
      p90Minutes: 90,
      count: 4,
    });
  });

  it("ignores nulls when computing the axis max", () => {
    expect(waitingMax(waitingSeries([bucket(null, null), bucket(20, 200)]))).toBe(200);
  });
});

describe("isStillWaiting", () => {
  const wait = {
    taskId: 1,
    reference: "TASK-000001",
    title: "t",
    status: "needs_qa" as const,
    minutes: 10,
    startedAt: "2026-09-01T00:00:00.000Z",
    endedAt: null,
  };

  it("is true only when endedAt is null", () => {
    expect(isStillWaiting(wait)).toBe(true);
    expect(isStillWaiting({ ...wait, endedAt: "2026-09-02T00:00:00.000Z" })).toBe(false);
  });
});

describe("formatWaitDuration", () => {
  it.each([
    [5, "5m"],
    [65, "1h 5m"],
    [60 * 26 + 10, "1d 2h"],
    [0, "0m"],
  ])("formats %i minutes as %s", (minutes, expected) => {
    expect(formatWaitDuration(minutes)).toBe(expected);
  });
});
