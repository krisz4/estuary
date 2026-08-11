import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES } from "@helpdesk/contracts";
import { describe, expect, it } from "vitest";
import {
  formatAbsolute,
  formatCount,
  formatRelative,
  TICKET_CATEGORY_LABELS,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  toDateTimeAttribute,
  truncate,
} from "@/lib/formatting";

describe("enum labels", () => {
  // Compared against the contract enums, not against the label maps' own keys.
  // Adding a status API-side and forgetting its label fails here rather than
  // rendering `undefined` in a badge.
  it.each([
    ["status", TICKET_STATUSES, TICKET_STATUS_LABELS],
    ["priority", TICKET_PRIORITIES, TICKET_PRIORITY_LABELS],
    ["category", TICKET_CATEGORIES, TICKET_CATEGORY_LABELS],
  ] as const)("covers every %s value", (_name, values, labels) => {
    expect(Object.keys(labels).sort()).toEqual([...values].sort());
    for (const value of values) {
      expect((labels as Record<string, string>)[value]).toBeTruthy();
    }
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-08-11T12:00:00.000Z");

  it.each([
    ["2026-08-11T11:59:30.000Z", "30 seconds ago"],
    ["2026-08-11T11:00:00.000Z", "1 hour ago"],
    ["2026-08-09T12:00:00.000Z", "2 days ago"],
    ["2026-08-11T12:00:30.000Z", "in 30 seconds"],
  ])("renders %s as %s", (iso, expected) => {
    expect(formatRelative(iso, now)).toBe(expected);
  });

  it("returns an em dash rather than 'Invalid Date' for unparseable input", () => {
    expect(formatRelative("not-a-date", now)).toBe("—");
    expect(formatAbsolute("not-a-date")).toBe("—");
  });
});

describe("toDateTimeAttribute", () => {
  it("passes a valid ISO string through", () => {
    expect(toDateTimeAttribute("2026-08-11T12:00:00.000Z")).toBe("2026-08-11T12:00:00.000Z");
  });

  it("is undefined for invalid input — an absent attribute beats a wrong one", () => {
    // Assistive technology reads `datetime` as authoritative, so a garbage
    // value is worse than none.
    expect(toDateTimeAttribute("tomorrow")).toBeUndefined();
  });
});

describe("formatCount", () => {
  it("pluralises", () => {
    expect(formatCount(1, "ticket")).toBe("1 ticket");
    expect(formatCount(0, "ticket")).toBe("0 tickets");
    expect(formatCount(63, "ticket")).toBe("63 tickets");
  });

  it("takes an irregular plural", () => {
    expect(formatCount(2, "match", "matches")).toBe("2 matches");
  });
});

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("short", 20)).toBe("short");
  });

  it("cuts on a word boundary when there is a late enough one", () => {
    expect(truncate("the printer on floor two is jammed again", 20)).toBe("the printer on floor…");
  });

  it("cuts mid-word rather than losing most of the text to an early space", () => {
    expect(truncate("a supercalifragilisticexpialidocious word", 20)).toBe("a supercalifragilist…");
  });
});
