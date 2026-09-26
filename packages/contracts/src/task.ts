import { z } from "zod";
import { storedActorSchema } from "./actor.js";
import { commentSchema } from "./comment.js";
import { decisionSchema } from "./decision.js";
import { TASK_ID_MAX_DIGITS } from "./reference.js";

/* ------------------------------------------------------------------ *
 * Enums
 *
 * SQLite has no enum type, so `status` / `priority` are `String` columns.
 * These zod enums are the real constraint: a service must never write a value
 * that did not come from the matching `.parse()`.
 * ------------------------------------------------------------------ */

/**
 * Lifecycle order. The index in this array is the persisted `statusRank`, so
 * this order *is* the "sort by status" order. See
 * `docs/features/Task_Status_Lifecycle.md` for what each one means and what a
 * transition into it requires.
 */
export const TASK_STATUSES = [
  "backlog",
  "needs_refinement",
  "todo",
  "in_progress",
  "blocked",
  "needs_user_decision",
  "needs_user_action",
  "needs_qa",
  "done",
  "deferred",
] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/**
 * The four lanes the board groups statuses into. Every status is in exactly one
 * lane — `task.test.ts` asserts the partition.
 */
export const TASK_STATUS_LANES = {
  plan: ["backlog", "needs_refinement", "todo"],
  doing: ["in_progress", "needs_qa"],
  waiting: ["blocked", "needs_user_decision", "needs_user_action"],
  closed: ["done", "deferred"],
} as const satisfies Record<string, readonly TaskStatus[]>;
export type TaskStatusLane = keyof typeof TASK_STATUS_LANES;

/** Statuses that are waiting on a human. They make up the inbox. */
export const HUMAN_ATTENTION_STATUSES = [
  "needs_user_decision",
  "needs_user_action",
  "needs_qa",
] as const satisfies readonly TaskStatus[];

/** Statuses a task may be created in. Everything else is reached by a transition. */
export const CREATABLE_TASK_STATUSES = [
  "backlog",
  "needs_refinement",
  "todo",
] as const satisfies readonly TaskStatus[];
export const creatableTaskStatusSchema = z.enum(CREATABLE_TASK_STATUSES);

/**
 * The closed lane: no further work is expected. Note the asymmetry — only `done`
 * *satisfies* a dependency; a `deferred` blocker still blocks its dependents.
 */
export const TERMINAL_TASK_STATUSES = ["done", "deferred"] as const satisfies readonly TaskStatus[];

/** Severity order, ascending. The index in this array is the persisted `priorityRank`. */
export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const taskPrioritySchema = z.enum(TASK_PRIORITIES);
export type TaskPriority = z.infer<typeof taskPrioritySchema>;

export const DEFAULT_TASK_STATUS: TaskStatus = "backlog";
export const DEFAULT_TASK_PRIORITY: TaskPriority = "medium";

/* ------------------------------------------------------------------ *
 * Field bounds
 * ------------------------------------------------------------------ */

export const TASK_TITLE_MIN = 5;
export const TASK_TITLE_MAX = 120;
export const TASK_DESCRIPTION_MIN = 10;
export const TASK_DESCRIPTION_MAX = 5000;
export const TASK_ACCEPTANCE_CRITERIA_MAX = 5000;
export const TASK_STATUS_NOTE_MAX = 5000;
export const TASK_ASSIGNEE_MIN = 2;
export const TASK_ASSIGNEE_MAX = 80;
export const TASK_PROJECT_MAX = 64;
export const TASK_LINKS_MAX = 20;
export const TASK_LINK_LABEL_MAX = 80;
export const TASK_LINK_URL_MAX = 2000;
export const TASK_IDEMPOTENCY_KEY_MAX = 128;
export const TASK_LABELS_MAX = 10;
export const TASK_LABEL_MAX = 32;

/**
 * Wraps an optional string-ish field so that an empty (or whitespace-only)
 * string becomes `null` rather than `""`.
 *
 * This is load-bearing, not cosmetic. Clearing a field in the edit form posts
 * `""`; stored as an empty string, that task then matches neither
 * `assigneeIsNull=true` nor any name filter and disappears from every assignee
 * view. **Any new optional string field gets the same treatment.**
 *
 * The trim happens in the preprocessor so the length bounds below see the
 * trimmed value.
 */
