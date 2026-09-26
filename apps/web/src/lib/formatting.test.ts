import { COMMENT_KINDS, TASK_PRIORITIES, TASK_STATUSES } from "@helpdesk/contracts";
import { describe, expect, it } from "vitest";
import {
  actorDisplayName,
  COMMENT_KIND_LABELS,
  formatAbsolute,
  formatCompactAge,
  formatCount,
  formatRelative,
  TASK_PRIORITY_LABELS,
  TASK_STATUS_DESCRIPTIONS,
  TASK_STATUS_LABELS,
  toDateTimeAttribute,
  truncate,
} from "@/lib/formatting";

describe("enum labels", () => {
  // Compared against the contract enums, not against the label maps' own keys.
  // Adding a status API-side and forgetting its label fails here rather than
  // rendering `undefined` in a badge.
  it.each([
    ["status", TASK_STATUSES, TASK_STATUS_LABELS],
    ["priority", TASK_PRIORITIES, TASK_PRIORITY_LABELS],
    ["status description", TASK_STATUSES, TASK_STATUS_DESCRIPTIONS],
    ["comment kind", COMMENT_KINDS, COMMENT_KIND_LABELS],
  ] as const)("covers every %s value", (_name, values, labels) => {
    expect(Object.keys(labels).sort()).toEqual([...values].sort());
    for (const value of values) {
      expect((labels as Record<string, string>)[value]).toBeTruthy();
    }
  });
});

describe("actorDisplayName", () => {
  it.each([
    ["agent:claude-code", "claude-code"],
    ["human:krisz", "krisz"],
    ["system:taskmanager", "taskmanager"],
    // The server's default for a request without `X-Actor` reads as words.
    ["human:anonymous", "Anonymous"],
  ])("renders %s as %s", (actor, expected) => {
    expect(actorDisplayName(actor)).toBe(expected);
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

describe("formatCompactAge", () => {
  const now = new Date("2026-08-11T12:00:00.000Z");

  it.each([
    ["2026-08-11T11:59:50.000Z", "10s"],
    ["2026-08-11T11:55:00.000Z", "5m"],
    ["2026-08-11T11:00:00.000Z", "1h"],
    ["2026-08-10T12:00:00.000Z", "1d"],
    ["2026-08-04T12:00:00.000Z", "1w"],
    ["2026-07-28T12:00:00.000Z", "2w"],
    ["2026-06-11T12:00:00.000Z", "2mo"],
    ["2024-08-11T12:00:00.000Z", "1y"],
  ])("renders %s (relative to now) as %s", (iso, expected) => {
    expect(formatCompactAge(iso, now)).toBe(expected);
  });

  it("is symmetric for a future timestamp — a compact column doesn't need a sign", () => {
    expect(formatCompactAge("2026-08-11T12:00:30.000Z", now)).toBe("30s");
  });

  it("returns an em dash for unparseable input", () => {
    expect(formatCompactAge("not-a-date", now)).toBe("—");
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
    expect(formatCount(1, "task")).toBe("1 task");
    expect(formatCount(0, "task")).toBe("0 tasks");
    expect(formatCount(63, "task")).toBe("63 tasks");
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
