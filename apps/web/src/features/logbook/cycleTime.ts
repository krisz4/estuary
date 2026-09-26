import { type CycleTime } from "@helpdesk/contracts";
import { actorDisplayName } from "@/lib/formatting";

/** One agent's row in the cycle-time dot strip: every finished pass, oldest first. */
export type CycleTimeLane = {
  actor: string;
  label: string;
  passes: CycleTime[];
  minMinutes: number;
  maxMinutes: number;
};

/**
 * Groups `cycleTimes` (newest first, per the API) by actor, each lane sorted
 * oldest-first for a left-to-right timeline, and returns the shared min/max
 * across every lane so the strip can use one x-scale.
 */
export const groupCycleTimesByAgent = (cycleTimes: CycleTime[]): CycleTimeLane[] => {
  const byActor = new Map<string, CycleTime[]>();
  for (const entry of cycleTimes) {
    const list = byActor.get(entry.actor) ?? [];
    list.push(entry);
    byActor.set(entry.actor, list);
  }

  const lanes: CycleTimeLane[] = [...byActor.entries()].map(([actor, passes]) => {
    const sorted = [...passes].sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt));
    return {
      actor,
      label: actorDisplayName(actor),
      passes: sorted,
      minMinutes: Math.min(...sorted.map((pass) => pass.minutes)),
      maxMinutes: Math.max(...sorted.map((pass) => pass.minutes)),
    };
  });

  // Busiest agent first — the strip is a scan for outliers, and the agent with
  // the most passes is the one most worth comparing against itself.
  lanes.sort((a, b) => b.passes.length - a.passes.length || a.label.localeCompare(b.label));
  return lanes;
};

export const cycleTimeScaleMax = (lanes: CycleTimeLane[]): number =>
  lanes.reduce((max, lane) => Math.max(max, lane.maxMinutes), 0);
