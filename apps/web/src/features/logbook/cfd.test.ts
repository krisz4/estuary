import { TASK_STATUSES, type HistoryBucketRow, type TaskStatus } from "@estuary/contracts";
import { describe, expect, it } from "vitest";
import { cfdByStatus, cfdByZone } from "@/features/logbook/cfd";

const statusCounts = (overrides: Partial<Record<TaskStatus, number>>): Record<TaskStatus, number> =>
  Object.fromEntries(TASK_STATUSES.map((status) => [status, overrides[status] ?? 0])) as Record<
    TaskStatus,
    number
  >;

const makeBucket = (overrides: Partial<HistoryBucketRow>): HistoryBucketRow => ({
  start: "2026-09-01T00:00:00.000Z",
  end: "2026-09-02T00:00:00.000Z",
  created: 0,
  completed: 0,
  deferred: 0,
  sentBack: 0,
  statusCounts: statusCounts({}),
  humanWait: { count: 0, medianMinutes: null, p90Minutes: null },
  ...overrides,
});

describe("cfdByZone", () => {
  it("sums each zone's statuses per bucket, in shipped-first stack order", () => {
    const buckets = [
      makeBucket({
        statusCounts: statusCounts({ backlog: 3, todo: 2, in_progress: 1, blocked: 1, done: 5 }),
      }),
      makeBucket({
        statusCounts: statusCounts({ backlog: 2, todo: 2, in_progress: 2, done: 7, deferred: 1 }),
      }),
    ];

    const series = cfdByZone(buckets);
    expect(series.bands.map((band) => band.key)).toEqual([
      "shipped",
      "waiting",
      "build",
      "planning",
    ]);

    const shipped = series.bands.find((band) => band.key === "shipped")!;
    expect(shipped.values).toEqual([5, 8]);

    const planning = series.bands.find((band) => band.key === "planning")!;
    expect(planning.values).toEqual([5, 4]);

    const waiting = series.bands.find((band) => band.key === "waiting")!;
    expect(waiting.values).toEqual([1, 0]);
  });

  it("computes the tallest stacked total for the y-axis", () => {
    const buckets = [
      makeBucket({ statusCounts: statusCounts({ backlog: 10, done: 1 }) }),
      makeBucket({ statusCounts: statusCounts({ backlog: 3, done: 20 }) }),
    ];
    expect(cfdByZone(buckets).maxTotal).toBe(23);
  });

  it("returns zero bands for an empty range without throwing", () => {
    const series = cfdByZone([]);
    expect(series.maxTotal).toBe(0);
    expect(series.bands.every((band) => band.values.length === 0)).toBe(true);
  });
});

describe("cfdByStatus", () => {
  it("carries every status, reversed lifecycle order (closed statuses first)", () => {
    const series = cfdByStatus([makeBucket({})]);
    expect(series.bands[0]?.key).toBe("deferred");
    expect(series.bands.at(-1)?.key).toBe("backlog");
    expect(series.bands).toHaveLength(TASK_STATUSES.length);
  });
});
