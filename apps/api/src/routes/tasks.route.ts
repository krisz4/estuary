import {
  addDependencyInputSchema,
  answerDecisionInputSchema,
  claimTaskInputSchema,
  cleanupDoneTasksInputSchema,
  createTaskInputSchema,
  hasAtLeastOneField,
  nextTaskInputSchema,
  releaseTaskInputSchema,
  taskListQuerySchema,
  taskStatsQuerySchema,
  transitionInputSchema,
  updateTaskInputSchema,
} from "@estuary/contracts";
import { Router } from "express";

import { asyncHandler } from "../lib/asyncHandler.js";
import { atLeastOneField, validationError } from "../lib/errors.js";
import { parseTaskId } from "../lib/params.js";
import {
  createTask,
  deleteTask,
  getTask,
  getTaskFacets,
  getTaskStats,
  updateTask,
} from "../services/task.service.js";
import { cleanupDoneTasks } from "../services/task-cleanup.service.js";
import { listTasks } from "../services/task-query.js";
import {
  addDependency,
  answerDecision,
  claimTask,
  heartbeatTask,
  nextTask,
  releaseTask,
  removeDependency,
  transitionTask,
} from "../services/task-workflow.service.js";

/**
 * `/api/v1/tasks` — the HTTP layer for the task resource.
 *
 * Each handler does three things and nothing else: **parse, call a service,
 * send.** There is no Prisma import in this file and there cannot be one — the
 * layer rule in `docs/engineering/ARCHITECTURE.md` is what keeps the services
 * testable without a server, and `src/routes/layers.test.ts` asserts it
 * mechanically rather than trusting review.
 *
 * Responses are what the service returned. `services/task.service.ts` returns
 * **serialized contract types**, not Prisma rows, so no handler here can forget
 * `lib/serialize.ts` and leak a `Date` or a rank column onto the wire.
 *
 * Validation is `.parse()`, not `safeParse` + a hand-built response: a
 * `ZodError` reaching `errorHandler` becomes `VALIDATION_ERROR` 422 with
 * per-field `details` already. The one deliberate exception is the path
 * parameter — see `lib/params.ts`, where a parse failure becomes a 404.
 */

export const tasksRouter: Router = Router();

/* ------------------------------------------------------------------ *
 * Read
 * ------------------------------------------------------------------ */

/**
 * `GET /tasks` — filter, sort, page. The whole query surface is one schema
 * parse; `services/task-query.ts` receives a fully validated, defaulted object
 * and never sees a raw string.
 *
 * `.strict()` on that schema means an unknown param is a 422 rather than a
 * silently ignored filter, and `pageSize=101` is **rejected, not clamped** — a
 * client asking for 500 rows has a bug worth surfacing rather than papering over.
 */
tasksRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = taskListQuerySchema.parse(req.query);
    res.status(200).json(await listTasks(query));
  }),
);

/**
 * `GET /tasks/facets` — **declared before `/:taskId`, and the order is
 * load-bearing.** Express matches in declaration order, so with these two
 * swapped, `facets` is captured as `:taskId`, fails the decimal-digits parse,
 * and comes back as a 404 `TASK_NOT_FOUND` — a routing bug wearing a
 * not-found error's clothes, on the endpoint the list page calls to populate its
 * assignee filter. `layers.test.ts` pins the order; a route test proves the
 * behaviour.
 */
tasksRouter.get(
  "/facets",
  asyncHandler(async (_req, res) => {
    res.status(200).json(await getTaskFacets());
  }),
);

/**
 * `GET /tasks/stats` — count per status plus the inbox size. Declared before
 * `/:taskId` for the same reason `/facets` is.
 */
tasksRouter.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const query = taskStatsQuerySchema.parse(req.query);
    res.status(200).json(await getTaskStats(query.project));
  }),
);

/** `GET /tasks/:taskId` — one task with its full comment thread. */
tasksRouter.get(
  "/:taskId",
  asyncHandler(async (req, res) => {
    const id = parseTaskId(req.params.taskId);
    res.status(200).json(await getTask(id));
  }),
);

/* ------------------------------------------------------------------ *
 * Write
 * ------------------------------------------------------------------ */

/**
 * `POST /tasks` — **201 with a `Location` header**, per the error contract's
 * status conventions.
 *
 * The header is built from `req.baseUrl` rather than a hard-coded `/api/v1`
 * string: the prefix is chosen by the mount in `app.ts`, and a second copy of it
 * here would point at the old path the day that mount moves.
 */
tasksRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createTaskInputSchema.parse(req.body);
    const { task, created } = await createTask(input, req.actor);

    // A replayed `idempotencyKey` is a 200: nothing was created by this request.
    res
      .status(created ? 201 : 200)
      .location(`${req.baseUrl}/${task.id}`)
      .json(task);
  }),
);

/**
 * `POST /tasks/next` — claim the best available task. A literal segment, so it
 * cannot collide with `/:taskId` (which has no POST) — but it is declared up
 * here with the other collection-level routes all the same.
 */
tasksRouter.post(
  "/next",
  asyncHandler(async (req, res) => {
    const input = nextTaskInputSchema.parse(req.body ?? {});
    res.status(200).json({ task: await nextTask(input, req.actor) });
  }),
);

