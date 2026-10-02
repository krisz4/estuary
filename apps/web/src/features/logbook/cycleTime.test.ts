import { type CycleTime } from "@estuary/contracts";
import { describe, expect, it } from "vitest";
import { cycleTimeScaleMax, groupCycleTimesByAgent } from "@/features/logbook/cycleTime";

const pass = (overrides: Partial<CycleTime>): CycleTime => ({
  taskId: 1,
  reference: "TASK-000001",
  title: "Task",
  actor: "agent:claude-code",
  minutes: 30,
  finishedAt: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

describe("groupCycleTimesByAgent", () => {
  it("groups by actor and sorts each lane oldest-first", () => {
    const lanes = groupCycleTimesByAgent([
      pass({ actor: "agent:a", minutes: 10, finishedAt: "2026-09-02T00:00:00.000Z" }),
      pass({ actor: "agent:a", minutes: 20, finishedAt: "2026-09-01T00:00:00.000Z" }),
      pass({ actor: "agent:b", minutes: 5, finishedAt: "2026-09-01T00:00:00.000Z" }),
    ]);

    const laneA = lanes.find((lane) => lane.actor === "agent:a")!;
    expect(laneA.passes.map((entry) => entry.minutes)).toEqual([20, 10]);
    expect(laneA.minMinutes).toBe(10);
    expect(laneA.maxMinutes).toBe(20);
  });

  it("orders lanes busiest-first", () => {
    const lanes = groupCycleTimesByAgent([
      pass({ actor: "agent:quiet" }),
      pass({ actor: "agent:busy" }),
      pass({ actor: "agent:busy", finishedAt: "2026-09-03T00:00:00.000Z" }),
    ]);
    expect(lanes.map((lane) => lane.actor)).toEqual(["agent:busy", "agent:quiet"]);
  });

  it("returns an empty list for no cycle times", () => {
    expect(groupCycleTimesByAgent([])).toEqual([]);
  });
});

describe("cycleTimeScaleMax", () => {
  it("is the largest max across lanes, zero when there are none", () => {
    const lanes = groupCycleTimesByAgent([
      pass({ minutes: 15 }),
      pass({ actor: "agent:b", minutes: 45 }),
    ]);
    expect(cycleTimeScaleMax(lanes)).toBe(45);
    expect(cycleTimeScaleMax([])).toBe(0);
  });
});