export const emptyStringToNull = <TInner extends z.ZodType>(inner: TInner) =>
  z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }, inner);

export const assigneeInputSchema = emptyStringToNull(
  z
    .string()
    .min(TASK_ASSIGNEE_MIN, `Assignee must be at least ${TASK_ASSIGNEE_MIN} characters`)
    .max(TASK_ASSIGNEE_MAX, `Assignee must be at most ${TASK_ASSIGNEE_MAX} characters`)
    .nullable(),
);

/**
 * `project` groups tasks by the codebase or effort they belong to — agents
 * working in different repositories share one board and filter by it. It
 * replaced the old IT `category` enum.
 *
 * A lowercase slug **canonicalised in the schema**: it is an exact-match filter,
 * SQLite's `equals` is case-sensitive, and `Helpdesk` vs `helpdesk` must not be
 * two projects.
 */
export const projectSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    new RegExp(`^[a-z0-9][a-z0-9._-]{0,${TASK_PROJECT_MAX - 1}}$`),
    "Project must be a slug: letters, digits, . _ -",
  );
export const projectInputSchema = emptyStringToNull(projectSchema.nullable());

/**
 * A label: a free-form tag that narrows work **inside** a project — typically
 * the workspace of a monorepo (`web`, `api`, `contracts`) or a kind of work
 * (`bug`, `flaky-test`). `project` answers "which repository", labels answer
 * "which part of it".
 *
 * A lowercase slug canonicalised in the schema for the same reason `project`
 * is: `?label=` is an exact-match filter and `Web` vs `web` must not be two
 * labels. `/` is allowed so a label can name a path-like area (`apps/web`).
 */
export const labelSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    new RegExp(`^[a-z0-9][a-z0-9._/-]{0,${TASK_LABEL_MAX - 1}}$`),
    "Label must be a slug: letters, digits, . _ / -",
  );

/**
 * The whole label set of a task. Replaces, never merges — the same rule as
 * `links`. Duplicates collapse and the set comes back sorted, so the stored
 * order never depends on how the caller typed it.
 */
export const labelsInputSchema = z
  .array(labelSchema)
  .transform((labels) => [...new Set(labels)].sort())
  .pipe(z.array(z.string()).max(TASK_LABELS_MAX, `At most ${TASK_LABELS_MAX} labels`));

export const acceptanceCriteriaInputSchema = emptyStringToNull(
  z
    .string()
    .max(
      TASK_ACCEPTANCE_CRITERIA_MAX,
      `Acceptance criteria must be at most ${TASK_ACCEPTANCE_CRITERIA_MAX} characters`,
    )
    .nullable(),
);

export const titleInputSchema = z
  .string()
  .trim()
  .min(TASK_TITLE_MIN, `Title must be at least ${TASK_TITLE_MIN} characters`)
  .max(TASK_TITLE_MAX, `Title must be at most ${TASK_TITLE_MAX} characters`);

export const descriptionInputSchema = z
  .string()
  .trim()
  .min(TASK_DESCRIPTION_MIN, `Description must be at least ${TASK_DESCRIPTION_MIN} characters`)
  .max(TASK_DESCRIPTION_MAX, `Description must be at most ${TASK_DESCRIPTION_MAX} characters`);

/** A pointer to where the work lives: a PR, a branch, a commit, a design doc. */
export const taskLinkSchema = z
  .object({
    label: z
      .string()
      .trim()
      .min(1, "Give the link a label")
      .max(TASK_LINK_LABEL_MAX, `Label must be at most ${TASK_LINK_LABEL_MAX} characters`),
    url: z.url("Enter a valid URL").max(TASK_LINK_URL_MAX),
  })
  .strict();
export type TaskLink = z.infer<typeof taskLinkSchema>;

export const taskLinksInputSchema = z
  .array(taskLinkSchema)
  .max(TASK_LINKS_MAX, `At most ${TASK_LINKS_MAX} links`);

