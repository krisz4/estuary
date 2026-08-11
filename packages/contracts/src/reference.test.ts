import { describe, expect, it } from "vitest";
import { formatReference, parseReference } from "./reference.js";

describe("formatReference", () => {
  it("pads to six digits", () => {
    expect(formatReference(42)).toBe("HD-000042");
    expect(formatReference(1)).toBe("HD-000001");
  });

  it("widens rather than truncating past six digits", () => {
    expect(formatReference(1234567)).toBe("HD-1234567");
  });
});

describe("parseReference", () => {
  it.each(["HD-000042", "hd-000042", "HD-42", "hd-42", "#42", "42", "  42  "])(
    "resolves %s to ticket 42",
    (input) => {
      expect(parseReference(input)).toBe(42);
    },
  );

  it("matches the whole number, not a prefix", () => {
    // HD-4 is ticket 4 — never tickets 40-49. Prefix matching on an integer
    // column would mean a CAST and a full scan.
    expect(parseReference("HD-4")).toBe(4);
  });

  it.each(["", "HD-", "#", "abc", "HD-abc", "4 2", "4.5", "-4", "HD-0", "0", "1e3", "42x"])(
    "returns null for %s",
    (input) => {
      expect(parseReference(input)).toBeNull();
    },
  );

  it("returns null rather than an unsafe integer for an absurdly long run of digits", () => {
    expect(parseReference("9".repeat(40))).toBeNull();
  });

  it("round-trips a formatted reference", () => {
    expect(parseReference(formatReference(999))).toBe(999);
  });
});
