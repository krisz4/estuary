import { type FloorEdge, type FloorTask, type TaskPriority, type TaskStatus } from "@helpdesk/contracts";
import { colorWithAlpha } from "@/features/floor/colorAlpha";
import {
  POOL_STATIONS,
  beadColorIndex,
  beadRadius,
  type MapBead,
  type MapCluster,
  type MapGhostBead,
  type MapLayout,
} from "@/features/floor/layout";
import { type FloorLinksMode } from "@/pages/tasks-map/useFloorParams";

/**
 * The Estuary renderer — replaces the Foundry-era belts×stations canvas
 * entirely (see `docs/pages/Tasks_Floor.md` for the design-change history).
 * One river (the flow), ten stations along it, beads clustered at each one.
 *
 * Ported faithfully from the prototype: the Catmull-Rom river spline, the
 * marching-squares contour terrain with tidal flats and sand stipple, station
 * plates, dependency arcs as quadratic "chains" with an arrowhead and an
 * `#a blocks #z` label, day/night lighting keyed to a clock, and boats/flags
 * for live claims.
 *
 * **Scope note** — not ported, and why: the prototype *simulates* agent work
 * locally (a fake clock, synthetic status-at-time, bead-travel animation with
 * splashes). This app has no event stream driving that yet (phase 4's "Live
 * and hands-on"), and replay (`?at=`) is a **real** `GET /floor?at=` refetch,
 * not a client-side simulation — so there is no `statusAt`/`claimAt`
 * bookkeeping to port at all. Beads render at their resting position; a later
 * `route()` animation (bead travel between stations) can be layered on top of
 * `drawFrame` without changing the geometry functions here. Boat flags show
 * `agent · #id` rather than the prototype's live step/percentage, because
 * `TaskClaim` on the wire carries only `{ actor, expiresAt }` — no progress or
 * step text, and no heartbeat timestamp, so "stale" is approximated from
 * `expiresAt` (see `isClaimExpiringSoon`) rather than a real heartbeat age.
 */

/* ------------------------------------------------------------------ *
 * Geometry: the river spline and the ten stations along it
 * ------------------------------------------------------------------ */

type Pt = [number, number];

const MAIN: Pt[] = [
  [-0.05, 0.36], [0.05, 0.34], [0.16, 0.37], [0.27, 0.33], [0.4, 0.35],
  [0.53, 0.39], [0.66, 0.35], [0.79, 0.37], [0.91, 0.36], [1.07, 0.38],
];
const LOOP: Pt[] = [
  [0.4, 0.35], [0.41, 0.55], [0.45, 0.72], [0.54, 0.8], [0.63, 0.72], [0.67, 0.55], [0.68, 0.36],
];
const CREEK: Pt[] = [[0.79, 0.37], [0.82, 0.24], [0.855, 0.12]];

export const STATION: Record<TaskStatus, Pt> = {
  backlog: [0.05, 0.34],
  needs_refinement: [0.16, 0.37],
  todo: [0.27, 0.33],
  in_progress: [0.4, 0.35],
  needs_qa: [0.68, 0.355],
  done: [0.93, 0.365],
  deferred: [0.855, 0.12],
  blocked: [0.45, 0.72],
  needs_user_decision: [0.54, 0.8],
  needs_user_action: [0.63, 0.72],
};

export const REGIONS: readonly [string, string, number, number][] = [
  ["PLAN", "headwaters", 0.16, 0.13],
  ["DOING", "the reach", 0.54, 0.13],
  ["WAITING", "the lagoon", 0.54, 0.57],
  ["CLOSED", "the mouth", 0.94, 0.66],
];

const catmull = (pts: Pt[], per: number): Pt[] => {
  const out: Pt[] = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    for (let s = 0; s < per; s += 1) {
      const t = s / per;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([0, 1].map((k) =>
        0.5 *
        (2 * p1[k]! +
          (-p0[k]! + p2[k]!) * t +
          (2 * p0[k]! - 5 * p1[k]! + 4 * p2[k]! - p3[k]!) * t2 +
          (-p0[k]! + 3 * p1[k]! - 3 * p2[k]! + p3[k]!) * t3),
      ) as Pt);
    }
  }
  out.push(pts[pts.length - 1]!);
  return out;
};

const MAIN_N = catmull(MAIN, 24);
const LOOP_N = catmull(LOOP, 20);
const CREEK_N = catmull(CREEK, 16);

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

export type SceneGeometry = {
  W: number;
  H: number;
  horiz: boolean;
  padX: number;
  padY: number;
  BS: number;
  P: (p: Pt) => [number, number];
  uOf: (p: [number, number]) => number;
  mainPx: [number, number][];
  loopPx: [number, number][];
  creekPx: [number, number][];
  mainLen: number[];
  hwMain: (u: number) => number;
};

const hwMain = (u: number, BS: number): number =>
  BS * (6 + 9 * Math.max(0, u) + Math.pow(Math.max(0, u - 0.8), 1.5) * 330);

const cumLen = (poly: [number, number][]): number[] => {
  const l = [0];
  for (let i = 1; i < poly.length; i += 1) {
    l.push(l[i - 1]! + Math.hypot(poly[i]![0] - poly[i - 1]![0], poly[i]![1] - poly[i - 1]![1]));
  }
  return l;
};

/**
 * The canvas's own height. In the landing page's hero, the map card's
 * *available* height is a real layout constraint (the hero fills the
 * viewport minus the header) — `availableHeight` is that measured pixel
 * value, from a `ResizeObserver` on a flex cell whose size the canvas's own
 * content never feeds back into (the observed element has no intrinsic size
 * of its own to feed back: see `FloorCanvas`'s absolutely-positioned
 * `<canvas>`). Without one (narrower layouts, or before the first
 * measurement), falls back to the old width-derived formula.
 *
 * Either way the result is clamped to a sane aspect-ratio band relative to
 * `width` — the river's control points are normalized (`P()` maps `[0,1]²`
 * independently in each axis), so any aspect ratio in that band still reads
 * as a river, but a pathologically short or tall pane would not.
 */
export const computeCanvasHeight = (width: number, horiz: boolean, availableHeight?: number): number => {
  // Vertical mode ignores `availableHeight` on purpose: the canvas's own
  // `aspect-[1/2.1]` CSS (`Hero.tsx`) derives its *rendered* height from this
  // same width, so keeping this formula purely width-driven keeps the two in
  // sync — accepting a measured container height here (which would itself
  // depend on this formula, through the aspect-ratio CSS) invites exactly
  // the feedback loop `computeCanvasHeight`'s own docs warn against.
  if (!horiz) return Math.round(clamp(width * 2.1, 500, 900));
  if (availableHeight === undefined || availableHeight <= 0) return Math.round(clamp(width * 0.58, 410, 580));
  const minH = clamp(width * 0.32, 320, 480);
  const maxH = clamp(width * 1.15, 480, 1100);
  return Math.round(clamp(availableHeight, minH, maxH));
};

export const computeGeometry = (width: number, availableHeight?: number): SceneGeometry => {
  const horiz = width >= 600;
  const H = computeCanvasHeight(width, horiz, availableHeight);
  const padX = horiz ? 36 : 26;
  const padY = horiz ? 40 : 64;
  const BS = horiz ? clamp(width / 880, 0.95, 1.4) : 0.95;

  const P = (p: Pt): [number, number] =>
    horiz
      ? [padX + p[0] * (width - 2 * padX), padY + p[1] * (H - 2 * padY)]
      : [padX + p[1] * (width - 2 * padX), padY + p[0] * (H - 2 * padY)];
  const uOf = (p: [number, number]): number =>
    horiz ? (p[0] - padX) / (width - 2 * padX) : (p[1] - padY) / (H - 2 * padY);

  const mainPx = MAIN_N.map(P);
  const loopPx = LOOP_N.map(P);
  const creekPx = CREEK_N.map(P);

  return {
    W: width,
    H,
    horiz,
    padX,
    padY,
    BS,
    P,
    uOf,
    mainPx,
    loopPx,
    creekPx,
    mainLen: cumLen(mainPx),
    hwMain: (u: number) => hwMain(u, BS),
  };
};

