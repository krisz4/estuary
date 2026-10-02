import { describe, expect, it } from "vitest";
import { bucketForSpan, resolveLogbookWindow } from "@/features/logbook/range";

describe("bucketForSpan", () => {
  it("picks hour, day, or week by span length", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(bucketForSpan(0, day)).toBe("hour");
    expect(bucketForSpan(0, 7 * day)).toBe("day");
    expect(bucketForSpan(0, 90 * day)).toBe("week");
  });
});

describe("resolveLogbookWindow", () => {
  const now = new Date("2026-09-26T12:00:00.000Z");

  it("resolves a preset range ending at now", () => {
    const window = resolveLogbookWindow("7d", {}, now);
    expect(window.to).toBe(now.toISOString());
    expect(window.from).toBe(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString());
    expect(window.bucket).toBe("day");
  });

  it("uses hour buckets for 24h", () => {
    expect(resolveLogbookWindow("24h", {}, now).bucket).toBe("hour");
  });

  it("uses week buckets for 90d", () => {
    expect(resolveLogbookWindow("90d", {}, now).bucket).toBe("week");
  });

  it("honors an explicit custom from/to", () => {
    const window = resolveLogbookWindow(
      "custom",
      { from: "2026-01-01T00:00:00.000Z", to: "2026-01-08T00:00:00.000Z" },
      now,
    );
    expect(window).toEqual({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-08T00:00:00.000Z",
      bucket: "day",
    });
  });

  it("falls back to 7d when custom is selected without both bounds", () => {
    const window = resolveLogbookWindow("custom", { from: "2026-01-01T00:00:00.000Z" }, now);
    expect(window.to).toBe(now.toISOString());
  });
});
