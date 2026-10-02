/**
 * Generates `src/assets/contours.svg` — the seamless topographic tile behind
 * every page (`.estuary-ground` in `src/index.css`), the same "map paper" the
 * Estuary map is drawn on.
 *
 * The field is a sum of waves with whole-number frequencies over the tile, so
 * it is periodic: a contour that leaves the right edge re-enters on the left,
 * and the tile repeats without a seam. Contours come from marching squares,
 * chained into polylines so the file stays small.
 *
 * Run: `node apps/web/scripts/generate-contours.mjs` (deterministic output).
 */
import { writeFileSync } from "node:fs";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

const SIZE = 560; // tile edge, px
const N = 112; // grid cells per edge
const CELL = SIZE / N;
const TAU = Math.PI * 2;

// [fx, fy, amplitude, phase] — integer frequencies keep the field periodic.
const WAVES = [
  [1, 0, 1.0, 0.3],
  [0, 1, 0.9, 1.7],
  [1, 1, 0.8, 2.4],
  [2, -1, 0.55, 0.9],
  [1, -2, 0.45, 4.1],
  [3, 1, 0.3, 5.2],
  [2, 3, 0.22, 3.3],
  [4, -1, 0.14, 1.1],
];

const field = (x, y) => {
  const u = x / SIZE;
  const v = y / SIZE;
  let sum = 0;
  for (const [fx, fy, a, p] of WAVES) sum += a * Math.sin(TAU * (fx * u + fy * v) + p);
  return sum;
};

const grid = [];
for (let j = 0; j <= N; j++) {
  const row = [];
  for (let i = 0; i <= N; i++) row.push(field(i * CELL, j * CELL));
  grid.push(row);
}

const round = (n) => Math.round(n * 10) / 10;
const key = (p) => `${p[0]},${p[1]}`;

const contour = (level) => {
  const segments = [];
  const lerp = (a, b, va, vb) => a + ((level - va) / (vb - va)) * (b - a);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x0 = i * CELL;
      const y0 = j * CELL;
      const x1 = x0 + CELL;
      const y1 = y0 + CELL;
      const a = grid[j][i];
      const b = grid[j][i + 1];
      const c = grid[j + 1][i + 1];
      const d = grid[j + 1][i];
      const edges = [];
      if (a < level !== b < level) edges.push([round(lerp(x0, x1, a, b)), round(y0)]);
      if (b < level !== c < level) edges.push([round(x1), round(lerp(y0, y1, b, c))]);
      if (d < level !== c < level) edges.push([round(lerp(x0, x1, d, c)), round(y1)]);
      if (a < level !== d < level) edges.push([round(x0), round(lerp(y0, y1, a, d))]);
      if (edges.length === 2) segments.push([edges[0], edges[1]]);
      if (edges.length === 4) {
        segments.push([edges[0], edges[1]]);
        segments.push([edges[2], edges[3]]);
      }
    }
  }

  // Chain segments into polylines through shared endpoints.
  const byPoint = new Map();
  segments.forEach((s, idx) => {
    for (const p of s) {
      const k = key(p);
      if (!byPoint.has(k)) byPoint.set(k, []);
      byPoint.get(k).push(idx);
    }
  });
  const used = new Set();
  const lines = [];
  const extend = (line) => {
    for (;;) {
      const tail = line[line.length - 1];
      const next = (byPoint.get(key(tail)) ?? []).find((idx) => !used.has(idx));
      if (next === undefined) return;
      used.add(next);
      const [p, q] = segments[next];
      line.push(key(p) === key(tail) ? q : p);
    }
  };
  segments.forEach((s, idx) => {
    if (used.has(idx)) return;
    used.add(idx);
    const line = [s[0], s[1]];
    extend(line);
    line.reverse();
    extend(line);
    if (line.length > 2) lines.push(line);
  });
  return lines;
};

/** Ramer–Douglas–Peucker: drop points that sit within `eps` px of the line. */
const simplify = (line, eps = 0.45) => {
  if (line.length < 3) return line;
  const [ax, ay] = line[0];
  const [bx, by] = line[line.length - 1];
  const len = Math.hypot(bx - ax, by - ay) || 1;
  let worst = 0;
  let at = 0;
  for (let i = 1; i < line.length - 1; i++) {
    const [px, py] = line[i];
    const dist = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
    if (dist > worst) [worst, at] = [dist, i];
  }
  if (worst <= eps) return [line[0], line[line.length - 1]];
  return [...simplify(line.slice(0, at + 1), eps).slice(0, -1), ...simplify(line.slice(at), eps)];
};

const toPath = (raw) => {
  // A closed loop (a hilltop) starts and ends on one point, which RDP would
  // read as a zero-length baseline and collapse — so simplify it in halves.
  const closed = key(raw[0]) === key(raw[raw.length - 1]);
  const mid = Math.floor(raw.length / 2);
  const line = closed
    ? [...simplify(raw.slice(0, mid + 1)).slice(0, -1), ...simplify(raw.slice(mid))]
    : simplify(raw);
  return line.map((p, i) => `${i === 0 ? "M" : i === 1 ? "L" : ""}${p[0]} ${p[1]}`).join(" ");
};

const paths = [];
let n = 0;
for (let level = -2.8; level <= 2.8; level += 0.32, n++) {
  const d = contour(level).map(toPath).join("");
  if (d === "") continue;
  // Every fifth line is an "index contour", drawn heavier, as on a survey map.
  paths.push(`<path d="${d}"${n % 5 === 0 ? ' stroke-width="1.6"' : ""}/>`);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" fill="none" stroke="#000" stroke-width="0.9" stroke-linejoin="round">${paths.join("")}</svg>\n`;

const out = fileURLToPath(new URL("../src/assets/contours.svg", import.meta.url));
writeFileSync(out, svg);
process.stdout.write(`wrote ${out} (${(svg.length / 1024).toFixed(1)} KB)\n`);