const normals = (poly: [number, number][]): [number, number][] =>
  poly.map((_p, i) => {
    const a = poly[Math.max(0, i - 1)]!;
    const b = poly[Math.min(poly.length - 1, i + 1)]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l];
  });

const offsetPoly = (poly: [number, number][], d: number): [number, number][] => {
  const n = normals(poly);
  return poly.map((p, i) => [p[0] + n[i]![0] * d, p[1] + n[i]![1] * d]);
};

const nearestIdx = (poly: [number, number][], pt: [number, number]): number => {
  let bi = 0;
  let bd = Number.POSITIVE_INFINITY;
  for (let i = 0; i < poly.length; i += 1) {
    const q = poly[i]!;
    const d = (q[0] - pt[0]) ** 2 + (q[1] - pt[1]) ** 2;
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  return bi;
};

/* ------------------------------------------------------------------ *
 * Colours
 * ------------------------------------------------------------------ */

export type FloorColors = {
  ground: string;
  ground2: string;
  panel: string;
  panel2: string;
  ink: string;
  inkMuted: string;
  inkFaint: string;
  line: string;
  line2: string;
  contour: string;
  flat: string;
  water: string;
  waterEdge: string;
  flow: string;
  poolAttn: string;
  poolBlock: string;
  ok: string;
  dark: boolean;
  lanes: string[];
};

const readVar = (styles: CSSStyleDeclaration, name: string, fallback: string): string =>
  styles.getPropertyValue(name).trim() || fallback;

export const readFloorColors = (root: HTMLElement = document.documentElement): FloorColors => {
  const styles = getComputedStyle(root);
  const dark = root.classList.contains("dark");
  return {
    ground: readVar(styles, "--map-ground", "#e6e3db"),
    ground2: readVar(styles, "--map-ground-2", "#ebe8e0"),
    panel: readVar(styles, "--map-panel", "#f6f4ef"),
    panel2: readVar(styles, "--map-panel-2", "#eeebe4"),
    ink: readVar(styles, "--foreground", "#1c2a32"),
    inkMuted: readVar(styles, "--muted-foreground", "#4a5a62"),
    inkFaint: readVar(styles, "--map-ink-3", "#838e8c"),
    line: readVar(styles, "--map-line", "rgba(28,42,50,.12)"),
    line2: readVar(styles, "--map-line-2", "rgba(28,42,50,.24)"),
    contour: readVar(styles, "--map-contour", "rgba(64,72,60,.09)"),
    flat: readVar(styles, "--map-flat", "#ddd6c5"),
    water: readVar(styles, "--map-water", "#b7c7cc"),
    waterEdge: readVar(styles, "--map-water-edge", "#8aa0a7"),
    flow: readVar(styles, "--map-flow", "rgba(28,42,50,.3)"),
    poolAttn: readVar(styles, "--map-pool-attn", "#c0710f"),
    poolBlock: readVar(styles, "--map-pool-block", "#a8434f"),
    ok: readVar(styles, "--map-ok", "#2d7b69"),
    dark,
    lanes: Array.from({ length: 8 }, (_, i) => readVar(styles, `--map-lane-${i + 1}`, "#5266a6")),
  };
};

const NEUTRAL_LANE_LIGHT = "#8a9296";
const NEUTRAL_LANE_DARK = "#6b7378";

export const laneColor = (colorIndex: number | null, colors: FloorColors): string => {
  if (colorIndex === null) return colors.dark ? NEUTRAL_LANE_DARK : NEUTRAL_LANE_LIGHT;
  return colors.lanes[colorIndex % colors.lanes.length] ?? colors.lanes[0] ?? "#5266a6";
};

/* ------------------------------------------------------------------ *
 * Noise (for the marching-squares terrain) and small drawing helpers
 * ------------------------------------------------------------------ */

const rng = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const makeNoise = (seed: number): ((x: number, y: number) => number) => {
  const r = rng(seed);
  const G = 64;
  const g = new Float32Array(G * G).map(() => r());
  const at = (i: number, j: number): number => g[(((j % G) + G) % G) * G + (((i % G) + G) % G)]!;
  const sm = (t: number): number => t * t * (3 - 2 * t);
  return (x: number, y: number): number => {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = sm(x - i);
    const fy = sm(y - j);
    const a = at(i, j);
    const b = at(i + 1, j);
    const c = at(i, j + 1);
    const d = at(i + 1, j + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
};
const noise = makeNoise(20260925);

const bandPath = (
  ctx: CanvasRenderingContext2D,
  poly_: [number, number][],
  hw: number | ((u: number) => number),
  uOf: (p: [number, number]) => number,
): void => {
  const n = normals(poly_);
  const L: [number, number][] = [];
  const R: [number, number][] = [];
  poly_.forEach((p, i) => {
    const w = typeof hw === "function" ? hw(uOf(p)) : hw;
    L.push([p[0] + n[i]![0] * w, p[1] + n[i]![1] * w]);
    R.push([p[0] - n[i]![0] * w, p[1] - n[i]![1] * w]);
  });
  ctx.beginPath();
  L.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  for (let i = R.length - 1; i >= 0; i -= 1) ctx.lineTo(R[i]![0], R[i]![1]);
  ctx.closePath();
};

const rr = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void => {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
};

/* ------------------------------------------------------------------ *
 * Static layer: contours, tidal flats, stipple, sea, water, frame, regions
 * ------------------------------------------------------------------ */

export const buildStaticLayer = (geometry: SceneGeometry, colors: FloorColors): HTMLCanvasElement => {
  const { W, H, P, uOf, mainPx, loopPx, creekPx, BS, horiz } = geometry;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(W));
  canvas.height = Math.max(1, Math.round(H));
  const g = canvas.getContext("2d");
  if (g === null) return canvas;

  g.fillStyle = colors.ground2;
  g.fillRect(0, 0, W, H);

  // Marching-squares contour lines, driven by distance-to-river + Perlin noise.
  const cell = 8;
  const cols = Math.ceil(W / cell) + 1;
  const rows = Math.ceil(H / cell) + 1;
  const river = [...mainPx, ...loopPx, ...creekPx].filter((_, i) => i % 2 === 0);
  const f = new Float32Array(cols * rows);
  let mn = Number.POSITIVE_INFINITY;
  let mx = Number.NEGATIVE_INFINITY;
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const x = i * cell;
      const y = j * cell;
      let d = Number.POSITIVE_INFINITY;
      for (const q of river) {
        const dd = (q[0] - x) ** 2 + (q[1] - y) ** 2;
        if (dd < d) d = dd;
      }
      d = Math.sqrt(d);
      const n =
        noise(x / 180, y / 180) * 0.55 + noise(x / 70 + 11, y / 70 + 7) * 0.3 + noise(x / 30 + 3, y / 30 + 5) * 0.07;
      const e = n * 0.6 + (1 - Math.exp(-d / 140)) * 0.85;
      f[j * cols + i] = e;
      if (e < mn) mn = e;
      if (e > mx) mx = e;
    }
  }
  const levels = 15;
  const T = 8;
  const R = 4;
  const B = 2;
  const Lft = 1;
  const CASES: Record<number, [number, number][]> = {
    1: [[Lft, B]], 2: [[B, R]], 3: [[Lft, R]], 4: [[T, R]], 5: [[T, R], [Lft, B]], 6: [[T, B]],
    7: [[T, Lft]], 8: [[T, Lft]], 9: [[T, B]], 10: [[T, Lft], [B, R]], 11: [[T, R]], 12: [[Lft, R]],
    13: [[B, R]], 14: [[Lft, B]],
  };
  for (let k = 1; k < levels; k += 1) {
    const lv = mn + ((mx - mn) * k) / levels;
    g.beginPath();
    for (let j = 0; j < rows - 1; j += 1) {
      for (let i = 0; i < cols - 1; i += 1) {
        const v0 = f[j * cols + i]!;
        const v1 = f[j * cols + i + 1]!;
        const v2 = f[(j + 1) * cols + i + 1]!;
        const v3 = f[(j + 1) * cols + i]!;
        const idx = ((v0 > lv ? 1 : 0) << 3) | ((v1 > lv ? 1 : 0) << 2) | ((v2 > lv ? 1 : 0) << 1) | (v3 > lv ? 1 : 0);
        const segs = CASES[idx];
        if (segs === undefined) continue;
        const pt = (e: number): [number, number] => {
          if (e === T) return [(i + (lv - v0) / (v1 - v0)) * cell, j * cell];
          if (e === R) return [(i + 1) * cell, (j + (lv - v1) / (v2 - v1)) * cell];
          if (e === B) return [(i + (lv - v3) / (v2 - v3)) * cell, (j + 1) * cell];
          return [i * cell, (j + (lv - v0) / (v3 - v0)) * cell];
        };
        for (const [a, b] of segs) {
          const p = pt(a);
          const q = pt(b);
          g.moveTo(p[0], p[1]);
          g.lineTo(q[0], q[1]);
        }
      }
    }
    g.strokeStyle = colors.contour;
    g.lineWidth = k % 5 === 0 ? 1.6 : 1;
    g.stroke();
  }

  g.save();
  g.beginPath();
  g.rect(15, 15, W - 30, H - 30);
  g.clip();

  g.fillStyle = colorWithAlpha(colors.flat, 0.85);
  bandPath(g, mainPx, (u) => geometry.hwMain(u) * 1.9 + 12 * BS, uOf);
  g.fill();
  bandPath(g, loopPx, 20 * BS, uOf);
  g.fill();
  bandPath(g, creekPx, 11 * BS, uOf);
  g.fill();

  const stippleRng = rng(7);
  g.fillStyle = colors.contour;
  for (let i = 0; i < 900; i += 1) {
    const p_ = i % 5 === 0 ? loopPx : mainPx;
    const k = Math.floor(stippleRng() * p_.length);
    const p = p_[k]!;
    const n = normals([p_[Math.max(0, k - 1)]!, p, p_[Math.min(p_.length - 1, k + 1)]!])[1]!;
    const w = p_ === mainPx ? geometry.hwMain(uOf(p)) : 9 * BS;
    const d = (w + 2 + stippleRng() * (w * 0.9 + 12 * BS)) * (stippleRng() < 0.5 ? -1 : 1);
    g.globalAlpha = 0.5 + stippleRng() * 0.8;
    g.fillRect(p[0] + n[0] * d, p[1] + n[1] * d, 1.3, 1.3);
  }
  g.globalAlpha = 1;

  const sea = P([1.08, 0.37]);
  const sr = horiz ? 0.2 * W : 0.2 * H;
  const sg = g.createRadialGradient(sea[0], sea[1], 0, sea[0], sea[1], sr);
  sg.addColorStop(0, colorWithAlpha(colors.water, 1));
  sg.addColorStop(0.55, colorWithAlpha(colors.water, 0.55));
  sg.addColorStop(1, colorWithAlpha(colors.water, 0));
  g.fillStyle = sg;
  g.fillRect(0, 0, W, H);

  const water = (p_: [number, number][], hw: number | ((u: number) => number)): void => {
    bandPath(g, p_, hw, uOf);
    g.fillStyle = colors.water;
    g.fill();
    g.strokeStyle = colors.waterEdge;
    g.lineWidth = 1.2;
    g.stroke();
  };
  water(creekPx, 4.5 * BS);
  water(loopPx, 9 * BS);
  water(mainPx, geometry.hwMain);
  g.restore();

  g.strokeStyle = colors.line2;
  g.lineWidth = 1;
  g.strokeRect(10.5, 10.5, W - 21, H - 21);
  g.strokeStyle = colors.line;
  g.strokeRect(14.5, 14.5, W - 29, H - 29);
  g.beginPath();
  for (let x = 30; x < W - 20; x += 40) {
    g.moveTo(x + 0.5, 10);
    g.lineTo(x + 0.5, x % 200 < 40 ? 20 : 15);
    g.moveTo(x + 0.5, H - 10);
    g.lineTo(x + 0.5, H - 15);
  }
  for (let y = 30; y < H - 20; y += 40) {
    g.moveTo(10, y + 0.5);
    g.lineTo(15, y + 0.5);
    g.moveTo(W - 10, y + 0.5);
    g.lineTo(W - 15, y + 0.5);
  }
  g.strokeStyle = colors.line2;
  g.stroke();

  // Region names ("WAITING / the lagoon") are **not** baked in here any
  // more — they used to sit under station plates in the crowded lagoon,
  // since this layer is a cache drawn once per geometry change with no idea
  // where a frame's (live-data-dependent) plates will land. `drawFrame` draws
  // them per frame instead, after the plates, and skips one that would
  // overlap.
  g.font = `500 9.5px "Azeret Mono", ui-monospace, monospace`;
  g.fillStyle = colors.inkFaint;
  g.textAlign = "left";
  g.fillText(horiz ? "FLOW  ⟶     1 BEAD = 1 TASK" : "FLOW ↓   1 BEAD = 1 TASK", 26, H - 28);

  return canvas;
};

