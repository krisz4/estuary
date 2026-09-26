import type { TaskStatus } from "@helpdesk/contracts";

/**
 * Bead travel — phase 4's "signature interaction." Pure geometry/timing
 * pieces, kept out of `scene.ts`'s already-large `drawFrame` and out of
 * `FloorCanvas.tsx`'s imperative animation-state wiring, so the parts worth
 * unit-testing (which route a move takes, how long it runs, which tasks
 * moved at all) don't require a canvas to verify.
 */

/** Stations that sit on the river's main channel, in flow order — everything else (the lagoon's three, `deferred`'s creek) is off it. */
export const MAIN_ORDER: readonly TaskStatus[] = [
  "backlog",
  "needs_refinement",
  "todo",
  "in_progress",
  "needs_qa",
  "done",
];

export type RouteKind = "main" | "arc";

/**
 * "Follow the main channel downstream when moving forward on `MAIN_ORDER`,
 * otherwise a quadratic hop arc." A backward move on the main channel (an
 * agent sent back from `needs_qa` to `todo`) is still an `arc` — the river
 * only flows one way, and animating "upstream" along it would look wrong.
 */
export const pickRouteKind = (from: TaskStatus, to: TaskStatus): RouteKind => {
  const fromIndex = MAIN_ORDER.indexOf(from);
  const toIndex = MAIN_ORDER.indexOf(to);
  if (fromIndex === -1 || toIndex === -1) return "arc";
  return toIndex > fromIndex ? "main" : "arc";
};

const MIN_DURATION_MS = 900;
const MAX_DURATION_MS = 2000;
/** Roughly how fast a bead travels before the clamp band takes over — tuned so a typical station-to-station hop lands near the middle of the band. */
const SPEED_PX_PER_MS = 0.5;

/** Duration from path length, clamped to 900–2000ms — a short hop isn't instant, a long one doesn't take forever. */
export const computeAnimationDurationMs = (pathLengthPx: number): number =>
  Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, pathLengthPx / SPEED_PX_PER_MS));

/** Standard ease-in-out cubic. */
export const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// Mutable, matching `scene.ts`'s own `Pt`/`SceneGeometry` tuple shape — a
// `readonly` tuple here would fight every call site that hands one to
// `computeGeometry`'s `P`/`uOf`, which predate this module and aren't
// `readonly` themselves.
export type Point = [number, number];

export const pathLength = (points: readonly Point[]): number => {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  }
  return total;
};

/** A quadratic Bézier, sampled into `steps + 1` points — the "hop arc" for anything not a forward main-channel move. */
export const sampleQuadratic = (p0: Point, control: Point, p1: Point, steps: number): Point[] => {
  const points: Point[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const mt = 1 - t;
    const x = mt * mt * p0[0] + 2 * mt * t * control[0] + t * t * p1[0];
    const y = mt * mt * p0[1] + 2 * mt * t * control[1] + t * t * p1[1];
    points.push([x, y]);
  }
  return points;
};

/**
 * The sub-polyline of the main channel's own sampled points between two
 * `u` fractions (`SceneGeometry.uOf`'s output for each station's pixel
 * position) — "follow the main channel downstream." Falls back to a
 * straight two-point line when the channel doesn't actually cover the
 * range (a station's `u` outside the channel's own span, or too few points
 * survive the filter to draw a path at all) rather than throwing.
 */
export const sliceMainChannel = (mainPoints: readonly Point[], us: readonly number[], fromU: number, toU: number): Point[] => {
  const lo = Math.min(fromU, toU) - 0.02;
  const hi = Math.max(fromU, toU) + 0.02;
  const indices: number[] = [];
  us.forEach((u, i) => {
    if (u >= lo && u <= hi) indices.push(i);
  });
  if (indices.length < 2) {
    const first = mainPoints[0];
    const last = mainPoints[mainPoints.length - 1];
    return first === undefined || last === undefined ? [] : [first, last];
  }
  const slice = indices.map((i) => mainPoints[i]!);
  return fromU <= toU ? slice : [...slice].reverse();
};

/** A point at fraction `t` (0–1) along a polyline, interpolating within the enclosing segment — not just "the nearest sample." */
export const pointAtFraction = (points: readonly Point[], t: number): Point => {
  if (points.length === 0) return [0, 0];
  if (points.length === 1) return points[0]!;
  const clamped = Math.max(0, Math.min(1, t));
  const target = pathLength(points) * clamped;
  let covered = 0;
  for (let i = 1; i < points.length; i += 1) {
    const segment = Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
    if (covered + segment >= target || i === points.length - 1) {
      const segT = segment === 0 ? 0 : (target - covered) / segment;
      const x = points[i - 1]![0] + (points[i]![0] - points[i - 1]![0]) * segT;
      const y = points[i - 1]![1] + (points[i]![1] - points[i - 1]![1]) * segT;
      return [x, y];
    }
    covered += segment;
  }
  return points[points.length - 1]!;
};

export type MovedTask = { taskId: number; from: TaskStatus; to: TaskStatus };

/**
 * Diffs the previously-rendered status per task against the current bead
 * set — this is what makes bead travel work for **any** source of a status
 * change (live polling, drag-drop, a rail quick action, the drawer), not
 * just `planLiveAnimations`' event feed: the canvas doesn't need to know
 * *why* a task moved, only that its status differs from what it last drew.
 * A task missing from `prevStatus` (first paint, or a task that just
 * entered scope) never animates — there is no "previous position" to
 * travel from.
 */
export const diffMovedTasks = (
  prevStatus: ReadonlyMap<number, TaskStatus>,
  current: readonly { id: number; status: TaskStatus }[],
): MovedTask[] => {
  const moved: MovedTask[] = [];
  for (const task of current) {
    const prev = prevStatus.get(task.id);
    if (prev !== undefined && prev !== task.status) moved.push({ taskId: task.id, from: prev, to: task.status });
  }
  return moved;
};

/** More than this many simultaneous moves reads as "a lot happened," not motion — snap instead of animating all of them (same threshold `liveMotion.ts` uses for the same reason). */
export const ROUTE_SNAP_THRESHOLD = 20;
