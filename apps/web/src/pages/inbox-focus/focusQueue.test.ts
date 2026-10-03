import { describe, expect, it } from "vitest";
import {
  appendNew,
  parseFocusKind,
  positionOf,
  resolveCurrent,
  stepsFrom,
} from "@/pages/inbox-focus/focusQueue";

const live = (...ids: number[]) => new Set(ids);

describe("parseFocusKind", () => {
  it("accepts an attention kind and ignores anything else", () => {
    expect(parseFocusKind("review")).toBe("review");
    expect(parseFocusKind("nope")).toBeNull();
    expect(parseFocusKind(null)).toBeNull();
  });
});

describe("appendNew", () => {
  it("appends unseen ids at the end, keeping the order already seen", () => {
    expect(appendNew([3, 1], [5, 1, 3, 4])).toEqual([3, 1, 5, 4]);
  });

  it("returns the same array when nothing is new", () => {
    const order = [1, 2];
    expect(appendNew(order, [2])).toBe(order);
  });
});

describe("resolveCurrent", () => {
  const order = [1, 2, 3, 4];

  it("starts at the first item still waiting", () => {
    expect(resolveCurrent(order, live(2, 3), null)).toBe(2);
  });

  it("keeps the cursor while it still waits", () => {
    expect(resolveCurrent(order, live(1, 2, 3), 3)).toBe(3);
  });

  it("moves on to the next one once the cursor is cleared", () => {
    expect(resolveCurrent(order, live(1, 4), 2)).toBe(4);
  });

  it("wraps back to a skipped item when the last one is cleared", () => {
    expect(resolveCurrent(order, live(1, 2), 4)).toBe(2);
  });

  it("is null when nothing is left", () => {
    expect(resolveCurrent(order, live(), 2)).toBeNull();
  });
});

describe("stepsFrom", () => {
  const order = [1, 2, 3, 4];

  it("steps over cleared items both ways", () => {
    expect(stepsFrom(order, live(1, 3, 4), 3)).toEqual({ next: 4, nextWraps: false, previous: 1 });
  });

  it("wraps Skip to the first remaining item, but never Previous", () => {
    expect(stepsFrom(order, live(1, 2, 4), 4)).toEqual({ next: 1, nextWraps: true, previous: 2 });
    expect(stepsFrom(order, live(1, 2), 1)).toEqual({ next: 2, nextWraps: false, previous: null });
  });

  it("has nowhere to go with one item left", () => {
    expect(stepsFrom(order, live(3), 3)).toEqual({ next: null, nextWraps: false, previous: null });
  });
});

describe("positionOf", () => {
  it("counts only the items still waiting", () => {
    expect(positionOf([1, 2, 3, 4], live(1, 3, 4), 4)).toBe(3);
  });
});