/* ------------------------------------------------------------------ *
 * Beads: phyllotaxis per cluster, with a sector split when ≥2 groups
 * ------------------------------------------------------------------ */

const GOLDEN_ANGLE = 2.39996;

export type PlacedBead = { bead: MapBead; x: number; y: number; r: number };
export type PlacedShoal = { cluster: MapCluster; x: number; y: number; r: number };

export type BeadPlacement = {
  beads: Map<number, PlacedBead>;
  shoals: Map<TaskStatus, PlacedShoal>;
  clusterRadius: Record<TaskStatus, number>;
};

/** Where every bead (and shoal) sits, in canvas pixels — the pure-ish geometry step between `MapLayout` and drawing. */
export const placeBeads = (
  layout: MapLayout,
  geometry: SceneGeometry,
  viewportScale: number,
  densityScale: number,
): BeadPlacement => {
  const beads = new Map<number, PlacedBead>();
  const shoals = new Map<TaskStatus, PlacedShoal>();
  const clusterRadius = {} as Record<TaskStatus, number>;
  const spacing = 10 * viewportScale * densityScale;

  for (const station of Object.keys(STATION) as TaskStatus[]) {
    const cluster = layout.clusters[station];
    const [cx, cy] = geometry.P(STATION[station]);
    let maxR = 0;

    const sectorGroups = cluster.groups.filter((g) => g.count > 0);
    const useSectors = sectorGroups.length >= 2;
    const totalCount = sectorGroups.reduce((sum, g) => sum + g.count, 0) || 1;
    let angleCursor = -Math.PI / 2;
    const sectorAngles = new Map<string, { start: number; sweep: number }>();
    if (useSectors) {
      for (const g of sectorGroups) {
        const sweep = (g.count / totalCount) * Math.PI * 2;
        sectorAngles.set(g.key, { start: angleCursor, sweep });
        angleCursor += sweep;
      }
    }

    const localIndex = new Map<string, number>();

    cluster.beads.forEach((bead) => {
      const r = beadRadius(bead.task.priority, viewportScale, densityScale);
      let x: number;
      let y: number;
      if (useSectors) {
        const sector = sectorAngles.get(bead.groupKey);
        const i = localIndex.get(bead.groupKey) ?? 0;
        localIndex.set(bead.groupKey, i + 1);
        const groupCount = sectorGroups.find((g) => g.key === bead.groupKey)?.count ?? 1;
        const theta = sector !== undefined ? sector.start + ((i + 0.5) / Math.max(1, groupCount)) * sector.sweep : 0;
        const radius = spacing * Math.sqrt(i + 1);
        x = cx + Math.cos(theta) * radius;
        y = cy + Math.sin(theta) * radius;
        maxR = Math.max(maxR, radius + r);
      } else {
        const radius = spacing * Math.sqrt(bead.order);
        const theta = bead.order * GOLDEN_ANGLE + 0.6;
        x = cx + Math.cos(theta) * radius;
        y = cy + Math.sin(theta) * radius;
        maxR = Math.max(maxR, radius + r);
      }
      beads.set(bead.task.id, { bead, x, y, r });
    });

    if (cluster.shoal !== null) {
      const i = cluster.beads.length;
      const radius = spacing * Math.sqrt(i + 1);
      const theta = i * GOLDEN_ANGLE + 0.6;
      const shoalR = Math.max(8, spacing * Math.sqrt(cluster.shoal.count) * 0.6);
      const x = cx + Math.cos(theta) * radius;
      const y = cy + Math.sin(theta) * radius;
      shoals.set(station, { cluster, x, y, r: shoalR });
      maxR = Math.max(maxR, radius + shoalR);
    }

    clusterRadius[station] = maxR || 6 * viewportScale;
  }

  return { beads, shoals, clusterRadius };
};

