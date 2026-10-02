import { describe, expect, it } from "vitest";
import { throughputMax, throughputSeries } from "@/features/logbook/throughput";

const bucket = (overrides: Partial<Parameters<typeof throughputSeries>[0][number]>) => ({
  start: "2026-09-01T00:00:00.000Z",
  end: "2026-09-02T00:00:00.000Z",
  created: 0,
  completed: 0,
  deferred: 0,
  sentBack: 0,
  statusCounts: {} as never,
  humanWait: { count: 0, medianMinutes: null, p90Minutes: null },
  ...overrides,
});

describe("throughputSeries", () => {
  it("combines completed and deferred into shipped", () => {
    const points = throughputSeries([
      bucket({ created: 5, completed: 3, deferred: 1, sentBack: 2 }),
    ]);
    expect(points).toEqual([
      {
        start: "2026-09-01T00:00:00.000Z",
        end: "2026-09-02T00:00:00.000Z",
        created: 5,
        shipped: 4,
        sentBack: 2,
      },
    ]);
  });

  it("finds the tallest bar across created and shipped", () => {
    const points = throughputSeries([
      bucket({ created: 2, completed: 1, deferred: 0 }),
      bucket({ created: 1, completed: 9, deferred: 0 }),
    ]);
    expect(throughputMax(points)).toBe(9);
  });

  it("is zero for an empty range", () => {
    expect(throughputMax([])).toBe(0);
  });
});
