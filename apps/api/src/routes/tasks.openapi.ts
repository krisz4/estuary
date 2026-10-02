import {
  DEFAULT_TASK_SORT,
  MAX_PAGE_SIZE,
  SORT_DIRECTIONS,
  TASK_SORT_FIELDS,
  addDependencyInputSchema,
  answerDecisionInputSchema,
  claimTaskInputSchema,
  cleanupDoneTasksInputSchema,
  createTaskInputSchema,
  nextTaskInputSchema,
  releaseTaskInputSchema,
  taskIdParamSchema,
  taskListQuerySchema,
  taskStatsQuerySchema,
  transitionInputSchema,
  updateTaskInputSchema,
} from "@estuary/contracts";
import { z } from "zod";

import {
  ACTOR_422_NOTE,
  CleanupDoneTasksResponseComponent,
  NextTaskResponseComponent,
  PaginatedTasksComponent,
  TaskComponent,
  TaskFacetsComponent,
  TaskStatsComponent,
  bodyParserResponses,
  describeQueryParams,
  errorResponse,
  registerV1Path,
  unwrapPreprocessedObject,
} from "../lib/openapi.js";

/**
 * OpenAPI definitions for `routes/tasks.route.ts` — the task resource and the
 * workflow endpoints hanging off it. Behaviour: `docs/features/Task_Workflow_API.md`.
 *
 * One registration module per router, per `docs/features/API_Documentation.md`.
 * Nothing here is imported by the router itself — a spec that the handlers
 * depended on would be a spec that could not be wrong, but only because it would
 * have become the implementation. The link between the two is asserted instead,
 * by `routes/openapi.contract.test.ts`, which compares the documented paths
 * against the routes actually mounted on the app.
 *
 * **Everything is exported as a function, and nothing runs at import time.**
 * Building the query parameters means calling `unwrapPreprocessedObject()`,
 * which reads zod internals and throws by design when they change shape. At
 * module scope that throw happens while `app.ts`'s import graph is still
 * loading, so a `zod ^4` patch bump would take down **process startup** — on
 * deployments that set `DOCS_ENABLED=false` and never wanted a spec at all. As a
 * function it can only throw inside `getOpenApiDocument()`, which is reached
 * from the `/docs` router and the generator script and nowhere else.
 *
 * Every operation goes through `registerV1Path`, which adds the `X-Actor`
 * header, the optional bearer requirement, and the 401 / 500 / default
 * responses. The error responses listed here are the ones **this operation's
 * own code** can produce.
 */

/** `taskIdParamSchema` is the parser the route uses. */
const taskIdParam = (): z.ZodObject =>
  z.object({
    taskId: taskIdParamSchema.meta({
      description:
        "Task id, which is also the task number: 42 is TASK-000042. Decimal digits only — a non-numeric segment is a 404, never a 422.",
      example: 42,
    }),
  });

const jsonBody = (schema: z.ZodType, required = true) => ({
  required,
  content: { "application/json": { schema } },
});

const taskResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: TaskComponent } },
});

const TASK_404 = () =>
  errorResponse(
    "No such task — or an id that is not decimal digits, which is deliberately indistinguishable from a missing one.",
    ["TASK_NOT_FOUND"],
  );

const VALIDATION_422 = (what: string) =>
  errorResponse(`${what} \`details\` maps field name to messages. ${ACTOR_422_NOTE}`, [
    "VALIDATION_ERROR",
  ]);

const CLAIMED =
  "TASK_ALREADY_CLAIMED: another agent holds a live claim on the task — `details: { claimedBy, expiresAt }`. Humans are never refused this way.";
const VERSION =
  "VERSION_CONFLICT: `expectedVersion` did not match, or a concurrent write landed between read and write — `details: { expected, current }`. Re-read and retry.";

/* ------------------------------------------------------------------ *
 * Query parameters
 * ------------------------------------------------------------------ */

