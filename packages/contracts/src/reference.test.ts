import { describe, expect, it } from "vitest";
import { formatReference, parseReference, REFERENCE_PREFIX } from "./reference.js";

describe("formatReference", () => {
  it("uses the TASK- prefix", () => {
    expect(REFERENCE_PREFIX).toBe("TASK-");
  });

  it("pads to six digits", () => {
    expect(formatReference(42)).toBe("TASK-000042");
    expect(formatReference(1)).toBe("TASK-000001");
  });

  it("widens rather than truncating past six digits", () => {
    expect(formatReference(1234567)).toBe("TASK-1234567");
  });
});

describe("parseReference", () => {
  it.each(["TASK-000042", "task-000042", "Task-42", "TASK-42", "task-42", "#42", "42", "  42  "])(
    "resolves %s to task 42",
    (input) => {
      expect(parseReference(input)).toBe(42);
    },
  );

  it("matches the whole number, not a prefix", () => {
    // TASK-4 is task 4 — never tasks 40-49. Prefix matching on an integer
    // column would mean a CAST and a full scan.
    expect(parseReference("TASK-4")).toBe(4);
  });

  it.each([
    "",
    "TASK-",
    "#",
    "abc",
    "TASK-abc",
    "4 2",
    "4.5",
    "-4",
    "TASK-0",
    "0",
    "1e3",
    "42x",
    // The retired helpdesk prefix is not an alias — it would resolve an old
    // ticket number to whatever task now has that id.
    "HD-000042",
    "TASK-#42",
    "#TASK-42",
  ])("returns null for %s", (input) => {
    expect(parseReference(input)).toBeNull();
  });

  it("returns null rather than an unsafe integer for an absurdly long run of digits", () => {
    expect(parseReference("9".repeat(40))).toBeNull();
  });

  it("round-trips a formatted reference", () => {
    expect(parseReference(formatReference(999))).toBe(999);
  });
});
