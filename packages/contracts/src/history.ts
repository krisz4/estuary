import { z } from "zod";
import { storedActorSchema } from "./actor.js";
import { TASK_STATUSES, projectSchema, taskStatusSchema } from "./task.js";
import { dropEmptyQueryValues, repeatable } from "./task-query.js";

/**
 * `GET /stats/history` — everything the Logbook's charts need, computed from
 * the events feed (`task.created`, `task.status_changed`, `task.claimed`,
 * `task.released`, `decision.*`). See `docs/pages/Floor_And_Logbook_Plan.md`.
 */

export const HISTORY_BUCKETS = ["hour", "day", "week"] as const;
export const historyBucketSchema = z.enum(HISTORY_BUCKETS);
export type HistoryBucket = z.infer<typeof historyBucketSchema>;

/** More buckets than this is a request bug (e.g. `bucket=hour` over a year). */
export const HISTORY_MAX_BUCKETS = 400;
/** Rows in `cycleTimes`; the most recent ones win. */
export const HISTORY_MAX_CYCLE_TIMES = 500;
/** Rows in `longestWaits`. */
export const HISTORY_LONGEST_WAITS = 10;

/** The statuses where a task waits on a human; time spent in them is "human wait". */
export const HUMAN_WAIT_STATUSES = [
  "needs_user_decision",
  "needs_user_action",
  "needs_qa",
] as const satisfies readonly (typeof TASK_STATUSES)[number][];

/**
 * `from` defaults to 7 days before `to`; `to` defaults to now. Both are instants
 * (ISO 8601 with offset). Buckets are aligned to UTC boundaries.
 */
export const historyQuerySchema = z.preprocess(
  dropEmptyQueryValues,
  z
    .object({
      project: repeatable(projectSchema),
      from: z.iso.datetime({ offset: true }).optional(),
      to: z.iso.datetime({ offset: true }).optional(),
      bucket: historyBucketSchema.default("day"),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.from !== undefined && value.to !== undefined && Date.parse(value.from) >= Date.parse(value.to)) {
        ctx.addIssue({ code: "custom", path: ["to"], message: "to must be after from" });
      }
    }),
);
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export type HistoryQueryInput = z.input<typeof historyQuerySchema>;

const minutesStatsSchema = z
  .object({
    count: z.number().int().nonnegative(),
    /** Null when `count` is 0. */
    medianMinutes: z.number().nonnegative().nullable(),
    p90Minutes: z.number().nonnegative().nullable(),
  })
  .strict();

export const historyBucketRowSchema = z
  .object({
    start: z.iso.datetime(),
    end: z.iso.datetime(),
    created: z.number().int().nonnegative(),
    /** Transitions into `done`. */
    completed: z.number().int().nonnegative(),
    deferred: z.number().int().nonnegative(),
    /** Transitions out of `needs_qa` to anything but `done` / `deferred`. */
    sentBack: z.number().int().nonnegative(),
    /** Tasks per status at the bucket's end — the cumulative flow diagram. Every key present. */
    statusCounts: z.record(z.enum(TASK_STATUSES), z.number().int().nonnegative()),
    /** Stints in a human-wait status that *ended* in this bucket. */
    humanWait: minutesStatsSchema,
  })
  .strict();
export type HistoryBucketRow = z.infer<typeof historyBucketRowSchema>;

/** One pass from `in_progress` to `needs_qa` or `done` that finished in range. */
export const cycleTimeSchema = z
  .object({
    taskId: z.number().int().positive(),
    reference: z.string(),
    /** Null when the task was deleted since. */
    title: z.string().nullable(),
    /** Who moved it out of `in_progress`. */
    actor: storedActorSchema,
    minutes: z.number().nonnegative(),
    finishedAt: z.iso.datetime(),
  })
  .strict();
export type CycleTime = z.infer<typeof cycleTimeSchema>;

/** A stint in a human-wait status that overlaps the range. `endedAt` null = still waiting. */
export const humanWaitSchema = z
  .object({
    taskId: z.number().int().positive(),
    reference: z.string(),
    title: z.string().nullable(),
    status: taskStatusSchema,
    minutes: z.number().nonnegative(),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().nullable(),
  })
  .strict();
export type HumanWait = z.infer<typeof humanWaitSchema>;

export const agentHistorySchema = z
  .object({
    actor: storedActorSchema,
    /** Transitions into `needs_qa` made by this actor. */
    submitted: z.number().int().nonnegative(),
    /** Of the tasks this actor submitted, how many then went `needs_qa → done` in range. */
    approved: z.number().int().nonnegative(),
    /** …and how many were sent back instead. */
    sentBack: z.number().int().nonnegative(),
    decisionsRequested: z.number().int().nonnegative(),
    claims: z.number().int().nonnegative(),
    releases: z.number().int().nonnegative(),
  })
  .strict();
export type AgentHistory = z.infer<typeof agentHistorySchema>;

export const historyResponseSchema = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    bucket: historyBucketSchema,
    buckets: z.array(historyBucketRowSchema),
    totals: z
      .object({
        created: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
        deferred: z.number().int().nonnegative(),
        sentBack: z.number().int().nonnegative(),
        decisionsRequested: z.number().int().nonnegative(),
        decisionsAnswered: z.number().int().nonnegative(),
        humanWait: minutesStatsSchema,
        cycleTime: minutesStatsSchema,
      })
      .strict(),
    /** Newest first, at most `HISTORY_MAX_CYCLE_TIMES`. */
    cycleTimes: z.array(cycleTimeSchema),
    /** Longest first, at most `HISTORY_LONGEST_WAITS`. */
    longestWaits: z.array(humanWaitSchema),
    /** Actors starting `agent:` that did anything in range, most submitted first. */
    agents: z.array(agentHistorySchema),
  })
  .strict();
export type HistoryResponse = z.infer<typeof historyResponseSchema>;
