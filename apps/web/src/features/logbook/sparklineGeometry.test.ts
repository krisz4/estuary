import { describe, expect, it } from "vitest";
import { buildSparklineGeometry } from "@/features/logbook/sparklineGeometry";

describe("buildSparklineGeometry", () => {
  it("reports not-enough-data below the minimum point count", () => {
    expect(buildSparklineGeometry([])).toEqual({ hasEnoughData: false });
    expect(buildSparklineGeometry([0.5])).toEqual({ hasEnoughData: false });
    expect(buildSparklineGeometry([0.5, null, 0.2])).toEqual({ hasEnoughData: false });
  });

  it("places one dot per available point and ignores gaps", () => {
    const geometry = buildSparklineGeometry([0, null, 0.5, 1]);
    expect(geometry.hasEnoughData).toBe(true);
    if (!geometry.hasEnoughData) throw new Error("unreachable");
    expect(geometry.dots.map((dot) => dot.index)).toEqual([0, 2, 3]);
  });

  it("marks a segment dashed only when it bridges a gap", () => {
    const geometry = buildSparklineGeometry([0, 0.5, null, 1]);
    expect(geometry.hasEnoughData).toBe(true);
    if (!geometry.hasEnoughData) throw new Error("unreachable");
    // 0→1 (adjacent, solid), 1→3 (bridges the null at 2, dashed).
    expect(geometry.segments).toHaveLength(2);
    expect(geometry.segments[0]!.dashed).toBe(false);
    expect(geometry.segments[1]!.dashed).toBe(true);
  });

  it("produces no dashed segments when every point is present", () => {
    const geometry = buildSparklineGeometry([0, 0.3, 0.6, 1]);
    expect(geometry.hasEnoughData).toBe(true);
    if (!geometry.hasEnoughData) throw new Error("unreachable");
    expect(geometry.segments.every((segment) => !segment.dashed)).toBe(true);
    expect(geometry.segments).toHaveLength(3);
  });

  it("maps values to y using the full plot height, inverted (1 is at the top)", () => {
    const geometry = buildSparklineGeometry([0, 1, 0.5], { width: 100, height: 20, pad: 0 });
    expect(geometry.hasEnoughData).toBe(true);
    if (!geometry.hasEnoughData) throw new Error("unreachable");
    expect(geometry.dots[0]!.y).toBe(20); // value 0 → bottom
    expect(geometry.dots[1]!.y).toBe(0); // value 1 → top
    expect(geometry.dots[2]!.y).toBe(10); // value 0.5 → middle
  });
});
