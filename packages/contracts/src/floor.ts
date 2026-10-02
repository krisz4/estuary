import { z } from "zod";
import { storedActorSchema } from "./actor.js";
import {
  TASK_STATUSES,
  taskClaimSchema,
  taskPrioritySchema,
  taskRefSchema,
  taskStatusSchema,
} from "./task.js";
import { dropEmptyQueryValues, refineTaskFilters, taskFilterFields } from "./task-query.js";

/**
 * `GET /floor` — one compact snapshot of everything in scope, for the floor
 * view (`docs/pages/Floor_And_Logbook_Plan.md`).
 *
 * The list endpoint is the wrong shape for it: it pages at 100 rows and carries
 * no dependency edges, while the floor has to lay out every open task at once
 * and draw what blocks what. Filters do not remove rows here — they *mark*
 * them (`matches`), because the floor dims non-matching tasks in place so that
 * nothing moves when a filter changes.
 */

/** How far back the Shipped shelf reaches. Older closed tasks are only counted. */
export const FLOOR_SHIPPED_WINDOWS = ["24h", "7d"] as const;
export const floorShippedWindowSchema = z.enum(FLOOR_SHIPPED_WINDOWS);
export type FloorShippedWindow = z.infer<typeof floorShippedWindowSchema>;
export const DEFAULT_FLOOR_SHIPPED_WINDOW: FloorShippedWindow = "24h";

/**
 * Most rows one snapshot returns. Above it, `meta.truncated` is true and rows
 * are chosen must-show first (needs a human, in progress, blocked, urgent),
 * then by priority and recency; `meta.statusCounts` still counts everything.
 */
export const FLOOR_TASK_CAP = 2000;

export const floorQuerySchema = z.preprocess(
  dropEmptyQueryValues,
  z
    .object({
      ...taskFilterFields,
      shipped: floorShippedWindowSchema.default(DEFAULT_FLOOR_SHIPPED_WINDOW),
      /**
       * Replay: the floor as it stood at this instant, rebuilt from
       * `task.status_changed` events. Only status and existence are replayed —
       * titles, priority, and labels are today's values. Claims are null.
       */
      at: z.iso.datetime({ offset: true }).optional(),
    })
    .strict()
    .superRefine(refineTaskFilters),
);
export type FloorQuery = z.infer<typeof floorQuerySchema>;
export type FloorQueryInput = z.input<typeof floorQuerySchema>;

/** Which of the filter params count as "a filter is active" — scope (`project`) does not. */
export const FLOOR_FILTER_KEYS = [
  "status",
  "priority",
  "label",
  "assignee",
  "assigneeIsNull",
  "createdBy",
  "claimedBy",
  "parentId",
  "parentIsNull",
  "attention",
  "dependsOn",
  "dependencyOf",
  "q",
  "createdFrom",
  "createdTo",
] as const;

/** One crate. A trimmed `TaskSummary` plus the derived graph numbers. */
export const floorTaskSchema = z
  .object({
    id: z.number().int().positive(),
    reference: z.string(),
    title: z.string(),
    status: taskStatusSchema,
    statusNote: z.string().nullable(),
    priority: taskPrioritySchema,
    project: z.string().nullable(),
    assignee: z.string().nullable(),
    /** Sorted. */
    labels: z.array(z.string()),
    parentId: z.number().int().positive().nullable(),
    childCount: z.number().int().nonnegative(),
    createdBy: storedActorSchema,
    /** Null when the lease has expired as well as when there is none. */
    claim: taskClaimSchema.nullable(),
    /** The first GitHub pull-request link, if any. */
    pullRequestUrl: z.string().nullable(),
    version: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    /** Unfinished tasks this one waits on (a `deferred` blocker still counts). */
    openBlockerCount: z.number().int().nonnegative(),
    /** Open tasks downstream of this one, transitively. The bottleneck score. */
    unblocksCount: z.number().int().nonnegative(),
    /** Matches the filter params. Always true when none are sent. */
    matches: z.boolean(),
  })
  .strict();
export type FloorTask = z.infer<typeof floorTaskSchema>;

/**
 * `blockerId` blocks `dependentId`. `satisfied` once the blocker is `done`.
 * Every edge touching a returned task is included; an end that is not in
 * `tasks` (another project, a closed task outside the window) is in `refs`.
 */
export const floorEdgeSchema = z
  .object({
    blockerId: z.number().int().positive(),
    dependentId: z.number().int().positive(),
    satisfied: z.boolean(),
  })
  .strict();
export type FloorEdge = z.infer<typeof floorEdgeSchema>;

export const floorSnapshotSchema = z
  .object({
    tasks: z.array(floorTaskSchema),
    edges: z.array(floorEdgeSchema),
    /** Tasks referenced by an edge or a `parentId` but not in `tasks`. */
    refs: z.array(taskRefSchema),
    meta: z
      .object({
        /** Tasks in scope, before the cap, including every older closed one. */
        total: z.number().int().nonnegative(),
        truncated: z.boolean(),
        /** Done/deferred tasks closed before `shippedSince` — the "+212 in the Logbook" crate. */
        olderClosedCount: z.number().int().nonnegative(),
        /** Every status key present, counting everything in scope. */
        statusCounts: z.record(z.enum(TASK_STATUSES), z.number().int().nonnegative()),
        /** Rows with `matches: true`. */
        matchCount: z.number().int().nonnegative(),
        shippedSince: z.iso.datetime(),
        /** Echo of `at`; null for the live floor. */
        at: z.iso.datetime().nullable(),
        /** Highest event id at snapshot time — start polling `GET /events?after=` from here. */
        lastEventId: z.number().int().nonnegative(),
        generatedAt: z.iso.datetime(),
      })
      .strict(),
  })
  .strict();
export type FloorSnapshot = z.infer<typeof floorSnapshotSchema>;
