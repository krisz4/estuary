import { TASK_STATUSES, type TaskStatus } from "@estuary/contracts";

/**
 * The estuary's four reaches, banded for the Logbook's cumulative flow diagram
 * and drawn as the task detail's course strip (`features/tasks/StatusCourse`).
 * The names are the Map's regions — PLAN / headwaters, DOING / the reach,
 * WAITING / the lagoon, CLOSED / the mouth — so a band in a chart and a region
 * on the map are called the same thing.
 *
 * **Not** `TASK_STATUS_LANES` from `@estuary/contracts` (the retired board's
 * lanes, still defined there): that partition puts `needs_qa` in `doing` and
 * leaves `waiting` with three statuses. The floor plan
 * (`docs/pages/Floor_And_Logbook_Plan.md`) draws the
 * zones differently — the reach is `in_progress` alone, and the lagoon
 * absorbs `needs_qa` — because the CFD's question is "who does this wait on
 * right now", and a task in QA is waiting on a human the same as one that is
 * blocked. Kept local to the Logbook rather than exported from contracts:
 * this is a *presentation* grouping, not a workflow rule.
 */
export const LOGBOOK_ZONES = ["planning", "build", "waiting", "shipped"] as const;
export type LogbookZone = (typeof LOGBOOK_ZONES)[number];

export const ZONE_STATUSES: Record<LogbookZone, readonly TaskStatus[]> = {
  planning: ["backlog", "needs_refinement", "todo"],
  build: ["in_progress"],
  waiting: ["blocked", "needs_user_decision", "needs_user_action", "needs_qa"],
  shipped: ["done", "deferred"],
};

/** What happens there — the Map's region caption, in sentence case. */
export const ZONE_NAMES: Record<LogbookZone, string> = {
  planning: "Plan",
  build: "Doing",
  waiting: "Waiting",
  shipped: "Closed",
};

/** Where it is on the river — the Map's italic region subtitle. */
export const ZONE_REACHES: Record<LogbookZone, string> = {
  planning: "headwaters",
  build: "the reach",
  waiting: "the lagoon",
  shipped: "the mouth",
};

/** Chart legend label: "Waiting · the lagoon". */
export const ZONE_LABELS: Record<LogbookZone, string> = {
  planning: `${ZONE_NAMES.planning} · ${ZONE_REACHES.planning}`,
  build: `${ZONE_NAMES.build} · ${ZONE_REACHES.build}`,
  waiting: `${ZONE_NAMES.waiting} · ${ZONE_REACHES.waiting}`,
  shipped: `${ZONE_NAMES.shipped} · ${ZONE_REACHES.shipped}`,
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
