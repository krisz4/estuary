/**
 * A CSS colour, at a given alpha, regardless of what syntax the colour itself
 * is written in.
 *
 * The Foundry pass's `rgba(hex, alpha)` helper parsed `#rrggbb` only, and every
 * Estuary token is `oklch(...)` or already `rgba(...)` — so glows and floor
 * paint that pass a token straight through it drew fully opaque, an alpha of
 * `undefined` silently defaulting to 1. `color-mix(in srgb, <color> X%,
 * transparent)` fades *any* valid CSS colour string — hex, `rgb()`, `oklch()`,
 * a `var(--x)` already resolved by `getComputedStyle`, even another
 * `color-mix()` — without this module having to parse it at all, which is what
 * makes it robust against a token's syntax changing under it.
 *
 * Cached by `${color}|${alpha}`: the canvas draw loop calls this many times a
 * frame with a small, repeating set of (colour, alpha) pairs (the same pool
 * glow, the same dimmed-bead alpha), and a `Map` lookup is cheaper than
 * rebuilding the same string every time.
 */
const cache = new Map<string, string>();

export const colorWithAlpha = (color: string, alpha: number): string => {
  const clamped = Math.max(0, Math.min(1, alpha));
  // Two decimal places is enough precision for anything a human eye or a
  // canvas alpha blend can distinguish, and keeps the cache from growing one
  // entry per floating-point rounding error.
  const percent = Math.round(clamped * 10000) / 100;
  const key = `${color}|${percent}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const value = `color-mix(in srgb, ${color} ${percent}%, transparent)`;
  cache.set(key, value);
  return value;
};

/** For tests — the cache is a module singleton and otherwise leaks across test files. */
export const clearColorAlphaCache = (): void => cache.clear();
