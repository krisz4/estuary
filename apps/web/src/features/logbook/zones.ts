import { TASK_STATUSES, type TaskStatus } from "@helpdesk/contracts";

/**
 * The floor's four zones, banded for the Logbook's cumulative flow diagram.
 *
 * **Not** `TASK_STATUS_LANES` from `@helpdesk/contracts` (the retired board's
 * lanes, still defined there): that partition puts `needs_qa` in `doing` and
 * leaves `waiting` with three statuses. The floor plan
 * (`docs/pages/Floor_And_Logbook_Plan.md`) draws the
 * zones differently — Build bay is `in_progress` alone, and Waiting dock
 * absorbs `needs_qa` — because the CFD's question is "who does this wait on
 * right now", and a task in QA is waiting on a human the same as one that is
 * blocked. Kept local to the Logbook rather than exported from contracts:
 * this is a *presentation* grouping, not a workflow rule.
 */
export const LOGBOOK_ZONES = [
  "planning",
  "build",
  "waiting",
  "shipped",
] as const;
export type LogbookZone = (typeof LOGBOOK_ZONES)[number];

export const ZONE_STATUSES: Record<LogbookZone, readonly TaskStatus[]> = {
  planning: ["backlog", "needs_refinement", "todo"],
  build: ["in_progress"],
  waiting: ["blocked", "needs_user_decision", "needs_user_action", "needs_qa"],
  shipped: ["done", "deferred"],
};

export const ZONE_LABELS: Record<LogbookZone, string> = {
  planning: "Planning bench",
  build: "Build bay",
  waiting: "Waiting dock",
  shipped: "Shipped",
};

/** Stacking order for the area chart, bottom to top. Shipped only grows, so it anchors the bottom. */
export const ZONE_STACK_ORDER: readonly LogbookZone[] = ["shipped", "waiting", "build", "planning"];

const STATUS_TO_ZONE: Record<TaskStatus, LogbookZone> = TASK_STATUSES.reduce(
  (acc, status) => {
    const zone = LOGBOOK_ZONES.find((candidate) => ZONE_STATUSES[candidate].includes(status));
    if (zone === undefined) throw new Error(`Status "${status}" is not in any Logbook zone`);
    acc[status] = zone;
    return acc;
  },
  {} as Record<TaskStatus, LogbookZone>,
);

export const zoneOfStatus = (status: TaskStatus): LogbookZone => STATUS_TO_ZONE[status];
