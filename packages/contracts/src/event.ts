import { z } from "zod";
import { storedActorSchema } from "./actor.js";
import { projectSchema } from "./task.js";
import { TASK_ID_MAX_DIGITS } from "./reference.js";
import { dropEmptyQueryValues, repeatable, taskIdQuerySchema } from "./task-query.js";

/**
 * The events feed — an append-only log of every write, and the way agents and
 * the web app notice changes without websockets. See `docs/features/Task_Workflow_API.md` § Events.
 *
 * Events outlive their task: `taskId` is a plain column, not a foreign key, so a
 * `task.deleted` event is still readable after the row it describes is gone.
 */

export const TASK_EVENT_TYPES = [
  "task.created",
  "task.updated",
  "task.deleted",
  "task.status_changed",
  "task.claimed",
  "task.released",
  "comment.created",
  "comment.deleted",
  "decision.requested",
  "decision.answered",
  "decision.withdrawn",
  "dependency.added",
  "dependency.removed",
  "github.pull_request",
] as const;
export const taskEventTypeSchema = z.enum(TASK_EVENT_TYPES);
export type TaskEventType = z.infer<typeof taskEventTypeSchema>;

/**
 * `payload` is type-specific and deliberately loose on the wire (`record`), the
 * same way `error.details` is: a consumer branches on `type` first. The shapes
 * each type carries are listed in the feature doc — e.g. `task.status_changed`
 * carries `{ from, to, note }`, `task.updated` carries `{ fields: [...] }`.
 */
export const taskEventSchema = z
  .object({
    id: z.number().int().positive(),
    taskId: z.number().int().positive(),
    /**
     * The task's **current** title, joined in at read time — unlike `project`
     * this is not stamped on the event, so it reflects the latest rename.
     * `null` when the task has since been deleted (`taskId` is not a foreign
     * key; events outlive their task).
     */
    taskTitle: z.string().nullable(),
    /**
     * The task's project **when the event was recorded** — stored on the event,
     * not joined, so the feed can still be filtered by project after the task
     * is deleted or moved to another project.
     */
    project: z.string().nullable(),
    type: taskEventTypeSchema,
    actor: storedActorSchema,
    payload: z.record(z.string(), z.unknown()),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type TaskEvent = z.infer<typeof taskEventSchema>;

export const EVENTS_DEFAULT_LIMIT = 50;
export const EVENTS_MAX_LIMIT = 200;

const cursorSchema = z
  .string()
  .regex(new RegExp(`^\\d{1,${TASK_ID_MAX_DIGITS}}$`), "Expected an event id")
  .transform(Number);

/**
 * `GET /events` — cursor-paged, oldest first. Poll with `after` set to the last
 * `nextAfter` you saw to receive only what happened since.
 *
 * Empty values are dropped first, exactly as on the list query, so `?after=`
 * means "from the beginning" rather than a 422.
 *
 * Cursor paging rather than `page`/`pageSize`: the feed grows while being read,
 * and an offset page would shift under a poller and skip events.
 */
export const eventsQuerySchema = z.preprocess(
  dropEmptyQueryValues,
  z
    .object({
      /** `0` is valid: "from the beginning". */
      after: cursorSchema.optional(),
      /** Only events with an id below this one — paging backwards with `order=desc`. */
      before: cursorSchema.optional(),
      /**
       * `asc` (default) is the poller's order. `desc` is the Logbook's: newest
       * first, paged with `before=<meta.nextBefore>`.
       */
      order: z.enum(["asc", "desc"]).default("asc"),
      /** Instants (ISO 8601 with offset). `from` inclusive, `to` exclusive. */
      from: z.iso.datetime({ offset: true }).optional(),
      to: z.iso.datetime({ offset: true }).optional(),
      taskId: taskIdQuerySchema.optional(),
      /** Events of tasks in any of these projects (as recorded on the event). */
      project: repeatable(projectSchema),
      /** Exact actor, lowercased like the stored value. */
      actor: z.string().trim().toLowerCase().min(1).max(80).optional(),
      /** Any of these event types. */
      type: repeatable(taskEventTypeSchema),
      limit: z.coerce.number().int().min(1).max(EVENTS_MAX_LIMIT).default(EVENTS_DEFAULT_LIMIT),
    })
    .strict(),
);
export type EventsQuery = z.infer<typeof eventsQuerySchema>;
export type EventsQueryInput = z.input<typeof eventsQuerySchema>;

/**
 * The one list response that is not `{ data, meta: { page, … } }`: a cursor
 * feed has no total and no page count. `nextAfter` is the id to pass as `after`
 * next time — equal to the incoming `after` when nothing new happened, so a
 * poller can always just feed it back.
 */
export const eventsResponseSchema = z
  .object({
    data: z.array(taskEventSchema),
    meta: z
      .object({
        nextAfter: z.number().int().nonnegative(),
        /**
         * With `order=desc`: the smallest id on this page, to pass as `before`
         * for the next (older) page; null when the page is empty. Always null
         * with `order=asc`.
         */
        nextBefore: z.number().int().positive().nullable(),
        hasMore: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type EventsResponse = z.infer<typeof eventsResponseSchema>;