/* ------------------------------------------------------------------ *
 * Callouts — greedy collision avoidance
 * ------------------------------------------------------------------ */

export type CalloutRect = { x: number; y: number; w: number; h: number; text: string; anchorX: number; anchorY: number };

const rectsOverlap = (a: CalloutRect, b: CalloutRect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/**
 * Same test, inflated by `margin` on every side — `rectsOverlap` alone allows
 * two rects to sit flush against each other (touching exactly at an edge
 * doesn't satisfy its strict `<`/`>` comparisons), which is how two plates
 * ended up sharing a border with zero visual gap. Plates want a minimum
 * 6px gap, not just "not literally on top of each other."
 */
const rectsOverlapWithMargin = (a: CalloutRect, b: CalloutRect, margin: number): boolean =>
  rectsOverlap({ ...a, x: a.x - margin, y: a.y - margin, w: a.w + margin * 2, h: a.h + margin * 2 }, b);

/** The minimum gap `placePlate` keeps between two plates (or a plate and a ghost label — see `drawFrame`). */
export const PLATE_MARGIN = 6;

/**
 * Places one callout near `(ax, ay)`, avoiding every rect already in `placed`
 * (other callouts, station plates, and anything else the caller wants labels
 * to steer clear of). Tries 8 compass directions at 3 distances each — dense
 * enough that two callouts anchored a few pixels apart (a common case in a
 * crowded pool) almost always find a free rect — and returns `null` rather
 * than an overlapping placement when none of the 24 candidates fit: a dropped
 * label (still reachable by hovering the bead) beats an unreadable stack.
 */
export const placeCallout = (
  ax: number,
  ay: number,
  text: string,
  w: number,
  h: number,
  placed: readonly CalloutRect[],
  bounds: { W: number; H: number },
): CalloutRect | null => {
  const directions = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => (i * Math.PI) / 4);
  const distances = [12, 22, 34];

  for (const distance of distances) {
    for (const angle of directions) {
      // The callout's near corner sits `distance` from the anchor in this
      // direction; the box is laid out so that corner stays fixed as `w`/`h`
      // vary, rather than the anchor always landing at a box corner.
      const nearX = ax + Math.cos(angle) * distance;
      const nearY = ay + Math.sin(angle) * distance;
      const x = clamp(Math.cos(angle) >= 0 ? nearX : nearX - w, 12, bounds.W - 12 - w);
      const y = clamp(Math.sin(angle) >= 0 ? nearY : nearY - h, 12, bounds.H - 12 - h);
      const rect: CalloutRect = { x, y, w, h, text, anchorX: ax, anchorY: ay };
      if (!placed.some((other) => rectsOverlap(rect, other))) return rect;
    }
  }
  return null;
};

/**
 * Places one station's label plate clear of the ones already drawn
 * (`placed` — every earlier plate, in draw order). Unlike `placeCallout`,
 * this never gives up: a plate names a whole station, not one optional
 * bead, so vanishing when the lagoon gets crowded (the "waiting" region's
 * three stations sit close together) would hide something that has to stay
 * legible — a still-overlapping fallback (the first candidate) beats no
 * plate at all. Tries 8 compass directions, closest ring first, at the
 * pin's own `gap` (the cluster radius plus a little air).
 */
export const placePlate = (
  ax: number,
  ay: number,
  w: number,
  h: number,
  gap: number,
  placed: readonly CalloutRect[],
  bounds: { W: number; H: number },
  text: string,
): CalloutRect => {
  const directions = [-Math.PI / 2, -Math.PI / 4, (-3 * Math.PI) / 4, 0, Math.PI, Math.PI / 4, (3 * Math.PI) / 4, Math.PI / 2];
  const rings = [gap, gap + h + 6, gap + (h + 6) * 2];

  let fallback: CalloutRect | null = null;
  for (const distance of rings) {
    for (const angle of directions) {
      const cx = ax + Math.cos(angle) * distance;
      const cy = ay + Math.sin(angle) * distance;
      const x = clamp(cx - w / 2, 12, bounds.W - 12 - w);
      const y = clamp(cy - h / 2, 12, bounds.H - 12 - h);
      const rect: CalloutRect = { x, y, w, h, text, anchorX: ax, anchorY: ay };
      if (fallback === null) fallback = rect;
      if (!placed.some((other) => rectsOverlapWithMargin(rect, other, PLATE_MARGIN))) return rect;
    }
  }
  return fallback!;
};

/* ------------------------------------------------------------------ *
 * Claim health (data-limited — see the module doc)
 * ------------------------------------------------------------------ */

const CLAIM_WARN_MS = 5 * 60_000;

export const isClaimExpiringSoon = (task: FloorTask, now: number): boolean => {
  if (task.claim === null) return false;
  const remaining = new Date(task.claim.expiresAt).getTime() - now;
  return remaining > 0 && remaining < CLAIM_WARN_MS;
};

const STALE_MS = 7 * 24 * 60 * 60 * 1000;
export const isStaleBead = (task: FloorTask, now: number): boolean =>
  task.status !== "done" && task.status !== "deferred" && now - new Date(task.updatedAt).getTime() > STALE_MS;

/* ------------------------------------------------------------------ *
 * Day / night light
 * ------------------------------------------------------------------ */

export type LightState = { night: number; day: number; warm: number; hour: number };

/** `at` (replay) or "now" drives the clock; both are real timestamps, unlike the prototype's synthetic one. */
export const lightAt = (date: Date): LightState => {
  const hour = date.getHours() + date.getMinutes() / 60;
  const s = Math.sin((Math.PI * (hour - 6)) / 12);
  const night = clamp(-s * 1.4, 0, 1);
  const day = clamp(s, 0, 1);
  const warm = Math.max(Math.exp(-((hour - 6.4) ** 2) / 1.3), Math.exp(-((hour - 19.3) ** 2) / 1.1));
  return { night, day, warm, hour };
};

/** "14:32 · evening" — the map's clock chip label, shared by the toolbar (moved out of the canvas overlay so it never sits over the river) and anything else that wants it. */
export const formatClockLabel = (clockAt: string | undefined): string => {
  const date = clockAt !== undefined ? new Date(clockAt) : new Date();
  const light = lightAt(date);
  const label = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const part =
    light.hour >= 5 && light.hour < 8
      ? "dawn"
      : light.hour >= 8 && light.hour < 18
        ? "day"
        : light.hour >= 18 && light.hour < 21
          ? "evening"
          : "night";
  return `${label} · ${part}`;
};

/* ------------------------------------------------------------------ *
 * Hit list
 * ------------------------------------------------------------------ */

export type FloorHitTarget =
  | { kind: "bead"; task: FloorTask; x: number; y: number; r: number }
  | { kind: "shoal"; station: TaskStatus; x: number; y: number; r: number }
  | { kind: "ghost"; ghost: MapGhostBead; x: number; y: number; r: number }
  | { kind: "station"; station: TaskStatus; x: number; y: number; r: number };

export const hitTest = (hits: readonly FloorHitTarget[], px: number, py: number): FloorHitTarget | undefined => {
  let best: FloorHitTarget | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  for (const hit of hits) {
    const d = Math.hypot(hit.x - px, hit.y - py);
    if (d < hit.r + 8 && d < bestD) {
      bestD = d;
      best = hit;
    }
  }
  return best;
};

/* ------------------------------------------------------------------ *
 * Frame draw
 * ------------------------------------------------------------------ */

