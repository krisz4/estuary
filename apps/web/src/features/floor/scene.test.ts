import { type FloorTask, type TaskStatus } from "@estuary/contracts";
import { describe, expect, it } from "vitest";
import { buildMapLayout } from "@/features/floor/layout";
import {
  computeCanvasHeight,
  computeGeometry,
  drawFrame,
  hitKey,
  hitTest,
  placeBeads,
  placeCallout,
  placeHoverTip,
  placePlate,
  type CalloutRect,
  type FloorColors,
  type FloorHitTarget,
} from "@/features/floor/scene";

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
    const plate: CalloutRect = {
      x: 90,
      y: 90,
      w: 40,
      h: 20,
      text: "PLATE",
      anchorX: 110,
      anchorY: 100,
    };
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
      first.x < second.x + second.w &&
      first.x + first.w > second.x &&
      first.y < second.y + second.h &&
      first.y + first.h > second.y;
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
    const beadObstacle: CalloutRect = {
      x: 185,
      y: 175,
      w: 30,
      h: 30,
      text: "",
      anchorX: 200,
      anchorY: 190,
    };
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
    const gapX =
      second.x >= first.x + first.w
        ? second.x - (first.x + first.w)
        : first.x - (second.x + second.w);
    const gapY =
      second.y >= first.y + first.h
        ? second.y - (first.y + first.h)
        : first.y - (second.y + second.h);
    // The two rects are separated on at least one axis by >= the margin —
    // adjacent rects that only clear on one axis (the common case for a ring
    // search) still read as "not touching."
    const horizontallyClear = second.x >= first.x + first.w || first.x >= second.x + second.w;
    const verticallyClear = second.y >= first.y + first.h || first.y >= second.y + second.h;
    expect(horizontallyClear ? gapX : verticallyClear ? gapY : -1).toBeGreaterThanOrEqual(6);
  });

  it("with a preferred angle, puts the plate on that side, clear of its own pin", () => {
    const bounds = { W: 500, H: 400 };
    // To the right: a wide plate must not be centred `gap` from the pin (it
    // would sit on it) — its near edge is `gap` away instead.
    const right = placePlate(200, 200, 120, 34, 20, [], bounds, "NEEDS ACTION", 0);
    expect(right.x).toBeGreaterThanOrEqual(220);
    expect(right.y).toBeLessThan(200);
    expect(right.y + right.h).toBeGreaterThan(200);
    // Straight down.
    const below = placePlate(200, 200, 120, 34, 20, [], bounds, "NEEDS DECISION", Math.PI / 2);
    expect(below.y).toBeGreaterThanOrEqual(220);
  });

  it("falls back to the next-nearest direction when the preferred side is taken", () => {
    const bounds = { W: 500, H: 400 };
    const taken = placePlate(200, 200, 120, 34, 20, [], bounds, "A", 0);
    const next = placePlate(200, 200, 120, 34, 20, [taken], bounds, "B", 0);
    const overlaps =
      taken.x < next.x + next.w &&
      taken.x + taken.w > next.x &&
      taken.y < next.y + next.h &&
      taken.y + taken.h > next.y;
    expect(overlaps).toBe(false);
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

describe("hitTest", () => {
  // hitTest only reads geometry; the task is carried through untouched.
  const task = { id: 1 } as FloorTask;

  it("prefers a bead over the station pin it sits on", () => {
    // A lone bead is placed exactly on its station's pin — the pin is pushed
    // first and ties on distance, which used to swallow the bead's click.
    const hits: FloorHitTarget[] = [
      { kind: "station", station: "done", x: 100, y: 100, r: 10 },
      { kind: "bead", task, x: 100, y: 100, r: 6 },
    ];
    expect(hitTest(hits, 102, 101)?.kind).toBe("bead");
  });

  it("prefers a bead even when the station pin is nearer", () => {
    const hits: FloorHitTarget[] = [
      { kind: "station", station: "backlog", x: 100, y: 100, r: 10 },
      { kind: "bead", task, x: 108, y: 100, r: 6 },
    ];
    expect(hitTest(hits, 103, 100)?.kind).toBe("bead");
  });

  it("falls back to the station pin when no bead is in reach", () => {
    const hits: FloorHitTarget[] = [
      { kind: "station", station: "backlog", x: 100, y: 100, r: 10 },
      { kind: "bead", task, x: 160, y: 100, r: 6 },
    ];
    expect(hitTest(hits, 104, 100)).toMatchObject({ kind: "station", station: "backlog" });
  });

  it("hits a station's plate anywhere inside its box, far from the pin", () => {
    const hits: FloorHitTarget[] = [
      { kind: "station", station: "backlog", x: 100, y: 100, r: 10 },
      {
        kind: "station",
        station: "backlog",
        x: 100,
        y: 100,
        r: 0,
        box: { x: 70, y: 40, w: 60, h: 34 },
      },
    ];
    expect(hitTest(hits, 125, 45)).toMatchObject({ kind: "station", station: "backlog" });
    expect(hitTest(hits, 125, 90)).toBeUndefined();
  });

  it("opens the task from its callout box, keeping the bead's own anchor", () => {
    const hits: FloorHitTarget[] = [
      { kind: "bead", task, x: 100, y: 100, r: 6, box: { x: 150, y: 90, w: 180, h: 16 } },
    ];
    expect(hitTest(hits, 300, 98)).toMatchObject({ kind: "bead", task, x: 100, y: 100 });
  });
});

describe("hitTest — hover stickiness", () => {
  const a = { id: 1 } as FloorTask;
  const b = { id: 2 } as FloorTask;
  // Two beads whose slop circles overlap along x = 110.
  const hits: FloorHitTarget[] = [
    { kind: "bead", task: a, x: 100, y: 100, r: 6 },
    { kind: "bead", task: b, x: 120, y: 100, r: 6 },
  ];

  it("picks the nearer bead with nothing hovered", () => {
    expect(hitTest(hits, 112, 100)).toMatchObject({ task: b });
  });

  it("keeps the hovered bead while the pointer is still inside its area", () => {
    expect(hitTest(hits, 112, 100, hitKey(hits[0]!))).toMatchObject({ task: a });
  });

  it("lets go once the pointer leaves the hovered bead's area", () => {
    expect(hitTest(hits, 118, 100, hitKey(hits[0]!))).toMatchObject({ task: b });
  });

  it("never lets a sticky station hold back a bead", () => {
    const withStation: FloorHitTarget[] = [
      { kind: "station", station: "todo", x: 100, y: 100, r: 10 },
      { kind: "bead", task: a, x: 104, y: 100, r: 6 },
    ];
    expect(hitTest(withStation, 101, 100, "station:todo")).toMatchObject({ kind: "bead" });
  });
});

describe("placeHoverTip", () => {
  const tip = { w: 288, h: 140 };
  const bounds = { width: 1000, height: 600 };
  const covers = (
    pos: { left: number; top: number },
    box: { x: number; y: number; w: number; h: number },
  ) =>
    pos.left < box.x + box.w &&
    pos.left + tip.w > box.x &&
    pos.top < box.y + box.h &&
    pos.top + tip.h > box.y;

  it("sits to the right of the bead and its callout when there is room", () => {
    const avoid = { x: 100, y: 90, w: 200, h: 20 };
    const pos = placeHoverTip(avoid, 100, tip, bounds);
    expect(pos.left).toBeGreaterThanOrEqual(300);
    expect(covers(pos, avoid)).toBe(false);
  });

  it("flips to the left near the right edge", () => {
    const avoid = { x: 800, y: 300, w: 180, h: 20 };
    const pos = placeHoverTip(avoid, 310, tip, bounds);
    expect(pos.left + tip.w).toBeLessThanOrEqual(800);
    expect(covers(pos, avoid)).toBe(false);
  });

  it("goes below when neither side fits (a phone-width canvas)", () => {
    const avoid = { x: 60, y: 100, w: 240, h: 20 };
    const pos = placeHoverTip(avoid, 110, tip, { width: 340, height: 600 });
    expect(pos.top).toBeGreaterThanOrEqual(120);
    expect(pos.left).toBeGreaterThanOrEqual(8);
    expect(pos.left + tip.w).toBeLessThanOrEqual(340 - 8);
  });
});

describe("drawFrame — hover does not move hit targets", () => {
  // A 2D context that accepts every call and property write; only
  // `measureText` and gradients need a return value.
  const fakeCtx = (): CanvasRenderingContext2D =>
    new Proxy({} as Record<string | symbol, unknown>, {
      get: (target, prop) => {
        if (prop in target) return target[prop];
        if (prop === "measureText") return (text: string) => ({ width: text.length * 6 });
        if (prop === "createRadialGradient" || prop === "createLinearGradient")
          return () => ({ addColorStop: () => undefined });
        return () => undefined;
      },
      set: (target, prop, value) => {
        target[prop] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;

  const colors: FloorColors = {
    ground: "#e6e3db",
    ground2: "#ebe8e0",
    panel: "#f6f4ef",
    panel2: "#eeebe4",
    ink: "#1c2a32",
    inkMuted: "#4a5a62",
    inkFaint: "#838e8c",
    line: "#1c2a32",
    line2: "#1c2a32",
    contour: "#40483c",
    flat: "#ddd6c5",
    water: "#b7c7cc",
    waterEdge: "#8fa6ad",
    flow: "#ffffff",
    poolAttn: "#d99a2b",
    poolBlock: "#c8553d",
    ok: "#3f8f5a",
    dark: false,
    lanes: ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6"],
  };

  const task = (id: number, status: TaskStatus): FloorTask => ({
    id,
    reference: `TASK-${String(id).padStart(6, "0")}`,
    title: `A reasonably long task title number ${id}`,
    status,
    statusNote: null,
    priority: "medium",
    project: "estuary",
    assignee: null,
    labels: [],
    parentId: null,
    childCount: 0,
    createdBy: "human:krisz",
    claim: null,
    pullRequestUrl: null,
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    openBlockerCount: 0,
    unblocksCount: 0,
    matches: true,
  });

  it("returns the same callout boxes whichever bead is hovered", () => {
    // A crowded low-density map: every bead wants a callout, so the greedy
    // placement is full of collisions — the case where re-ranking the hovered
    // callout used to reshuffle its neighbours under the pointer.
    const tasks = [
      ...Array.from({ length: 12 }, (_, i) => task(i + 1, "todo")),
      ...Array.from({ length: 8 }, (_, i) => task(i + 20, "in_progress")),
    ];
    const layout = buildMapLayout({
      tasks,
      group: "project",
      match: "dim",
      hasActiveFilters: false,
      olderClosedCount: 0,
      edges: [],
      refs: [],
      maxPerCluster: 30,
    });
    const geometry = computeGeometry(1000, 580);
    const placement = placeBeads(layout, geometry, 1, 1);
    const frame = (hoveredTaskId: number | null) =>
      drawFrame({
        ctx: fakeCtx(),
        staticLayer: {} as HTMLCanvasElement,
        layout,
        geometry,
        placement,
        colors,
        projectOrder: ["estuary"],
        groupMode: "project",
        hoveredTaskId,
        selectedTaskId: null,
        keyboardTaskId: null,
        sectorLabelStation: null,
        links: "blocking",
        now: Date.parse("2026-01-02T00:00:00.000Z"),
        clockDate: new Date("2026-01-02T12:00:00.000Z"),
        time: 0,
        dpr: 1,
        showAllCallouts: true,
        isLive: true,
      })
        .filter((hit) => hit.box !== undefined && hit.kind === "bead")
        .map((hit) => `${hitKey(hit)}@${hit.box!.x},${hit.box!.y}`);

    const resting = frame(null);
    expect(resting.length).toBeGreaterThan(0);
    for (const t of tasks) expect(frame(t.id)).toEqual(resting);
  });
});
