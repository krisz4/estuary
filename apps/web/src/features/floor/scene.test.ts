import { describe, expect, it } from "vitest";
import { computeCanvasHeight, placeCallout, placePlate, type CalloutRect } from "@/features/floor/scene";

const overlaps = (a: CalloutRect, b: CalloutRect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

describe("placeCallout", () => {
  it("places a single callout near its anchor when nothing else is on the canvas", () => {
    const rect = placeCallout(100, 100, "#1 Title", 60, 16, [], { W: 400, H: 300 });
    expect(rect).not.toBeNull();
  });

  it("avoids every rect already placed, never overlapping", () => {
    const bounds = { W: 500, H: 400 };
    const first = placeCallout(200, 200, "#1", 80, 16, [], bounds);
    expect(first).not.toBeNull();
    const second = placeCallout(202, 201, "#2", 80, 16, [first as CalloutRect], bounds);
    expect(second).not.toBeNull();
    expect(overlaps(first as CalloutRect, second as CalloutRect)).toBe(false);
  });

  it("returns null rather than an overlapping rect when the canvas is too small for another one", () => {
    // A canvas barely bigger than the callout itself: the very first callout
    // fills nearly the whole area, leaving no collision-free spot for a second
    // one anchored at the same point.
    const bounds = { W: 60, H: 40 };
    const first = placeCallout(30, 20, "#1", 56, 34, [], bounds);
    expect(first).not.toBeNull();
    const second = placeCallout(30, 20, "#2", 56, 34, [first as CalloutRect], bounds);
    expect(second).toBeNull();
  });

  it("avoids rects passed in that were not produced by a prior call (e.g. station plates)", () => {
    const plate: CalloutRect = { x: 90, y: 90, w: 40, h: 20, text: "PLATE", anchorX: 110, anchorY: 100 };
    const rect = placeCallout(100, 100, "#1", 60, 16, [plate], { W: 400, H: 300 });
    expect(rect).not.toBeNull();
    expect(overlaps(plate, rect as CalloutRect)).toBe(false);
  });

  it("no two placements intersect across a scattered cluster of anchors", () => {
    const bounds = { W: 600, H: 500 };
    const anchors: [number, number][] = [];
    // A tight cluster (a crowded pool) — anchors within ~40px of one another,
    // the exact case the visual-QA overlap report described.
    for (let i = 0; i < 12; i += 1) {
      anchors.push([300 + ((i * 37) % 80) - 40, 250 + ((i * 53) % 60) - 30]);
    }

    const placed: CalloutRect[] = [];
    for (const [ax, ay] of anchors) {
      const rect = placeCallout(ax, ay, `#${ax}-${ay}`, 90, 16, placed, bounds);
      if (rect !== null) placed.push(rect);
    }

    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        expect(overlaps(placed[i]!, placed[j]!)).toBe(false);
      }
    }
    // Most of a moderately dense cluster should still find room.
    expect(placed.length).toBeGreaterThan(anchors.length / 2);
  });
});

describe("placePlate", () => {
  it("places a plate above its pin when nothing else is there", () => {
    const rect = placePlate(200, 200, 60, 34, 20, [], { W: 500, H: 400 }, "TODO");
    expect(rect.y).toBeLessThan(200);
  });

  it("moves the second plate clear of the first rather than stacking on it", () => {
    const bounds = { W: 500, H: 400 };
    const first = placePlate(200, 200, 60, 34, 20, [], bounds, "BLOCKED");
    const second = placePlate(210, 205, 70, 34, 20, [first], bounds, "NEEDS USER DECISION");
    const overlaps =
      first.x < second.x + second.w && first.x + first.w > second.x && first.y < second.y + second.h && first.y + first.h > second.y;
    expect(overlaps).toBe(false);
  });

  it("never returns null — a still-overlapping fallback beats no plate at all", () => {
    // A canvas far too small for two non-overlapping plates near the same pin.
    const bounds = { W: 90, H: 70 };
    const first = placePlate(45, 35, 60, 34, 5, [], bounds, "A");
    const second = placePlate(46, 36, 60, 34, 5, [first], bounds, "B");
    expect(second).toBeTruthy();
  });

  it("avoids bead-obstacle rects passed in alongside plates", () => {
    const beadObstacle: CalloutRect = { x: 185, y: 175, w: 30, h: 30, text: "", anchorX: 200, anchorY: 190 };
    const rect = placePlate(200, 200, 60, 34, 20, [beadObstacle], { W: 500, H: 400 }, "BLOCKED");
    const overlaps =
      rect.x < beadObstacle.x + beadObstacle.w &&
      rect.x + rect.w > beadObstacle.x &&
      rect.y < beadObstacle.y + beadObstacle.h &&
      rect.y + rect.h > beadObstacle.y;
    expect(overlaps).toBe(false);
  });

  it("keeps at least a 6px gap between two plates, not just non-overlap", () => {
    const bounds = { W: 500, H: 400 };
    const first = placePlate(200, 200, 60, 34, 20, [], bounds, "NEEDS USER ACTION");
    const second = placePlate(205, 205, 60, 34, 20, [first], bounds, "NEEDS QA");
    const gapX = second.x >= first.x + first.w ? second.x - (first.x + first.w) : first.x - (second.x + second.w);
    const gapY = second.y >= first.y + first.h ? second.y - (first.y + first.h) : first.y - (second.y + second.h);
    // The two rects are separated on at least one axis by >= the margin —
    // adjacent rects that only clear on one axis (the common case for a ring
    // search) still read as "not touching."
    const horizontallyClear = second.x >= first.x + first.w || first.x >= second.x + second.w;
    const verticallyClear = second.y >= first.y + first.h || first.y >= second.y + second.h;
    expect(horizontallyClear ? gapX : verticallyClear ? gapY : -1).toBeGreaterThanOrEqual(6);
  });
});

describe("computeCanvasHeight", () => {
  it("vertical mode (`horiz=false`) is ~2.1x width, capped at 900px, ignoring availableHeight", () => {
    expect(computeCanvasHeight(390, false)).toBe(819);
    expect(computeCanvasHeight(390, false, 300)).toBe(819);
    expect(computeCanvasHeight(500, false)).toBe(900);
  });

  it("horizontal mode uses the measured available height when given, clamped to a sane aspect band", () => {
    expect(computeCanvasHeight(1200, true, 700)).toBe(700);
    expect(computeCanvasHeight(1200, true, 50)).toBeGreaterThan(50);
    expect(computeCanvasHeight(1200, true)).toBe(580);
  });
});