export type DrawFrameOptions = {
  ctx: CanvasRenderingContext2D;
  staticLayer: HTMLCanvasElement;
  layout: MapLayout;
  geometry: SceneGeometry;
  placement: BeadPlacement;
  colors: FloorColors;
  projectOrder: readonly string[];
  groupMode: "project" | "epic" | "chain" | "agent" | "label" | "none";
  hoveredTaskId?: number | null;
  selectedTaskId?: number | null;
  keyboardTaskId?: number | null;
  /** The station whose sector dividers/labels should draw — only the hovered or selected cluster, never all ten at once. */
  sectorLabelStation?: TaskStatus | null;
  links: FloorLinksMode;
  now: number;
  clockDate: Date;
  time: number;
  dpr: number;
  showAllCallouts: boolean;
  /** `true` when viewing "now" (not scrubbing/replaying) — caps the day/night overlay so it never washes out contrast during normal use. */
  isLive: boolean;
  /** Beads currently travelling the river (`FloorCanvas` computes the interpolated position/trail every frame — see `route.ts`) — skipped in the normal resting-bead pass and drawn on top of everything instead. */
  activeAnimations?: readonly RenderedBeadAnimation[];
  /** A splash + station flash for a bead that just arrived — `isPool` also pulses the target's pool glow (the `decision.requested`/blocked/needs-action case). */
  arrivals?: readonly RenderedArrival[];
  /** Per-task boat opacity while fading in (a claim just appeared) or out (one was just released) — `1` for every boat not fading, the default when omitted entirely. */
  boatAlpha?: ReadonlyMap<number, number>;
  /** Boats to draw even though `placement`'s own claim is already `null` — mid fade-out, from `FloorCanvas`'s last known claim actor at that bead's (unchanged) position. */
  fadingOutBoats?: readonly FadingOutBoat[];
};

export type FadingOutBoat = { taskId: number; x: number; y: number; r: number; actor: string };

export type RenderedBeadAnimation = {
  taskId: number;
  x: number;
  y: number;
  /** Oldest first, fading out — the trailing ~20 samples behind the bead's current position. */
  trail: readonly (readonly [number, number])[];
  radius: number;
  colorHex: string;
};

export type RenderedArrival = {
  x: number;
  y: number;
  station: TaskStatus;
  /** 0 at the moment of arrival, `durationMs` when the effect is spent — the caller drops it once it's past that. */
  elapsedMs: number;
  durationMs: number;
  isPool: boolean;
  colorHex: string;
};