export const QUERY_DESCRIPTIONS: Record<string, string> = {
  page: "1-based page number.",
  pageSize: `Rows per page. Values above ${MAX_PAGE_SIZE} are **rejected with a 422, not clamped** — a client asking for 500 rows has a bug worth surfacing.`,
  sort: `Sort clause, "field:direction". Sorting by status or priority orders by lifecycle and severity, not alphabetically.`,
  status: "Repeatable. Values within one parameter OR together; different parameters AND together.",
  priority: "Repeatable, same OR/AND rule as status.",
  project:
    "Repeatable, same OR/AND rule as status. A lowercase slug; the input is lowercased before matching, so Estuary finds estuary.",
  label:
    "Repeatable, same OR/AND rule as status. Tasks carrying at least one of these labels — a label narrows work inside a project (a monorepo workspace, a kind of work). Send a value from GET /tasks/facets.",
  assignee:
    "Exact, case-sensitive match. Send a value from GET /tasks/facets rather than something a user typed. Mutually exclusive with assigneeIsNull.",
  assigneeIsNull: "true returns unassigned tasks only. Mutually exclusive with assignee.",
  createdBy:
    "Exact actor that created the task, e.g. agent:claude-code. Lowercased before matching, like the stored value; GET /tasks/facets lists the creators present.",
  claimedBy:
    "Exact actor holding the task's claim, e.g. agent:claude-code — lowercased before matching. Matches the stored holder even after the lease expired, so an agent can find the work it was doing before a crash.",
  attention:
    "true returns everything waiting on a person — needs_user_decision, needs_user_action, needs_qa, needs_refinement, agent-filed backlog/todo nobody has triaged yet (needsTriage), and tasks blocked on an outside reason only (no unfinished dependency). false returns the rest. GET /tasks/stats counts the same set as needsAttention.",
  parentId: "Only the direct subtasks of this task id. Decimal digits only.",
  parentIsNull:
    "true returns only top-level tasks (no parent); false returns only subtasks. Mutually exclusive with parentId.",
  dependsOn:
    'Tasks that depend on this task id — its dependents ("who waits on 42?"). Decimal digits only.',
  dependencyOf:
    'Tasks this task id depends on — its dependencies ("what does 42 wait on?"). Decimal digits only.',
  q: 'Free-text search: whitespace-separated terms (a "quoted phrase" is one term), every term must match (ANDed with each other and with every other filter, never widening past them). A term matches a task if it appears anywhere in the title, description, acceptance criteria, status note, links, or the body of any comment on it — case-insensitive. A term that parses as a task reference (TASK-000042, #42, 42) also matches that task by id.',
  createdFrom: "Inclusive lower bound, YYYY-MM-DD, UTC.",
  createdTo: "Inclusive upper bound, YYYY-MM-DD, UTC — the named day is included.",
};

/**
 * `sort` is the one parameter whose validated type is not its wire type: the
 * schema transforms `"createdAt:desc"` into `{ field, direction }`, and
 * documenting the parsed object would tell a reader to send JSON in a query
 * string. Everything else is documented straight off the real schema.
 */
export const QUERY_OVERRIDES: Record<string, z.ZodType> = {
  sort: z
    .enum(
      TASK_SORT_FIELDS.flatMap((field) =>
        SORT_DIRECTIONS.map((direction) => `${field}:${direction}` as const),
      ) as unknown as [string, ...string[]],
    )
    .default(DEFAULT_TASK_SORT),
};

/**
 * A function, not a constant. See the note at the top of the file: the unwrap it
 * performs is the one operation in this module that can throw, and it must not
 * be able to throw during module evaluation.
 */
export const buildTaskListQueryParams = (): z.ZodObject =>
  describeQueryParams(
    unwrapPreprocessedObject(taskListQuerySchema),
    QUERY_DESCRIPTIONS,
    QUERY_OVERRIDES,
  );

export const STATS_QUERY_DESCRIPTIONS: Record<string, string> = {
  project: "Repeatable. Count only tasks in these projects; omit to count every task.",
};

export const buildTaskStatsQueryParams = (): z.ZodObject =>
  describeQueryParams(unwrapPreprocessedObject(taskStatsQuerySchema), STATS_QUERY_DESCRIPTIONS);

/* ------------------------------------------------------------------ *
 * Paths — the resource
 * ------------------------------------------------------------------ */

