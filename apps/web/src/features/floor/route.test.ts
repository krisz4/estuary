import { describe, expect, it } from "vitest";
import {
  computeAnimationDurationMs,
  diffMovedTasks,
  easeInOutCubic,
  MAIN_ORDER,
  pathLength,
  pickRouteKind,
  pointAtFraction,
  sampleQuadratic,
  sliceMainChannel,
} from "@/features/floor/route";

describe("pickRouteKind", () => {
  it("follows the main channel for a forward move on MAIN_ORDER", () => {
    expect(pickRouteKind("todo", "in_progress")).toBe("main");
    expect(pickRouteKind("backlog", "done")).toBe("main");
    expect(pickRouteKind("needs_qa", "done")).toBe("main");
  });

  it("is an arc for a backward move on the main channel — the river only flows one way", () => {
    expect(pickRouteKind("needs_qa", "todo")).toBe("arc");
    expect(pickRouteKind("done", "backlog")).toBe("arc");
  });

  it("is an arc whenever either end is off the main channel (the lagoon, deferred)", () => {
    expect(pickRouteKind("in_progress", "blocked")).toBe("arc");
    expect(pickRouteKind("blocked", "needs_qa")).toBe("arc");
    expect(pickRouteKind("needs_qa", "deferred")).toBe("arc");
    expect(pickRouteKind("needs_user_decision", "needs_user_action")).toBe("arc");
  });

  it("MAIN_ORDER is exactly the stations physically on the main channel, in flow order", () => {
    expect(MAIN_ORDER).toEqual([
      "backlog",
      "needs_refinement",
      "todo",
      "in_progress",
      "needs_qa",
      "done",
    ]);
  });
});

describe("computeAnimationDurationMs", () => {
  it("clamps a short hop to the 900ms floor", () => {
    expect(computeAnimationDurationMs(10)).toBe(900);
  });

  it("clamps a very long path to the 2000ms ceiling", () => {
    expect(computeAnimationDurationMs(100_000)).toBe(2000);
  });

  it("scales with path length in between the clamps", () => {
    const short = computeAnimationDurationMs(600);
    const long = computeAnimationDurationMs(900);
    expect(long).toBeGreaterThan(short);
    expect(short).toBeGreaterThanOrEqual(900);
    expect(long).toBeLessThanOrEqual(2000);
  });
});

describe("easeInOutCubic", () => {
  it("starts and ends exactly at 0 and 1", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
  });

  it("is exactly 0.5 at the midpoint (symmetric ease)", () => {
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10);
  });

  it("is monotonically increasing", () => {
    const samples = Array.from({ length: 11 }, (_, i) => easeInOutCubic(i / 10));
    for (let i = 1; i < samples.length; i += 1)
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]!);
  });

  it("eases in and out — slower than linear near both ends, faster in the middle", () => {
    expect(easeInOutCubic(0.1)).toBeLessThan(0.1);
    expect(easeInOutCubic(0.9)).toBeGreaterThan(0.9);
  });
});

describe("pathLength / sampleQuadratic / pointAtFraction", () => {
  it("pathLength sums a straight line correctly", () => {
    expect(
      pathLength([
        [0, 0],
        [3, 4],
      ]),
    ).toBe(5);
  });

  it("pathLength of a single point is 0", () => {
    expect(pathLength([[5, 5]])).toBe(0);
  });

  it("sampleQuadratic starts and ends exactly at the endpoints", () => {
    const points = sampleQuadratic([0, 0], [5, 10], [10, 0], 8);
    expect(points[0]).toEqual([0, 0]);
    expect(points[points.length - 1]).toEqual([10, 0]);
    expect(points).toHaveLength(9);
  });

  it("sampleQuadratic bows toward the control point at t=0.5", () => {
    const points = sampleQuadratic([0, 0], [5, 10], [10, 0], 2);
    // At t=0.5 the quadratic Bézier formula gives 0.25*p0 + 0.5*c + 0.25*p1.
    expect(points[1]).toEqual([5, 5]);
  });

  it("pointAtFraction returns the start/end at t=0/1", () => {
    const points: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
    ];
    expect(pointAtFraction(points, 0)).toEqual([0, 0]);
    expect(pointAtFraction(points, 1)).toEqual([10, 10]);
  });

  it("pointAtFraction interpolates proportionally to distance travelled, not sample index", () => {
    const points: [number, number][] = [
      [0, 0],
      [10, 0],
      [12, 0],
    ];
    // Total length 12; halfway (6) falls partway along the first (longer) segment.
    expect(pointAtFraction(points, 0.5)).toEqual([6, 0]);
  });

  it("pointAtFraction clamps out-of-range input", () => {
    const points: [number, number][] = [
      [0, 0],
      [10, 0],
    ];
    expect(pointAtFraction(points, -1)).toEqual([0, 0]);
    expect(pointAtFraction(points, 2)).toEqual([10, 0]);
  });
});

describe("sliceMainChannel", () => {
  const points: [number, number][] = [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
    [4, 0],
  ];
  const us = [0, 0.25, 0.5, 0.75, 1];

  it("slices forward between two u fractions in ascending order", () => {
    const slice = sliceMainChannel(points, us, 0.25, 0.75);
    expect(slice).toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
    ]);
  });

  it("reverses the slice when moving backward (fromU > toU)", () => {
    const slice = sliceMainChannel(points, us, 0.75, 0.25);
    expect(slice).toEqual([
      [3, 0],
      [2, 0],
      [1, 0],
    ]);
  });

  it("falls back to a straight two-point line when too few samples are in range", () => {
    const slice = sliceMainChannel(points, us, 0.5, 0.5);
    // Only one sample (u=0.5) falls in [0.48, 0.52] — not enough to draw a path.
    expect(slice).toEqual([points[0], points[points.length - 1]]);
  });
});

describe("diffMovedTasks", () => {
  it("reports a task whose status differs from what was previously rendered", () => {
    const prev = new Map([[1, "todo" as const]]);
    const moved = diffMovedTasks(prev, [{ id: 1, status: "in_progress" }]);
    expect(moved).toEqual([{ taskId: 1, from: "todo", to: "in_progress" }]);
  });

  it("ignores a task with no change", () => {
    const prev = new Map([[1, "todo" as const]]);
    expect(diffMovedTasks(prev, [{ id: 1, status: "todo" }])).toEqual([]);
  });

  it("ignores a task with no previous entry — first paint animates nothing", () => {
    expect(diffMovedTasks(new Map(), [{ id: 1, status: "todo" }])).toEqual([]);
  });

  it("reports every changed task in a batch", () => {
    const prev = new Map([
      [1, "todo" as const],
      [2, "backlog" as const],
      [3, "done" as const],
    ]);
    const moved = diffMovedTasks(prev, [
      { id: 1, status: "in_progress" },
      { id: 2, status: "backlog" },
      { id: 3, status: "deferred" },
    ]);
    expect(moved).toHaveLength(2);
    expect(moved.map((m) => m.taskId).sort()).toEqual([1, 3]);
  });
});