/**
 * `:taskId` — a non-numeric segment fails here and becomes 404, never 422.
 *
 * Decimal digits only, deliberately not `z.coerce.number()`: coercion accepts
 * `"0x2a"`, `"1e3"`, and `" 12 "`, which would serve task 42 under three alias
 * URLs. It would also disagree with `parseReference()`, the other entry point
 * that turns user input into a task id. The `{1,15}` bound is shared with
 * `parseReference` through `TASK_ID_MAX_DIGITS`; `comment.test.ts` compares all
 * three parsers against one shared input table.
 */
export const taskIdParamSchema = z
  .string()
  .regex(new RegExp(`^\\d{1,${TASK_ID_MAX_DIGITS}}$`))
  .transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));

/** A task id inside a JSON body (`parentId`, `blockedBy`, `dependsOnId`). */
export const taskIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * Optimistic concurrency. Every task carries a `version` that increments on
 * every write; a mutation that sends `expectedVersion` fails with
 * `VERSION_CONFLICT` (409) if someone — usually an agent — wrote in between.
 * Optional so a caller that does not care is not forced to read first.
 */
export const expectedVersionSchema = z.number().int().positive().optional();

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

/**
 * Client → server for `POST /tasks`.
 *
 * `.strict()` matters here: a payload containing a server-owned field (`id`,
 * `createdAt`, `createdBy`, `version`, …) is rejected with `VALIDATION_ERROR`
 * rather than silently stripped.
 *
 * `status` is limited to `CREATABLE_TASK_STATUSES`; anything else carries
 * requirements (a reason, a question, a summary) and is reached with
 * `POST /tasks/:taskId/transition` after creating. `todo` needs
 * `acceptanceCriteria` — enforced here so the error lands on the field.
 *
 * `idempotencyKey` makes a retried create safe: a second `POST` with the same key
 * returns the task the first one made (200 instead of 201) instead of a
 * duplicate. Agents should always send one. **A key only deduplicates against
 * a task that is still open**: when the task holding the key is `done` or
 * `deferred`, the key is retired from it and a new task is created (201) — a
 * follow-up filed months later under a recycled title must not come back as
 * the closed original.
 */
export const createTaskInputSchema = z
  .object({
    title: titleInputSchema,
    description: descriptionInputSchema,
    status: creatableTaskStatusSchema.default("backlog"),
    priority: taskPrioritySchema.default(DEFAULT_TASK_PRIORITY),
    project: projectInputSchema.optional(),
    assignee: assigneeInputSchema.optional(),
    acceptanceCriteria: acceptanceCriteriaInputSchema.optional(),
    links: taskLinksInputSchema.optional(),
    labels: labelsInputSchema.optional(),
    parentId: taskIdSchema.nullable().optional(),
    idempotencyKey: z.string().trim().min(1).max(TASK_IDEMPOTENCY_KEY_MAX).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "todo" && !value.acceptanceCriteria) {
      ctx.addIssue({
        code: "custom",
        path: ["acceptanceCriteria"],
        message: "Acceptance criteria are required before a task can be todo",
      });
    }
  });
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;
export type CreateTaskInputRaw = z.input<typeof createTaskInputSchema>;

/**
 * Client → server for `PATCH /tasks/:taskId`. Every field optional.
 *
 * **`status` is absent on purpose.** Status changes carry requirements (a reason
 * for `blocked`, a question for `needs_user_decision`, …) and side effects
 * (claims, decisions, unblocking dependents), so they go through
 * `POST /tasks/:taskId/transition` and nowhere else. A PATCH carrying `status`
 * is a `VALIDATION_ERROR` from `.strict()`.
 *
 * An **empty body is deliberately valid here.** `{}` must surface as
 * `AT_LEAST_ONE_FIELD` (422); `hasAtLeastOneField()` below is that check.
 * `expectedVersion` alone does not count as a field.
 */
export const updateTaskInputSchema = z
  .object({
    title: titleInputSchema.optional(),
    description: descriptionInputSchema.optional(),
    priority: taskPrioritySchema.optional(),
    project: projectInputSchema.optional(),
    assignee: assigneeInputSchema.optional(),
    acceptanceCriteria: acceptanceCriteriaInputSchema.optional(),
    links: taskLinksInputSchema.optional(),
    labels: labelsInputSchema.optional(),
    parentId: taskIdSchema.nullable().optional(),
    expectedVersion: expectedVersionSchema,
  })
  .strict();
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;

