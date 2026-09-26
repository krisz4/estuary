import { beforeEach, describe, expect, it } from "vitest";
import { clearColorAlphaCache, colorWithAlpha } from "@/features/floor/colorAlpha";

describe("colorWithAlpha", () => {
  beforeEach(() => clearColorAlphaCache());

  it("wraps a hex colour in color-mix", () => {
    expect(colorWithAlpha("#c0710f", 0.3)).toBe("color-mix(in srgb, #c0710f 30%, transparent)");
  });

  it("wraps an oklch token the same way — the bug this fixes", () => {
    // The Foundry-era `rgba(hex, alpha)` helper only understood `#rrggbb` and
    // returned the oklch string unchanged, so alpha silently became 1 — glows
    // and floor paint drew fully opaque. `color-mix` never special-cases syntax.
    expect(colorWithAlpha("oklch(0.6 0.14 40)", 0.2)).toBe(
      "color-mix(in srgb, oklch(0.6 0.14 40) 20%, transparent)",
    );
  });

  it("wraps an already-rgba colour the same way", () => {
    expect(colorWithAlpha("rgba(28,42,50,.12)", 0.5)).toBe(
      "color-mix(in srgb, rgba(28,42,50,.12) 50%, transparent)",
    );
  });

  it("clamps alpha to [0, 1]", () => {
    expect(colorWithAlpha("#000000", -1)).toBe("color-mix(in srgb, #000000 0%, transparent)");
    expect(colorWithAlpha("#000000", 5)).toBe("color-mix(in srgb, #000000 100%, transparent)");
  });

  it("rounds to two decimal places of percent", () => {
    expect(colorWithAlpha("#000000", 1 / 3)).toBe("color-mix(in srgb, #000000 33.33%, transparent)");
  });

  it("caches by colour and alpha, returning the same string instance", () => {
    const a = colorWithAlpha("#123456", 0.4);
    const b = colorWithAlpha("#123456", 0.4);
    expect(a).toBe(b);
  });

  it("does not collide two different colours or alphas onto the same cache entry", () => {
    expect(colorWithAlpha("#111111", 0.5)).not.toBe(colorWithAlpha("#222222", 0.5));
    expect(colorWithAlpha("#111111", 0.5)).not.toBe(colorWithAlpha("#111111", 0.6));
  });
});