function registerResourcePaths(): void {
  const taskId = taskIdParam();

  registerV1Path({
    method: "get",
    path: "/api/v1/tasks",
    tags: ["Tasks"],
    summary: "List tasks",
    description:
      "Filter, sort, and page. Unknown query parameters are rejected rather than ignored — a typo'd filter silently returning everything is worse than an error. Rows are TaskSummary: the open decision, the unfinished-dependency count, and the live claim are inline.",
    request: { query: buildTaskListQueryParams() },
    responses: {
      200: {
        description: "A page of tasks and its pagination metadata.",
        content: { "application/json": { schema: PaginatedTasksComponent } },
      },
      422: VALIDATION_422(
        "A parameter failed validation: an unknown parameter, pageSize above the maximum, an unknown sort field, a project that is not a slug, an inverted date range, or assignee together with assigneeIsNull.",
      ),
    },
  });

  registerV1Path({
    method: "post",
    path: "/api/v1/tasks",
    tags: ["Tasks"],
    summary: "Create a task",
    description: [
      "`status` may be backlog (the default), needs_refinement, or todo — anything else is reached with a transition after creating. `todo` requires `acceptanceCriteria`.",
      "",
      "**Idempotent with `idempotencyKey`.** A repeated key returns the task the first request created, with **200** instead of 201, and changes nothing — even if the rest of the body differs. Agents should always send one, derived from what the task is about.",
      "",
      "`createdBy` is the X-Actor header. A body carrying any server-owned field is rejected rather than silently stripped.",
    ].join("\n"),
    request: { body: jsonBody(createTaskInputSchema) },
    responses: {
      200: taskResponse(
        "Idempotent replay: a task with this idempotencyKey already exists, and this is it, unchanged.",
      ),
      201: {
        ...taskResponse("Created. The Location header points at the new task."),
        headers: {
          Location: {
            description: "URL of the created task.",
            schema: { type: "string", example: "/api/v1/tasks/64" },
          },
        },
      },
      ...bodyParserResponses(),
      422: VALIDATION_422(
        "A field failed validation (including todo without acceptanceCriteria, or a parentId naming a task that does not exist), or the body carried a server-owned field.",
      ),
    },
  });

  registerV1Path({
    method: "get",
    path: "/api/v1/tasks/facets",
    tags: ["Tasks"],
    summary: "Filter options present in the data",
    description:
      "Declared before /tasks/{taskId} in the router, so `facets` is not captured as an id. The only safe source of values for the assignee, project, label, and createdBy filters, which match exactly.",
    responses: {
      200: {
        description: "Distinct non-null assignees, projects, labels, and creators, sorted.",
        content: { "application/json": { schema: TaskFacetsComponent } },
      },
      422: VALIDATION_422("Only the X-Actor header can fail here."),
    },
  });

  registerV1Path({
    method: "get",
    path: "/api/v1/tasks/stats",
    tags: ["Tasks"],
    summary: "Task counts per status",
    description:
      "Every status is present in byStatus, zero included, so a client can index it without a fallback. needsAttention is the inbox size — the count of GET /tasks?attention=true. Declared before /tasks/{taskId} for the same reason /facets is.",
    request: { query: buildTaskStatsQueryParams() },
    responses: {
      200: {
        description: "Counts per status plus needsAttention.",
        content: { "application/json": { schema: TaskStatsComponent } },
      },
      422: VALIDATION_422("An unknown parameter, or a project that is not a slug."),
    },
  });

  registerV1Path({
    method: "get",
    path: "/api/v1/tasks/{taskId}",
    tags: ["Tasks"],
    summary: "Get one task",
    description:
      "Includes the comment thread (oldest first), the decision history (newest first), parent, children, dependencies, and dependents.",
    request: { params: taskId },
    responses: {
      200: taskResponse("The task with its thread and relations."),
      404: TASK_404(),
      422: VALIDATION_422("Only the X-Actor header can fail here."),
    },
  });

  registerV1Path({
    method: "patch",
    path: "/api/v1/tasks/{taskId}",
    tags: ["Tasks"],
    summary: "Update a task",
    description: [
      "Partial update of everything except status; PUT is deliberately not implemented.",
      "",
      "**`status` is not PATCHable** — a body carrying it is a 422 pointing at POST /tasks/{taskId}/transition.",
      "A body whose every field equals the stored value performs **no write**: no version bump, no updatedAt move, no event.",
      "Clearing `assignee`, `project`, or `acceptanceCriteria` is done by sending an empty string or null. A `parentId` must exist and must not be the task itself or one of its descendants.",
    ].join("\n"),
    request: { params: taskId, body: jsonBody(updateTaskInputSchema) },
    responses: {
      200: taskResponse("The updated task (or the unchanged one, if nothing differed)."),
      ...bodyParserResponses(),
      404: TASK_404(),
      409: errorResponse(`${VERSION} ${CLAIMED}`, ["VERSION_CONFLICT", "TASK_ALREADY_CLAIMED"]),
      422: errorResponse(
        `A field failed validation, the body carried status, or it was empty. An empty body — or one with only expectedVersion — is AT_LEAST_ONE_FIELD, which carries no field details. ${ACTOR_422_NOTE}`,
        ["VALIDATION_ERROR", "AT_LEAST_ONE_FIELD"],
      ),
    },
  });

  registerV1Path({
    method: "post",
    path: "/api/v1/tasks/cleanup",
    tags: ["Tasks"],
    summary: "Delete done tasks in bulk",
    description: [
      'Hard-deletes tasks whose status is `done` — no other status is ever touched. Each deleted task gets a `task.deleted` event with `reason: "cleanup"`; comments, decisions, labels, and dependency rows cascade, and subtasks of a deleted parent survive as top-level tasks.',
      "",
      "- `project`: only these projects; omit for all.",
      "- `olderThanDays`: only tasks completed more than this many days ago; omit or 0 for every done task.",
      "- `dryRun`: return the count and ids without deleting.",
      "",
      "Humans only: an `agent:` actor is ACTOR_NOT_PERMITTED, dry run included. The API also runs this on its own for tasks done longer than `DONE_RETENTION_DAYS` (default 90), as `system:taskmanager`.",
    ].join("\n"),
    request: { body: jsonBody(cleanupDoneTasksInputSchema, false) },
    responses: {
      200: {
        description: "What was deleted, or would be on a dry run.",
        content: { "application/json": { schema: CleanupDoneTasksResponseComponent } },
      },
      ...bodyParserResponses(),
      403: errorResponse("The caller is an agent.", ["ACTOR_NOT_PERMITTED"]),
      422: VALIDATION_422(
        "An unknown field, a project that is not a slug, or olderThanDays outside 0–3650.",
      ),
    },
  });

  registerV1Path({
    method: "delete",
    path: "/api/v1/tasks/{taskId}",
    tags: ["Tasks"],
    summary: "Delete a task",
    description:
      "Hard delete. Comments, decisions, and dependency rows cascade; the task's events stay, and a task.deleted event is added. Blocked tasks that were waiting only on this one are moved to todo by the system.",
    request: { params: taskId },
    responses: {
      204: { description: "Deleted. No body." },
      404: errorResponse("No such task. Deleting twice is a 404, not a 500.", ["TASK_NOT_FOUND"]),
      409: errorResponse(CLAIMED, ["TASK_ALREADY_CLAIMED"]),
      422: VALIDATION_422("Only the X-Actor header can fail here."),
    },
  });
}