/** `true` when a parsed PATCH body carries at least one field besides `expectedVersion`. */
export const hasAtLeastOneField = (input: UpdateTaskInput): boolean =>
  Object.keys(input).some((key) => key !== "expectedVersion");

/* ------------------------------------------------------------------ *
 * Responses
 * ------------------------------------------------------------------ */

/**
 * The active lease on a task. Present only while a live claim exists — an
 * expired lease serializes as `null`, because to every consumer it means the
 * same thing as no claim: anyone may take the task.
 */
export const taskClaimSchema = z
  .object({
    actor: storedActorSchema,
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type TaskClaim = z.infer<typeof taskClaimSchema>;

/**
 * A compact pointer to another task (parent, child, dependency). `project` is
 * on it because dependencies cross repositories: an agent in `mobile-app`
 * waiting on a `helpdesk` task must be able to tell from the pointer alone.
 */
export const taskRefSchema = z
  .object({
    id: z.number().int().positive(),
    reference: z.string(),
    title: z.string(),
    status: taskStatusSchema,
    project: z.string().nullable(),
  })
  .strict();
export type TaskRef = z.infer<typeof taskRefSchema>;

/**
 * List rows. Everything that is one row of `Task` plus the open decision (the
 * inbox renders its question and options inline) and a count of unfinished
 * dependencies — no comment thread, no relation lists, so the list never fans
 * out into N queries per row.
 *
 * `statusNote` is the "why" of the current status: the reason for `blocked` or
 * `deferred`, the instructions for `needs_user_action`, the change summary for
 * `needs_qa`. It is replaced on every transition; history is in the events feed.
 */
export const taskSummarySchema = z
  .object({
    id: z.number().int().positive(),
    reference: z.string(),
    title: z.string(),
    description: z.string(),
    status: taskStatusSchema,
    statusNote: z.string().nullable(),
    priority: taskPrioritySchema,
    project: z.string().nullable(),
    assignee: z.string().nullable(),
    acceptanceCriteria: z.string().nullable(),
    links: z.array(taskLinkSchema),
    /** Sorted. */
    labels: z.array(z.string()),
    parentId: z.number().int().positive().nullable(),
    /** Number of subtasks — non-zero marks a task as an epic in a list. */
    childCount: z.number().int().nonnegative(),
    createdBy: storedActorSchema,
    claim: taskClaimSchema.nullable(),
    version: z.number().int().positive(),
    openDependencyCount: z.number().int().nonnegative(),
    openDecision: decisionSchema.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
    commentCount: z.number().int().nonnegative(),
  })
  .strict();
export type TaskSummary = z.infer<typeof taskSummarySchema>;

/**
 * Server → client, single task: the summary plus its thread and relations.
 *
 * `decisions` is the full history, newest first — answered and withdrawn ones
 * included — because the answer to a decision is exactly what the next agent to
 * pick the task up needs, and `statusNote` is replaced by the next transition.
 */
export const taskSchema = taskSummarySchema
  .extend({
    comments: z.array(commentSchema),
    decisions: z.array(decisionSchema),
    parent: taskRefSchema.nullable(),
    children: z.array(taskRefSchema),
    dependencies: z.array(taskRefSchema),
    dependents: z.array(taskRefSchema),
  })
  .strict();
export type Task = z.infer<typeof taskSchema>;

/**
 * `GET /tasks/facets` — distinct non-null values actually present in the
 * table, sorted. The only source of options for the assignee, project, and
 * label filters; sending an exact stored value is what makes case-sensitive equality
 * safe.
 */
export const taskFacetsSchema = z
  .object({
    assignees: z.array(z.string()),
    projects: z.array(z.string()),
    labels: z.array(z.string()),
    creators: z.array(z.string()),
  })
  .strict();
export type TaskFacets = z.infer<typeof taskFacetsSchema>;

/**
 * `GET /tasks/stats` — task count per status, every status present (zero
 * included). Feeds the board lane headers and the inbox badge without pulling
 * rows. Accepts the same `project` filter as the list.
 */
export const taskStatsSchema = z
  .object({
    byStatus: z.record(taskStatusSchema, z.number().int().nonnegative()),
    needsAttention: z.number().int().nonnegative(),
  })
  .strict();
export type TaskStats = z.infer<typeof taskStatsSchema>;