export const drawFrame = (options: DrawFrameOptions): FloorHitTarget[] => {
  const {
    ctx, staticLayer, layout, geometry, placement, colors, projectOrder, groupMode,
    hoveredTaskId, selectedTaskId, keyboardTaskId, sectorLabelStation, links, now, clockDate, time, dpr,
    showAllCallouts, isLive, activeAnimations = [], arrivals = [],
    boatAlpha = new Map<number, number>(), fadingOutBoats = [],
  } = options;
  const animatingTaskIds = new Set(activeAnimations.map((a) => a.taskId));
  const { W, H, P } = geometry;
  const hits: FloorHitTarget[] = [];

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(staticLayer, 0, 0, W, H);

  // Current: dashes drifting downstream.
  ctx.save();
  ctx.beginPath();
  ctx.rect(15, 15, W - 30, H - 30);
  ctx.clip();
  ctx.strokeStyle = colors.flow;
  ctx.lineWidth = 1.1;
  ctx.lineCap = "round";
  const off = -(time * 20) % 40;
  const strokePoly = (p: [number, number][]) => {
    ctx.beginPath();
    p.forEach((pt, i) => (i ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1])));
    ctx.stroke();
  };
  ([[geometry.mainPx, [-6, 0, 6]], [geometry.loopPx, [-3, 3]], [geometry.creekPx, [0]]] as const).forEach(
    ([p_, lanes]) => {
      lanes.forEach((d, i) => {
        ctx.setLineDash([2 + i, 17 + i * 3]);
        ctx.lineDashOffset = off * (1 + i * 0.15);
        strokePoly(d ? offsetPoly(p_, d * geometry.BS) : p_);
      });
    },
  );
  ctx.setLineDash([]);

  // Day/night light, from the real (or replayed) clock. Capped while live —
  // a full-strength overlay at 3am made light mode go grey-blue with contours
  // and labels losing contrast for anyone just looking at "now"; it is only
  // meant to read strongly while scrubbing or replaying, where the point is to
  // *notice* the hour has changed.
  const L = lightAt(clockDate);
  const overlayDampen = isLive ? 0.4 : 1;
  ctx.globalCompositeOperation = "multiply";
  if (L.night > 0.01) {
    const a = 0.28 * L.night * overlayDampen;
    ctx.fillStyle = colors.dark ? `rgba(8,12,30,${a})` : `rgba(58,70,120,${a * 0.93})`;
    ctx.fillRect(0, 0, W, H);
  }
  if (L.warm > 0.01) {
    ctx.fillStyle = `rgba(240,168,110,${(colors.dark ? 0.1 : 0.2) * L.warm * overlayDampen})`;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.globalCompositeOperation = "screen";
  if (colors.dark && L.day > 0.01) {
    ctx.fillStyle = `rgba(150,180,190,${0.05 * L.day * overlayDampen})`;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.restore();

  // Pools glow by count and oldest wait.
  for (const station of Object.keys(POOL_STATIONS) as TaskStatus[]) {
    const kind = POOL_STATIONS[station];
    if (kind === undefined) continue;
    const cluster = layout.clusters[station];
    const count = cluster.totalCount;
    if (count === 0) continue;
    const [x, y] = P(STATION[station]);
    const breath = 1 + Math.sin(time * 4.5 + x) * 0.05;
    const r = (placement.clusterRadius[station] + 14 + Math.min(56, count * 7)) * breath;
    const col = kind === "block" ? colors.poolBlock : colors.poolAttn;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, colorWithAlpha(col, 0.3));
    gradient.addColorStop(0.55, colorWithAlpha(col, 0.13));
    gradient.addColorStop(1, colorWithAlpha(col, 0));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = colorWithAlpha(col, 0.35);
    ctx.setLineDash([2, 5]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.78, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Every bead's own disc (plus a little padding), as an obstacle for plate
  // placement — **plates move, beads don't**: a bead's screen position is a
  // task's actual location, not something to shuffle just because a plate
  // wants that spot. `placePlate` gets `[...beadObstacles, ...plateRects]`;
  // callouts (below) still only avoid plates + each other, not every bead —
  // a callout anchored 12–34px from its own bead's centre would otherwise
  // almost always collide with its own bead's obstacle rect.
  const BEAD_OBSTACLE_PAD = 3;
  const beadObstacles: CalloutRect[] = [...placement.beads.values()].map(({ x, y, r }) => ({
    x: x - r - BEAD_OBSTACLE_PAD,
    y: y - r - BEAD_OBSTACLE_PAD,
    w: (r + BEAD_OBSTACLE_PAD) * 2,
    h: (r + BEAD_OBSTACLE_PAD) * 2,
    text: "",
    anchorX: x,
    anchorY: y,
  }));

  // Dependency arcs — drawn **before** the plates below, so a plate's own
  // (semi-opaque) background paints over an arc passing under it instead of
  // the arc drawing on top of the plate's text. Bead/shoal positions are
  // already fixed by `placement` regardless of draw order, so moving this
  // earlier changes nothing about where an arc goes, only what ends up on
  // top of what.
  const focusId = selectedTaskId ?? hoveredTaskId ?? null;
  drawEdges({ ctx, layout, placement, colors, links, focusId });

  // Station pins and label plates.
  const plateRects: CalloutRect[] = [];
  for (const station of Object.keys(STATION) as TaskStatus[]) {
    const [x, y] = P(STATION[station]);
    ctx.fillStyle = colors.panel;
    ctx.strokeStyle = colors.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    const plateRect = drawPlate(
      ctx,
      geometry,
      colors,
      layout,
      station,
      x,
      y,
      placement.clusterRadius[station] ?? 6,
      [...beadObstacles, ...plateRects],
    );
    plateRects.push(plateRect);
    hits.push({ kind: "station", station, x, y, r: 10 });

    // Sector dividers + tiny group labels — only for the hovered/selected
    // cluster. Printing every group's name around all ten stations at once
    // (the visual-QA finding this replaced) is noise once the bead colour
    // already says which group is which; a legend below the canvas covers the
    // "what colour is what" question for the other nine.
    if (station !== sectorLabelStation) continue;
    const cluster = layout.clusters[station];
    const groups = cluster.groups.filter((g) => g.count > 0);
    if (groups.length >= 2) {
      const total = groups.reduce((sum, g) => sum + g.count, 0) || 1;
      let angle = -Math.PI / 2;
      const R = placement.clusterRadius[station] + 6;
      ctx.strokeStyle = colorWithAlpha(colors.ink, 0.25);
      ctx.lineWidth = 1;
      for (const g of groups) {
        const sweep = (g.count / total) * Math.PI * 2;
        const mid = angle + sweep / 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(angle) * R, y + Math.sin(angle) * R);
        ctx.stroke();
        ctx.fillStyle = colorWithAlpha(colors.ink, 0.7);
        ctx.font = `600 9px "Azeret Mono", monospace`;
        ctx.textAlign = "center";
        ctx.fillText(g.label.slice(0, 12), x + Math.cos(mid) * (R + 10), y + Math.sin(mid) * (R + 10));
        angle += sweep;
      }
    }
  }

  // Region names ("WAITING" / "the lagoon") — drawn here, per frame, after
  // the plates rather than baked into the static layer underneath them: a
  // label whose rect would collide with an already-placed plate is skipped
  // outright (`docs`: "skip a region label if it collides") rather than
  // drawn and then covered — the lagoon's three close-together stations are
  // exactly the case this was written for.
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const [lane, place, u, v] of REGIONS) {
    const [x, y] = P([u, v]);
    ctx.font = `700 ${geometry.horiz ? 13 : 12}px "Hanken Grotesk", Arial, sans-serif`;
    const laneWidth = ctx.measureText(lane).width;
    // Below `horiz` (the phone's vertical river), only the lane word itself
    // draws — dropping the italic "headwaters"/"the reach"/etc. subtitle is
    // part of keeping the narrow layout calm and legible, not just a
    // collision fallback.
    const placeWidth = geometry.horiz ? ctx.measureText(place).width : 0;
    const rect: CalloutRect = {
      x: x - Math.max(laneWidth, placeWidth) / 2 - 4,
      y: y - 9,
      w: Math.max(laneWidth, placeWidth) + 8,
      h: geometry.horiz ? 30 : 16,
      text: lane,
      anchorX: x,
      anchorY: y,
    };
    if (plateRects.some((plate) => rectsOverlap(rect, plate))) continue;
    ctx.fillStyle = colors.inkFaint;
    ctx.font = `700 ${geometry.horiz ? 13 : 12}px "Hanken Grotesk", Arial, sans-serif`;
    ctx.fillText(lane, x, y);
    if (geometry.horiz) {
      ctx.font = `italic 500 12.5px "Hanken Grotesk", Arial, sans-serif`;
      ctx.fillText(place, x, y + 16);
    }
  }

  // Ghost beads (off-scope blockers/dependents) at the tributary — the map's
  // left edge. Their labels join the **same collision set as plates**
  // (`ghostRects` starts as `[...beadObstacles, ...plateRects]`, and each
  // placed ghost joins it too): a fixed `i * 26` vertical stack put a ghost
  // label right on top of the backlog cluster's own beads whenever a
  // station happened to sit at that height, which a shared collision check
  // catches. Ghosts sweep straight down (not `placePlate`'s ring search —
  // they're already a deliberate vertical list) until clear, capped so one
  // stuck label can't push the rest off the canvas.
  const tributaryX = geometry.padX + 8;
  const ghostRects: CalloutRect[] = [...beadObstacles, ...plateRects];
  layout.ghostBeads.slice(0, 8).forEach((ghost, i) => {
    const label = `${ghost.ref.project ?? "?"} #${ghost.ref.id}`;
    ctx.font = `500 10px "Azeret Mono", monospace`;
    const labelWidth = ctx.measureText(label).width;
    const w = 12 + labelWidth + 4;
    const h = 16;

    let y = geometry.padY + 20 + i * 26;
    const rectAt = (cy: number): CalloutRect => ({ x: tributaryX - 6, y: cy - h / 2, w, h, text: label, anchorX: tributaryX, anchorY: cy });
    let rect = rectAt(y);
    let attempts = 0;
    while (ghostRects.some((other) => rectsOverlapWithMargin(rect, other, PLATE_MARGIN)) && attempts < 40) {
      y += 4;
      rect = rectAt(y);
      attempts += 1;
    }
    ghostRects.push(rect);

    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = colors.inkMuted;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(tributaryX, y, 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = colors.inkMuted;
    ctx.font = `500 10px "Azeret Mono", monospace`;
    ctx.textAlign = "left";
    ctx.fillText(label, tributaryX + 12, y + 3);
    ctx.restore();
    hits.push({ kind: "ghost", ghost, x: tributaryX, y, r: 8 });
  });

  // Beads + shoals. Callouts are collected here and placed in one batch after
  // every bead is drawn (see below) — the collision set needs every plate and
  // every other callout, and dropping the lowest-priority ones only makes
  // sense once we know how many are actually competing for room.
  const calloutRects: CalloutRect[] = [...plateRects];
  const calloutCandidates: { x: number; y: number; label: string; w: number; h: number; rank: number; secondary: number }[] = [];
  const visibleBeadCount = placement.beads.size;
  const lowDensity = visibleBeadCount <= 30;

  for (const [taskId, placed] of placement.beads) {
    // Drawn as a travelling bead below instead — resting *and* travelling at
    // once would show the same task twice.
    if (animatingTaskIds.has(taskId)) continue;
    const { bead, x, y } = placed;
    const isSelected = taskId === selectedTaskId;
    const isHovered = taskId === hoveredTaskId;
    const isKeyboard = taskId === keyboardTaskId;
    const colorIndex = beadColorIndex(bead.task, bead.groupKey, bead.groupIndex, groupMode, projectOrder);
    const col = laneColor(colorIndex, colors);
    const r = placed.r * (isSelected || isHovered ? 1.3 : 1);

    ctx.globalAlpha = bead.dimmed || !bead.traced ? (bead.dimmed && !bead.traced ? 0.1 : 0.15) : 1;

    // Urgent pulse.
    if (bead.task.priority === "urgent" && bead.task.status !== "done" && bead.task.status !== "deferred") {
      const e = (time * 0.5 + bead.task.id) % 1;
      ctx.strokeStyle = colorWithAlpha(col, 0.5 * (1 - e));
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r + 2 + e * 14, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.shadowColor = colorWithAlpha(col, 0.7);
    ctx.shadowBlur = isHovered || isSelected ? 16 : 7;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = colors.ground2;
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,.5)";
    ctx.beginPath();
    ctx.arc(x - r * 0.35, y - r * 0.35, r * 0.28, 0, Math.PI * 2);
    ctx.fill();

    if (isSelected || isKeyboard) {
      ctx.strokeStyle = colors.ink;
      ctx.lineWidth = isKeyboard && !isSelected ? 1.5 : 2;
      if (isKeyboard && !isSelected) ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.arc(x, y, r + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (bead.task.unblocksCount >= 2) {
      ctx.fillStyle = colors.ink;
      ctx.font = `700 9px "Azeret Mono", monospace`;
      ctx.textAlign = "left";
      ctx.fillText(`⛓${bead.task.unblocksCount}`, x + r + 2, y - r);
    }

    ctx.globalAlpha = 1;
    hits.push({ kind: "bead", task: bead.task, x, y, r: Math.max(r, 6) });

    // Callouts: always for must-show beads in pools/boats, hovered/selected, or
    // at low density every bead that fits. Collected now, placed after the
    // loop in priority order (hovered/selected first, then needs-you oldest
    // first, then urgent, then blocked, then the rest) — see the batch below.
    const inPool = POOL_STATIONS[bead.task.status] !== undefined;
    // Vertical mode (the phone's narrow river) draws **plates only, plus the
    // selected/hovered bead's callout** — every must-show/urgent/blocked
    // callout at once, stacked in a 390px-wide column, is exactly what made
    // the phone map illegible.
    const wantsCallout = geometry.horiz
      ? isHovered || isSelected || (bead.mustShow && inPool) || (lowDensity && showAllCallouts)
      : isHovered || isSelected;
    if (wantsCallout && !bead.dimmed) {
      const label = `#${bead.task.id} ${truncate(bead.task.title, 28)}`;
      const w = Math.min(180, 14 + label.length * 5.4);
      const h = 16;
      const rank = isHovered || isSelected ? 0 : inPool && bead.mustShow ? 1 : bead.task.priority === "urgent" ? 2 : bead.task.status === "blocked" ? 3 : 4;
      const secondary = rank === 1 ? new Date(bead.task.updatedAt).getTime() : 0;
      calloutCandidates.push({ x, y, label, w, h, rank, secondary });
    }
  }

  calloutCandidates.sort((a, b) => a.rank - b.rank || a.secondary - b.secondary);
  for (const candidate of calloutCandidates) {
    const rect = placeCallout(candidate.x, candidate.y, candidate.label, candidate.w, candidate.h, calloutRects, {
      W,
      H,
    });
    if (rect === null) continue; // dropped — the bead's hover tip still has this
    calloutRects.push(rect);
    drawCallout(ctx, colors, rect);
  }

  for (const [station, shoal] of placement.shoals) {
    const isHovered = false;
    void isHovered;
    ctx.fillStyle = colorWithAlpha(colors.ink, 0.14);
    ctx.strokeStyle = colorWithAlpha(colors.ink, 0.4);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(shoal.x, shoal.y, shoal.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    const order: TaskPriority[] = ["urgent", "high", "medium", "low"];
    const ringColors: Record<TaskPriority, string> = {
      urgent: colors.poolBlock,
      high: colors.poolAttn,
      medium: colors.inkMuted,
      low: colors.line2,
    };
    const total = order.reduce((sum, p) => sum + shoal.cluster.shoal!.priorityMix[p], 0) || 1;
    let startAngle = -Math.PI / 2;
    for (const p of order) {
      const frac = shoal.cluster.shoal!.priorityMix[p] / total;
      if (frac === 0) continue;
      const endAngle = startAngle + frac * Math.PI * 2;
      ctx.strokeStyle = ringColors[p];
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(shoal.x, shoal.y, shoal.r + 3, startAngle, endAngle);
      ctx.stroke();
      startAngle = endAngle;
    }

    ctx.fillStyle = colors.ink;
    ctx.font = `700 11px "Azeret Mono", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`+${shoal.cluster.shoal!.count}`, shoal.x, shoal.y);
    hits.push({ kind: "shoal", station, x: shoal.x, y: shoal.y, r: shoal.r });
  }

  // Bead travel: the trail, then the moving bead itself, on top of
  // everything drawn so far (stations, plates, resting beads) — a bead mid-
  // journey reads as "in front of" the river, not tucked behind a station.
  for (const anim of activeAnimations) {
    for (let i = 0; i < anim.trail.length; i += 1) {
      const [tx, ty] = anim.trail[i]!;
      const fade = (i + 1) / anim.trail.length; // oldest (i=0) is faintest
      ctx.fillStyle = colorWithAlpha(anim.colorHex, 0.35 * fade);
      ctx.beginPath();
      ctx.arc(tx, ty, anim.radius * (0.35 + 0.4 * fade), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowColor = colorWithAlpha(anim.colorHex, 0.7);
    ctx.shadowBlur = 10;
    ctx.fillStyle = anim.colorHex;
    ctx.beginPath();
    ctx.arc(anim.x, anim.y, anim.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = colors.ground2;
    ctx.stroke();
    const task = placement.beads.get(anim.taskId)?.bead.task;
    if (task !== undefined) hits.push({ kind: "bead", task, x: anim.x, y: anim.y, r: Math.max(anim.radius, 6) });
  }

  // Arrivals: a splash ring at the bead's own arrival point, a brighter flash
  // on the target station's pin, and — for a pool station (waiting on a
  // human) — an extra soft pulse, the `decision.requested`/blocked/
  // needs-action case.
  for (const arrival of arrivals) {
    const t = Math.max(0, Math.min(1, arrival.elapsedMs / arrival.durationMs));
    const fade = 1 - t;
    const splashR = 6 + t * (arrival.isPool ? 26 : 18);
    ctx.strokeStyle = colorWithAlpha(arrival.colorHex, 0.6 * fade);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(arrival.x, arrival.y, splashR, 0, Math.PI * 2);
    ctx.stroke();

    const [sx, sy] = P(STATION[arrival.station]);
    ctx.strokeStyle = colorWithAlpha(colors.ink, 0.5 * fade);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(sx, sy, 4.5 + 6 * fade, 0, Math.PI * 2);
    ctx.stroke();

    if (arrival.isPool) {
      const pulseR = 14 + t * 30;
      ctx.strokeStyle = colorWithAlpha(colors.poolAttn, 0.35 * fade);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sx, sy, pulseR, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Boats + flags: one per live claim (in_progress + a claim), plus any
  // fading out (a claim that was just released — `FloorCanvas` keeps it
  // around, alpha ramping to 0, since it's not in `placement`'s claimed set
  // any more once `claim` goes `null`).
  drawBoatsAndFlags({ ctx, layout, placement, colors, now, geometry, boatAlpha, fadingOutBoats });

  return hits;
};

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const drawCallout = (ctx: CanvasRenderingContext2D, colors: FloorColors, rect: CalloutRect): void => {
  ctx.strokeStyle = colorWithAlpha(colors.ink, 0.25);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(rect.anchorX, rect.anchorY);
  ctx.lineTo(clamp(rect.anchorX, rect.x + 6, rect.x + rect.w - 6), rect.y + (rect.y < rect.anchorY ? rect.h : 0));
  ctx.stroke();

  rr(ctx, rect.x, rect.y, rect.w, rect.h, 5);
  ctx.fillStyle = colorWithAlpha(colors.panel, 0.94);
  ctx.fill();
  ctx.strokeStyle = colors.line2;
  ctx.stroke();
  ctx.fillStyle = colors.ink;
  ctx.font = `500 10px "Azeret Mono", monospace`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(rect.text, rect.x + 6, rect.y + rect.h / 2 + 0.5, rect.w - 10);
};

const drawPlate = (
  ctx: CanvasRenderingContext2D,
  geometry: SceneGeometry,
  colors: FloorColors,
  layout: MapLayout,
  station: TaskStatus,
  x: number,
  y: number,
  clusterR: number,
  placedPlates: readonly CalloutRect[],
): CalloutRect => {
  const cluster = layout.clusters[station];
  const isPool = POOL_STATIONS[station] !== undefined;
  const name = station.replace(/_/g, " ").toUpperCase();
  // Shorter in vertical mode ("4 tasks", not "4 · waiting" / "6 under way")
  // — one of a handful of narrow-layout simplifications (see `drawFrame`'s
  // comments on callouts and region labels) that keep the phone map calm.
  const sub = !geometry.horiz
    ? `${cluster.totalCount} task${cluster.totalCount === 1 ? "" : "s"}`
    : station === "in_progress"
      ? `${cluster.totalCount} under way`
      : isPool && cluster.totalCount > 0
        ? `${cluster.totalCount} · waiting`
        : `${cluster.totalCount} task${cluster.totalCount === 1 ? "" : "s"}`;

  ctx.font = `600 10px "Azeret Mono", monospace`;
  const w1 = ctx.measureText(name).width;
  ctx.font = `500 10px "Azeret Mono", monospace`;
  const w2 = ctx.measureText(sub).width;
  const w = Math.max(w1, w2) + 16;
  const h = 34;
  const gap = clusterR + (isPool ? 16 : 12);
  // Collision-avoided, not a fixed "always above the pin" offset — two pins
  // close together (the lagoon's three waiting stations) used to draw their
  // plates on top of each other, last-drawn winning.
  const { x: lx, y: ly } = placePlate(x, y, w, h, gap, placedPlates, { W: geometry.W, H: geometry.H }, name);

  rr(ctx, lx, ly, w, h, 7);
  ctx.fillStyle = colorWithAlpha(colors.panel, 0.9);
  ctx.fill();
  const hot = isPool && cluster.totalCount > 0;
  ctx.strokeStyle = hot
    ? colorWithAlpha(POOL_STATIONS[station] === "block" ? colors.poolBlock : colors.poolAttn, 0.6)
    : colors.line2;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = `600 10px "Azeret Mono", monospace`;
  ctx.fillStyle = colors.ink;
  ctx.fillText(name, lx + 8, ly + 5);
  ctx.font = `500 10px "Azeret Mono", monospace`;
  ctx.fillStyle = hot ? (POOL_STATIONS[station] === "block" ? colors.poolBlock : colors.poolAttn) : colors.inkFaint;
  ctx.fillText(sub, lx + 8, ly + 19);

  return { x: lx, y: ly, w, h, text: name, anchorX: x, anchorY: y };
};

const drawEdges = (args: {
  ctx: CanvasRenderingContext2D;
  layout: MapLayout;
  placement: BeadPlacement;
  colors: FloorColors;
  links: FloorLinksMode;
  focusId: number | null;
}): void => {
  const { ctx, layout, placement, colors, links, focusId } = args;
  if (links === "off") return;

  const visible = layout.edges.filter((edge: FloorEdge) => {
    if (links === "focus") return focusId !== null && (edge.blockerId === focusId || edge.dependentId === focusId);
    if (links === "blocking") return !edge.satisfied;
    return true;
  });

  const posOf = (id: number): [number, number] | undefined => {
    const bead = placement.beads.get(id);
    if (bead !== undefined) return [bead.x, bead.y];
    const position = layout.taskPosition.get(id);
    if (position?.inShoal === true) {
      const shoal = placement.shoals.get(position.station);
      if (shoal !== undefined) return [shoal.x, shoal.y];
    }
    return undefined;
  };

  for (const edge of visible) {
    const from = posOf(edge.blockerId);
    const to = posOf(edge.dependentId);
    if (from === undefined || to === undefined) continue;

    const isFocused = focusId !== null && (edge.blockerId === focusId || edge.dependentId === focusId);
    ctx.save();
    ctx.globalAlpha = edge.satisfied ? 0.35 : links === "focus" || isFocused ? 1 : 0.7;
    ctx.setLineDash(edge.satisfied ? [4, 4] : []);
    ctx.strokeStyle = colors.inkMuted;
    ctx.fillStyle = colors.inkMuted;
    ctx.lineWidth = isFocused ? 1.8 : 1.4;

    const mx = (from[0] + to[0]) / 2;
    const my = (from[1] + to[1]) / 2;
    const d = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const c: [number, number] = [mx, my - d * 0.4 - 24];
    ctx.beginPath();
    ctx.moveTo(from[0], from[1]);
    ctx.quadraticCurveTo(c[0], c[1], to[0], to[1]);
    ctx.stroke();
    ctx.setLineDash([]);

    const ang = Math.atan2(to[1] - c[1], to[0] - c[0]);
    const hx = to[0] - Math.cos(ang) * 8;
    const hy = to[1] - Math.sin(ang) * 8;
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(hx - Math.cos(ang - 0.45) * 8, hy - Math.sin(ang - 0.45) * 8);
    ctx.lineTo(hx - Math.cos(ang + 0.45) * 8, hy - Math.sin(ang + 0.45) * 8);
    ctx.closePath();
    ctx.fill();

    if (isFocused) {
      const qx = 0.25 * from[0] + 0.5 * c[0] + 0.25 * to[0];
      const qy = 0.25 * from[1] + 0.5 * c[1] + 0.25 * to[1];
      ctx.font = `500 10px "Azeret Mono", monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(`#${edge.blockerId} blocks #${edge.dependentId}`, qx, qy - 3);
    }
    ctx.restore();
  }
};

const drawBoatsAndFlags = (args: {
  ctx: CanvasRenderingContext2D;
  layout: MapLayout;
  placement: BeadPlacement;
  colors: FloorColors;
  now: number;
  geometry: SceneGeometry;
  boatAlpha: ReadonlyMap<number, number>;
  fadingOutBoats: readonly FadingOutBoat[];
}): void => {
  const { ctx, placement, colors, now, geometry, boatAlpha, fadingOutBoats } = args;
  const claimed = [...placement.beads.values()].filter(
    (p) => p.bead.task.status === "in_progress" && p.bead.task.claim !== null,
  );
  const claimedIds = new Set(claimed.map((p) => p.bead.task.id));

  type BoatEntry = { taskId: number; x: number; y: number; r: number; actor: string; expiring: boolean; alpha: number };
  const entries: BoatEntry[] = claimed.map((placed) => ({
    taskId: placed.bead.task.id,
    x: placed.x,
    y: placed.y,
    r: placed.r,
    actor: placed.bead.task.claim?.actor.replace(/^agent:/, "") ?? "",
    expiring: isClaimExpiringSoon(placed.bead.task, now),
    alpha: boatAlpha.get(placed.bead.task.id) ?? 1,
  }));
  // A boat mid fade-out isn't in `claimed` any more (its claim already went
  // `null`) — it's only here because `FloorCanvas` is still ramping its
  // alpha down from the last frame it *was* claimed.
  for (const fading of fadingOutBoats) {
    if (claimedIds.has(fading.taskId)) continue;
    entries.push({
      taskId: fading.taskId,
      x: fading.x,
      y: fading.y,
      r: fading.r,
      actor: fading.actor.replace(/^agent:/, ""),
      expiring: false,
      alpha: boatAlpha.get(fading.taskId) ?? 0,
    });
  }

  entries.forEach((entry, i) => {
    if (entry.alpha <= 0) return;
    const { x, y, r, actor, expiring, alpha } = entry;
    const L = 20 * geometry.BS;
    const hw = 4.5 * geometry.BS;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y - r - 10);
    ctx.beginPath();
    ctx.moveTo(-L / 2, -hw);
    ctx.lineTo(L / 2 - 5, -hw);
    ctx.quadraticCurveTo(L / 2 + 4, 0, L / 2 - 5, hw);
    ctx.lineTo(-L / 2, hw);
    ctx.quadraticCurveTo(-L / 2 - 2, 0, -L / 2, -hw);
    ctx.closePath();
    ctx.fillStyle = colors.panel;
    ctx.fill();
    ctx.strokeStyle = expiring ? colors.poolAttn : colors.ink;
    ctx.lineWidth = 1.3;
    ctx.stroke();
    ctx.restore();

    const txt = `${actor} · #${entry.taskId}`;
    ctx.font = `500 10px "Azeret Mono", monospace`;
    const w = ctx.measureText(txt).width + 12;
    const h = 18;
    const lx = clamp(x - w / 2, 20, geometry.W - 20 - w);
    const ly = y + r + 14 + (i % 2) * 22;
    ctx.save();
    ctx.globalAlpha = alpha;
    rr(ctx, lx, ly, w, h, 6);
    ctx.fillStyle = colorWithAlpha(colors.panel, 0.94);
    ctx.fill();
    ctx.strokeStyle = expiring ? colors.poolAttn : colors.line2;
    ctx.stroke();
    ctx.fillStyle = expiring ? colors.poolAttn : colors.ink;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(txt, lx + 6, ly + h / 2 + 0.5);
    ctx.restore();
  });
};

/* ------------------------------------------------------------------ *
 * Hover tip content
 * ------------------------------------------------------------------ */

export type TipInfo = {
  reference: string;
  project: string | null;
  title: string;
  statusLabel: string;
  priority: TaskPriority;
  waitsOn: number;
  unblocks: number;
  assignee: string | null;
  note: string | null;
};

export const tipInfoFor = (task: FloorTask): TipInfo => ({
  reference: task.reference,
  project: task.project,
  title: task.title,
  statusLabel: task.status.replace(/_/g, " "),
  priority: task.priority,
  waitsOn: task.openBlockerCount,
  unblocks: task.unblocksCount,
  assignee: task.assignee,
  note: task.statusNote,
});

export { nearestIdx };