/* ------------------------------------------------------------------ *
 * Paths — the workflow
 * ------------------------------------------------------------------ */

function registerWorkflowPaths(): void {
  const taskId = taskIdParam();

  registerV1Path({
    method: "post",
    path: "/api/v1/tasks/next",
    tags: ["Workflow"],
    summary: "Claim the best available task",
    description: [
      "Atomically picks and claims one task for the caller, moving it to in_progress. Candidates, best first (priority descending, then oldest):",
      "",
      "- `todo` tasks whose dependencies are all `done`, and",
      '- `in_progress` tasks with no live claim — a crashed agent\'s work, noted as "Reclaimed from …".',
      "",
      "Filtered by `project`, `label` (any of), and `minPriority` when given. Two agents calling at once never receive the same task. Nothing available is `{ task: null }`, not an error.",
    ].join("\n"),
    request: { body: jsonBody(nextTaskInputSchema, false) },
    responses: {
      200: {
        description: "The claimed task, or { task: null }.",
        content: { "application/json": { schema: NextTaskResponseComponent } },
      },
      ...bodyParserResponses(),
      422: VALIDATION_422(
        "An unknown field, a project that is not a slug, or an unknown priority.",
      ),
    },
  });

  registerV1Path({
    method: "post",
    path: "/api/v1/tasks/{taskId}/transition",
    tags: ["Workflow"],
    summary: "Change a task's status",
    description: [
      "The only way a status changes. There is no from→to table: any status may move to any other, and **what the target requires is the shape of the payload**, discriminated on `to`:",
      "",
      "| to | requires |",
      "| -- | -------- |",
      "| needs_refinement | `reason` |",
      "| todo | `acceptanceCriteria`, unless the task already has some |",
      "| blocked | `reason` or a non-empty `blockedBy` (added as dependencies) |",
      "| needs_user_decision | `decision`: question, 2–6 options, optional recommendation |",
      "| needs_user_action | `instructions` |",
      "| needs_qa | `summary`; optional `links` are appended |",
      "| deferred | `reason` |",
      "",
      "The reason / instructions / summary / question becomes `statusNote`, replacing the previous one. Entering in_progress claims the task for the caller; leaving it drops the claim. Leaving needs_user_decision withdraws the open decision. Reaching done stamps completedAt and unblocks dependents whose dependencies are now all done. A needs_qa hand-off may carry concerns (what a reviewer must not miss; omit for routine work) and followUps, each filed as a needsTriage subtask — todo with acceptance criteria, needs_refinement without. A person's transition, a claim, done, or deferred clears needsTriage.",
      "",
      "An `agent:` actor may not move a task to done unless the server runs with AGENTS_MAY_COMPLETE=true.",
    ].join("\n"),
    request: { params: taskId, body: jsonBody(transitionInputSchema) },
    responses: {
      200: taskResponse("The task in its new status."),
      ...bodyParserResponses(),
      403: errorResponse(
        "ACTOR_NOT_PERMITTED: an agent tried to move the task to done while AGENTS_MAY_COMPLETE is off. Agents hand finished work to needs_qa.",
        ["ACTOR_NOT_PERMITTED"],
      ),
      404: TASK_404(),
      409: errorResponse(
        `${VERSION} ${CLAIMED} DEPENDENCY_CYCLE: a blockedBy task already (transitively) depends on this one — \`details: { path }\`.`,
        ["VERSION_CONFLICT", "TASK_ALREADY_CLAIMED", "DEPENDENCY_CYCLE"],
      ),
      422: VALIDATION_422(
        "The payload is missing what its target status requires, names an unknown status, sends todo with no acceptance criteria anywhere, or names a blockedBy task that is this task or does not exist.",
      ),
    },
  });

  registerV1Path({
    method: "post",
    path: "/api/v1/tasks/{taskId}/claim",
    tags: ["Workflow"],
    summary: "Claim a specific task",
    description:
      "Exactly a transition to in_progress: the caller takes the claim, with a lease of CLAIM_LEASE_MINUTES. An expired lease is claimable by anyone. The body may be omitted.",
    request: { params: taskId, body: jsonBody(claimTaskInputSchema, false) },
    responses: {
      200: taskResponse("The task, in progress, claimed by the caller."),
      ...bodyParserResponses(),
      404: TASK_404(),
      409: errorResponse(`${VERSION} ${CLAIMED}`, ["VERSION_CONFLICT", "TASK_ALREADY_CLAIMED"]),
      422: VALIDATION_422("An unknown field, or a non-integer expectedVersion."),
    },
  });

  registerV1Path({
    method: "post",
    path: "/api/v1/tasks/{taskId}/heartbeat",
    tags: ["Workflow"],
    summary: "Extend the caller's lease",
    description:
      "Only the claim holder may heartbeat — including on its own expired lease, as long as nobody else has taken the task since. Does **not** bump version. No body.",
    request: { params: taskId },
    responses: {
      200: taskResponse("The task with its extended claim."),
      404: TASK_404(),
      409: errorResponse(
        "NOT_CLAIM_HOLDER: the caller does not hold the claim (or the task is not in progress). `details: { claimedBy, expiresAt }` when someone else holds a live one.",
        ["NOT_CLAIM_HOLDER"],
      ),
      422: VALIDATION_422("Only the X-Actor header can fail here."),
    },
  });

  registerV1Path({
    method: "post",
    path: "/api/v1/tasks/{taskId}/release",
    tags: ["Workflow"],
    summary: "Give up a claimed task",
    description:
      "The holder gives the task up: back to todo, claim cleared, `reason` as the status note. A human may release anyone's claim; an agent only its own. `followUps` files the work left undone as needsTriage subtasks, like a needs_qa hand-off. The body may be omitted.",
    request: { params: taskId, body: jsonBody(releaseTaskInputSchema, false) },
    responses: {
      200: taskResponse("The task, back in todo."),
      ...bodyParserResponses(),
      404: TASK_404(),
      409: errorResponse(
        `${VERSION} NOT_CLAIM_HOLDER: an agent that does not hold the claim, or a task that is not in progress.`,
        ["VERSION_CONFLICT", "NOT_CLAIM_HOLDER"],
      ),
      422: VALIDATION_422("An unknown field, or an empty reason."),
    },
  });

  registerV1Path({
    method: "post",
    path: "/api/v1/tasks/{taskId}/decision/answer",
    tags: ["Workflow"],
    summary: "Answer the open decision",
    description:
      "Pick an option (`choice`, which must be one of the option labels), write an answer (`note`), or both. The decision is recorded as answered and the task moves to todo with the answer as its status note — the acceptance-criteria gate is skipped, since the task was already in flight.",
    request: { params: taskId, body: jsonBody(answerDecisionInputSchema) },
    responses: {
      200: taskResponse("The task, back in todo, with the answered decision in its history."),
      ...bodyParserResponses(),
      404: TASK_404(),
      409: errorResponse(
        `NO_OPEN_DECISION: the task is not in needs_user_decision, or has no open decision. ${VERSION}`,
        ["NO_OPEN_DECISION", "VERSION_CONFLICT"],
      ),
      422: VALIDATION_422(
        "Neither choice nor note was sent, or choice is not one of the option labels.",
      ),
    },
  });

  registerV1Path({
    method: "post",
    path: "/api/v1/tasks/{taskId}/dependencies",
    tags: ["Workflow"],
    summary: "Make this task depend on another",
    description:
      "This task cannot start until `dependsOnId` is done (deferred does not count). Adding a dependency that already exists is a no-op success.",
    request: { params: taskId, body: jsonBody(addDependencyInputSchema) },
    responses: {
      200: taskResponse("The task with its dependencies."),
      ...bodyParserResponses(),
      404: TASK_404(),
      409: errorResponse(
        `DEPENDENCY_CYCLE: dependsOnId already (transitively) depends on this task — \`details: { path }\` is the loop the edge would close. ${CLAIMED} ${VERSION}`,
        ["DEPENDENCY_CYCLE", "TASK_ALREADY_CLAIMED", "VERSION_CONFLICT"],
      ),
      422: VALIDATION_422(
        "dependsOnId is this task, does not exist, or is not a positive integer.",
      ),
    },
  });

  registerV1Path({
    method: "delete",
    path: "/api/v1/tasks/{taskId}/dependencies/{dependsOnId}",
    tags: ["Workflow"],
    summary: "Remove a dependency",
    description:
      "**200 with the task**, unlike the other DELETEs — the edge is gone but the task it changed is what the caller needs next. Removing an edge that does not exist is a no-op success. Removing the last unfinished dependency of a blocked task moves it to todo.",
    request: {
      params: taskIdParam().extend({
        dependsOnId: taskIdParamSchema.meta({
          description: "The task this one should stop depending on. Decimal digits only.",
          example: 7,
        }),
      }),
    },
    responses: {
      200: taskResponse("The task with its remaining dependencies."),
      404: TASK_404(),
      409: errorResponse(`${CLAIMED} ${VERSION}`, ["TASK_ALREADY_CLAIMED", "VERSION_CONFLICT"]),
      422: VALIDATION_422("Only the X-Actor header can fail here."),
    },
  });
}

/** Registers every task and workflow operation. Called once, by `getOpenApiDocument()`. */
export function registerTaskPaths(): void {
  registerResourcePaths();
  registerWorkflowPaths();
}
