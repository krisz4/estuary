import { TASK_STATUSES } from "@estuary/contracts";
import { describe, expect, it } from "vitest";
import {
  LOGBOOK_ZONES,
  ZONE_STACK_ORDER,
  ZONE_STATUSES,
  zoneOfStatus,
} from "@/features/logbook/zones";

describe("Logbook zones", () => {
  it("partitions every status into exactly one zone", () => {
    const seen = new Set<string>();
    for (const zone of LOGBOOK_ZONES) {
      for (const status of ZONE_STATUSES[zone]) {
        expect(seen.has(status)).toBe(false);
        seen.add(status);
      }
    }
    expect([...seen].sort()).toEqual([...TASK_STATUSES].sort());
  });

  it("maps each status back to its zone", () => {
    expect(zoneOfStatus("backlog")).toBe("planning");
    expect(zoneOfStatus("in_progress")).toBe("build");
    expect(zoneOfStatus("needs_qa")).toBe("waiting");
    expect(zoneOfStatus("blocked")).toBe("waiting");
    expect(zoneOfStatus("done")).toBe("shipped");
    expect(zoneOfStatus("deferred")).toBe("shipped");
  });

  it("stacks shipped at the bottom of the CFD", () => {
    expect(ZONE_STACK_ORDER[0]).toBe("shipped");
    expect(ZONE_STACK_ORDER).toHaveLength(LOGBOOK_ZONES.length);
  });
});
