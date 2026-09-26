import { floorQuerySchema } from "@helpdesk/contracts";
import type { z } from "zod";

import {
  ACTOR_422_NOTE,
  FloorSnapshotComponent,
  describeQueryParams,
  errorResponse,
  registerV1Path,
  unwrapPreprocessedObject,
} from "../lib/openapi.js";
import { QUERY_DESCRIPTIONS } from "./tasks.openapi.js";

/**
 * OpenAPI definitions for `routes/floor.route.ts`. See
 * `docs/features/Floor_Snapshot.md`.
 *
 * A function rather than an import side effect — see the note at the top of
 * `tasks.openapi.ts`.
 */

const { page: _page, pageSize: _pageSize, sort: _sort, ...TASK_FILTER_DESCRIPTIONS } =
  QUERY_DESCRIPTIONS;

export const FLOOR_QUERY_DESCRIPTIONS: Record<string, string> = {
  ...TASK_FILTER_DESCRIPTIONS,
  project:
    "Scope, not a filter — rows outside these projects are not returned at all. Repeatable. Omit for every project.",
  shipped:
    "How far back the Shipped shelf reaches for done/deferred tasks (24h default, or 7d). Older closed tasks only count toward meta.olderClosedCount.",
  at: "Replay: the floor as it stood at this instant. Status and existence are replayed from task.status_changed events; titles, priority, and labels are today's values, and claims are always null.",
};

export const buildFloorQueryParams = (): z.ZodObject =>
  describeQueryParams(unwrapPreprocessedObject(floorQuerySchema), FLOOR_QUERY_DESCRIPTIONS);

/** Registers `GET /floor`. Called once, by `getOpenApiDocument()`. */
export function registerFloorPaths(): void {
  registerV1Path({
    method: "get",
    path: "/api/v1/floor",
    tags: ["Floor"],
    summary: "The floor snapshot",
    description: [
      "Everything the floor view needs in one call: compact task rows (open tasks, plus done/deferred ones inside the `shipped` window), the dependency edges touching them, refs for the tasks those edges (or a parentId) point at outside the returned set, and `meta` — status counts for the whole scope, the shipped window, and `lastEventId` to start polling `GET /events?after=` from.",
      "",
      "`project` is **scope**: it removes rows entirely. Every other filter marks `matches` on a row instead of removing it — the floor dims non-matching crates in place rather than moving anything. `meta.matchCount` counts the returned rows with `matches: true`.",
      "",
      `Capped at FLOOR_TASK_CAP rows, must-show first (needs a human, in progress, blocked, urgent priority), then by priority and recency — \`meta.truncated\` says so, and \`meta.statusCounts\` still counts everything in scope regardless of the cap.`,
      "",
      "`at` replays the floor at an earlier instant: status and existence come from `task.status_changed` events (a task created after `at` is absent), everything else is today's data, and claims are always null.",
    ].join("\n"),
    request: { query: buildFloorQueryParams() },
    responses: {
      200: {
        description: "The snapshot.",
        content: { "application/json": { schema: FloorSnapshotComponent } },
      },
      422: errorResponse(
        `An unknown parameter, an invalid filter value, or a malformed \`at\`. ${ACTOR_422_NOTE}`,
        ["VALIDATION_ERROR"],
      ),
    },
  });
}