/**
 * `POST /tasks/cleanup` — hard-delete `done` tasks in bulk, humans only. A
 * literal segment like `/next`; `dryRun: true` returns the same shape without
 * deleting anything. See `docs/features/Task_Cleanup.md`.
 */
tasksRouter.post(
  "/cleanup",
  asyncHandler(async (req, res) => {
    const input = cleanupDoneTasksInputSchema.parse(req.body ?? {});
    res.status(200).json(await cleanupDoneTasks(input, req.actor));
  }),
);

/**
 * `PATCH /tasks/:taskId` — partial update. `PUT` is deliberately absent: the
 * UI only ever sends partial edits, and offering both invites two write paths
 * that drift.
 *
 * **`{}` is valid to zod and invalid to the API**, which is why the emptiness
 * check is here rather than a `.refine()` on the schema. A refinement would
 * collapse it into `VALIDATION_ERROR`; the contract gives an empty PATCH its own
 * code, `AT_LEAST_ONE_FIELD` (422), with no field details — there is no field to
 * point at. `hasAtLeastOneField()` is exported from contracts so the web form can
 * make the same call before it ever sends the request.
 *
 * Order matters: parse first, then check. A body of `{ title: "x" }` is a
 * `VALIDATION_ERROR` (too short), not `AT_LEAST_ONE_FIELD`.
 */
tasksRouter.patch(
  "/:taskId",
  asyncHandler(async (req, res) => {
    const id = parseTaskId(req.params.taskId);
    // `.strict()` would reject this too, as an anonymous "unrecognized key". An
    // agent that tries it deserves to be told where status changes go instead.
    if (typeof req.body === "object" && req.body !== null && "status" in req.body) {
      throw validationError({
        status: ["Status is not PATCHable. Use POST /tasks/:taskId/transition"],
      });
    }
    const input = updateTaskInputSchema.parse(req.body);
    if (!hasAtLeastOneField(input)) throw atLeastOneField();

    res.status(200).json(await updateTask(id, input, req.actor));
  }),
);

/**
 * `DELETE /tasks/:taskId` — hard delete, comments cascade at the database
 * level.
 *
 * **204 and no body.** A JSON body on a 204 is a protocol violation that some
 * clients choke on, so this is `res.status(204).end()`, never `.json(...)`.
 */
tasksRouter.delete(
  "/:taskId",
  asyncHandler(async (req, res) => {
    const id = parseTaskId(req.params.taskId);
    await deleteTask(id, req.actor);
    res.status(204).end();
  }),
);

/* ------------------------------------------------------------------ *
 * Workflow
 *
 * Status changes, claims, decisions, dependencies. Each handler is the same
 * parse → service → send; the rules are in `services/task-workflow.service.ts`
 * and `docs/features/Task_Workflow_API.md`.
 * ------------------------------------------------------------------ */

/** `POST /tasks/:taskId/transition` — the only way a status changes. */
tasksRouter.post(
  "/:taskId/transition",
  asyncHandler(async (req, res) => {
    const id = parseTaskId(req.params.taskId);
    const input = transitionInputSchema.parse(req.body);
    res.status(200).json(await transitionTask(id, input, req.actor));
  }),
);

tasksRouter.post(
  "/:taskId/claim",
  asyncHandler(async (req, res) => {
    const id = parseTaskId(req.params.taskId);
    const input = claimTaskInputSchema.parse(req.body ?? {});
    res.status(200).json(await claimTask(id, input.expectedVersion, req.actor));
  }),
);

tasksRouter.post(
  "/:taskId/heartbeat",
  asyncHandler(async (req, res) => {
    const id = parseTaskId(req.params.taskId);
    res.status(200).json(await heartbeatTask(id, req.actor));
  }),
);

tasksRouter.post(
  "/:taskId/release",
  asyncHandler(async (req, res) => {
    const id = parseTaskId(req.params.taskId);
    const input = releaseTaskInputSchema.parse(req.body ?? {});
    res.status(200).json(await releaseTask(id, input, req.actor));
  }),
);

tasksRouter.post(
  "/:taskId/decision/answer",
  asyncHandler(async (req, res) => {
    const id = parseTaskId(req.params.taskId);
    const input = answerDecisionInputSchema.parse(req.body);
    res.status(200).json(await answerDecision(id, input, req.actor));
  }),
);

tasksRouter.post(
  "/:taskId/dependencies",
  asyncHandler(async (req, res) => {
    const id = parseTaskId(req.params.taskId);
    const input = addDependencyInputSchema.parse(req.body);
    res.status(200).json(await addDependency(id, input.dependsOnId, req.actor));
  }),
);

/**
 * `DELETE /tasks/:taskId/dependencies/:dependsOnId` — **200 with the task**,
 * unlike the other DELETEs: nothing is deleted from the caller's point of view
 * except an edge, and the task it changed is what they need next.
 *
 * A malformed `:dependsOnId` is a 404 `TASK_NOT_FOUND`, parsed the same way as
 * `:taskId`.
 */
tasksRouter.delete(
  "/:taskId/dependencies/:dependsOnId",
  asyncHandler(async (req, res) => {
    const id = parseTaskId(req.params.taskId);
    const dependsOnId = parseTaskId(req.params.dependsOnId);
    res.status(200).json(await removeDependency(id, dependsOnId, req.actor));
  }),
);
