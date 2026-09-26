import { describe, expect, it } from "vitest";
import {
  floorActiveFilterCount,
  hasActiveFloorFilters,
  parseFloorParams,
} from "@/pages/tasks-map/useFloorParams";

const params = (query: string) => parseFloorParams(new URLSearchParams(query));

describe("parseFloorParams", () => {
  it("defaults match to dim, shipped to 24h, links to blocking, group to undefined", () => {
    const parsed = params("");
    expect(parsed.match).toBe("dim");
    expect(parsed.shipped).toBe("24h");
    expect(parsed.links).toBe("blocking");
    expect(parsed.group).toBeUndefined();
  });

  it("reads group, links, match, shipped, fold, task, and at", () => {
    const parsed = params("group=epic&links=all&match=hide&shipped=7d&fold=a&fold=b&task=42&at=2026-01-01T00:00:00.000Z");
    expect(parsed.group).toBe("epic");
    expect(parsed.links).toBe("all");
    expect(parsed.match).toBe("hide");
    expect(parsed.shipped).toBe("7d");
    expect(parsed.fold).toEqual(["a", "b"]);
    expect(parsed.task).toBe(42);
    expect(parsed.at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("reads the deprecated `belts` alias exactly like `group`", () => {
    expect(params("belts=chain").group).toBe("chain");
  });

  it("prefers `group` over `belts` when both are present (a hand-edited URL)", () => {
    expect(params("group=agent&belts=chain").group).toBe("agent");
  });

  it("accepts every group mode, including the phase-3 groupings", () => {
    for (const mode of ["project", "none", "epic", "chain", "agent", "label"]) {
      expect(params(`group=${mode}`).group).toBe(mode);
    }
  });

  it("reads stale and working", () => {
    const parsed = params("stale=1&working=1");
    expect(parsed.stale).toBe(true);
    expect(parsed.working).toBe(true);
  });

  it("falls back to the default for an invalid or unrecognised value", () => {
    const parsed = params("group=nonsense&links=nonsense&match=nonsense&shipped=99d&at=not-a-date");
    expect(parsed.group).toBeUndefined();
    expect(parsed.links).toBe("blocking");
    expect(parsed.match).toBe("dim");
    expect(parsed.shipped).toBe("24h");
    expect(parsed.at).toBeUndefined();
  });

  it("still reads the shared list filters (status, q, …)", () => {
    const parsed = params("status=blocked&q=printer&priority=urgent");
    expect(parsed.status).toEqual(["blocked"]);
    expect(parsed.q).toBe("printer");
    expect(parsed.priority).toEqual(["urgent"]);
  });
});

describe("hasActiveFloorFilters / floorActiveFilterCount", () => {
  it("does not count project (scope), group, links, match, shipped, task, or at as filters", () => {
    const parsed = params("project=helpdesk&group=none&links=all&match=hide&shipped=7d&task=1&at=2026-01-01T00:00:00.000Z");
    expect(hasActiveFloorFilters(parsed)).toBe(false);
    expect(floorActiveFilterCount(parsed)).toBe(0);
  });

  it("counts status/priority/label/assignee/createdBy/q/date filters and the stale/working presets", () => {
    const parsed = params("status=blocked&priority=high&q=printer&stale=1&working=1");
    expect(hasActiveFloorFilters(parsed)).toBe(true);
    expect(floorActiveFilterCount(parsed)).toBe(5);
  });
});
