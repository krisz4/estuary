import { z } from "zod";
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE,
  MAX_PAGE_SIZE,
  MIN_PAGE_SIZE,
  paginatedSchema,
} from "./pagination.js";
import { storedActorSchema } from "./actor.js";
import { TASK_ID_MAX_DIGITS } from "./reference.js";
import {
  labelSchema,
  projectSchema,
  TASK_ASSIGNEE_MAX,
  taskIdSchema,
  taskPrioritySchema,
  taskStatusSchema,
  taskSummarySchema,
} from "./task.js";

/* ------------------------------------------------------------------ *
 * Sorting
 * ------------------------------------------------------------------ */

export const TASK_SORT_FIELDS = [
  "id",
  "createdAt",
  "updatedAt",
  "title",
  "status",
  "priority",
  // Null for open tasks. The archive sorts done/deferred work by it.
  "completedAt",
] as const;
export type TaskSortField = (typeof TASK_SORT_FIELDS)[number];

export const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

export const DEFAULT_TASK_SORT_FIELD: TaskSortField = "createdAt";
export const DEFAULT_TASK_SORT_DIRECTION: SortDirection = "desc";
/** The wire form of the default, for link builders and the URL-state helper. */
export const DEFAULT_TASK_SORT = "createdAt:desc";

export type TaskSort = { field: TaskSortField; direction: SortDirection };

/** `{ field, direction }` → `"createdAt:desc"`. */
export const formatTaskSort = (sort: TaskSort): string => `${sort.field}:${sort.direction}`;

const isSortField = (value: string): value is TaskSortField =>
  (TASK_SORT_FIELDS as readonly string[]).includes(value);

const isSortDirection = (value: string): value is SortDirection =>
  (SORT_DIRECTIONS as readonly string[]).includes(value);

/**
 * One `field:direction` clause. `status` and `priority` are accepted here but
 * are translated by the service into their integer rank columns — SQLite cannot
 * order a text column by lifecycle or severity.
 */
export const taskSortSchema = z
  .string()
  .trim()
  .transform((raw, ctx): TaskSort => {
    const [field, direction, ...rest] = raw.split(":");

    if (field === undefined || direction === undefined || rest.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `Sort must be "field:direction", e.g. "${DEFAULT_TASK_SORT}"`,
      });
      return z.NEVER;
    }
    if (!isSortField(field)) {
      ctx.addIssue({
        code: "custom",
        message: `Unknown sort field "${field}". Expected one of: ${TASK_SORT_FIELDS.join(", ")}`,
      });
      return z.NEVER;
    }
    if (!isSortDirection(direction)) {
      ctx.addIssue({
        code: "custom",
        message: `Sort direction must be one of: ${SORT_DIRECTIONS.join(", ")}`,
      });
      return z.NEVER;
    }

    return { field, direction };
  })
  .default({ field: DEFAULT_TASK_SORT_FIELD, direction: DEFAULT_TASK_SORT_DIRECTION });

/* ------------------------------------------------------------------ *
 * Query-string coercion helpers
 * ------------------------------------------------------------------ */

/**
 * Drops empty values before parsing, so `?page=&status=` behaves exactly like `?`.
 *
 * Browsers, forms, and link builders emit empty params constantly. Without this,
 * `z.coerce.number()` turns `""` into `0`, which then fails `min(1)` and 422s a
 * request the user never meant to make.
 *
 * A repeated param collapses to its non-empty values, and vanishes entirely if
 * none remain. Note the consequence for unknown keys: `?utm_source=slack` is a
 * `VALIDATION_ERROR` from `.strict()`, but `?utm_source=` is simply absent —
 * an empty value carries no intent to reject.
 *
 * Whitespace-only counts as empty. `?q=%20` is what a user typing a space into
 * the search box produces; it carries exactly as little intent as `?q=`, and
 * 422ing one but not the other is a distinction the user cannot see.
 */
const isBlank = (value: unknown): boolean => typeof value === "string" && value.trim() === "";

export const dropEmptyQueryValues = (input: unknown): unknown => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isBlank(value)) continue;
    if (Array.isArray(value)) {
      const kept = value.filter((entry) => !isBlank(entry));
      if (kept.length > 0) result[key] = kept;
      continue;
    }
    result[key] = value;
  }
  return result;
};

/**
 * A repeatable filter: `?status=open&status=in_progress`. Express hands over a
 * bare string for one occurrence and an array for several, so single values are
 * wrapped before the array schema sees them. Values within one param OR
 * together; different params AND together.
 */
export const repeatable = <TInner extends z.ZodType>(inner: TInner) =>
  z
    .preprocess((value) => (Array.isArray(value) ? value : [value]), z.array(inner).min(1))
    .optional();

/**
 * `z.coerce.boolean()` is wrong for query strings — it follows JS truthiness, so
 * `"false"` parses as `true`. Only the four unambiguous spellings are accepted;
 * anything else is a `VALIDATION_ERROR` rather than a silently inverted filter.
 */
const queryBoolean = z.union([
  z.boolean(),
  z.enum(["true", "false", "1", "0"]).transform((value) => value === "true" || value === "1"),
]);

/** A task id arriving as a query-string value: decimal digits only. */
export const taskIdQuerySchema = z
  .string()
  .regex(new RegExp(`^\\d{1,${TASK_ID_MAX_DIGITS}}$`), "Expected a task id")
  .transform(Number)
  .pipe(taskIdSchema);

/* ------------------------------------------------------------------ *
 * The list query
 * ------------------------------------------------------------------ */

export const TASK_Q_MAX = 120;
/** More terms than this is a paragraph, not a search; the rest are ignored. */
export const TASK_Q_MAX_TERMS = 8;

/**
 * Splits `q` into the terms the search ANDs together.
 *
 * Whitespace separates terms; a double-quoted run is one term, so
 * `"page resets" board` is two terms, the first a phrase. An unterminated quote
 * runs to the end. Terms are deduplicated case-insensitively (SQLite's `LIKE`
 * is ASCII case-insensitive, so `Board board` would only repeat the work) and
 * capped at `TASK_Q_MAX_TERMS`.
 *
 * Lives in the contracts so the web can highlight exactly the terms the server
 * matched on.
 */
export const parseSearchTerms = (q: string): string[] => {
  const terms: string[] = [];
  const seen = new Set<string>();
  const pattern = /"([^"]*)"?|(\S+)/g;
  for (const match of q.matchAll(pattern)) {
    const term = (match[1] ?? match[2] ?? "").trim();
    if (term === "") continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length === TASK_Q_MAX_TERMS) break;
  }
  return terms;
};

/**
 * The filter params shared by every task-scoped read: `GET /tasks`, and
 * `GET /floor`, which marks matches instead of paging them. Spread into an
 * object schema, then `.superRefine(refineTaskFilters)`.
 */
export const taskFilterFields = {
  status: repeatable(taskStatusSchema),
  priority: repeatable(taskPrioritySchema),
  project: repeatable(projectSchema),
  // Tasks carrying any of these labels.
  label: repeatable(labelSchema),

  // Exact and case-sensitive. Send a value from `GET /tasks/facets`.
  assignee: z.string().trim().min(1).max(TASK_ASSIGNEE_MAX).optional(),
  assigneeIsNull: queryBoolean.optional(),

  // Exact actor, e.g. `agent:claude-code`. Lowercased like the stored value.
  createdBy: z.string().trim().toLowerCase().pipe(storedActorSchema.max(80)).optional(),

  // Tasks whose claim is held by this actor. Matches the stored `claimedBy`,
  // so an expired lease still matches — pair with `status=in_progress` and
  // check `claim` on the rows when only live claims matter.
  claimedBy: z.string().trim().toLowerCase().pipe(storedActorSchema.max(80)).optional(),

  // Subtasks of one parent.
  // Digits only, like `:taskId` — `z.coerce` would accept `0x2a` and `1e3`.
  parentId: taskIdQuerySchema.optional(),
  // `true` = top-level tasks only (no parent); `false` = subtasks only.
  parentIsNull: queryBoolean.optional(),

  // Tasks that depend on this task — its dependents ("who waits on 42?").
  dependsOn: taskIdQuerySchema.optional(),
  // Tasks this task depends on — its dependencies ("what does 42 wait on?").
  dependencyOf: taskIdQuerySchema.optional(),

  // Every term (see `parseSearchTerms`) must appear somewhere in the task:
  // title, description, acceptance criteria, status note, links, or a
  // comment. A term that is a reference (`TASK-42`, `#42`) also matches that id.
  q: z.string().trim().min(1).max(TASK_Q_MAX).optional(),

  // Date-only, UTC. The service expands `createdTo` to an exclusive next-day
  // bound so the named day is included.
  createdFrom: z.iso.date("Expected a date in YYYY-MM-DD form").optional(),
  createdTo: z.iso.date("Expected a date in YYYY-MM-DD form").optional(),
};

type TaskFilterValues = {
  assignee?: string | undefined;
  assigneeIsNull?: boolean | undefined;
  parentId?: number | undefined;
  parentIsNull?: boolean | undefined;
  createdFrom?: string | undefined;
  createdTo?: string | undefined;
};

/** Cross-field rules for `taskFilterFields`. */
export const refineTaskFilters = (value: TaskFilterValues, ctx: z.RefinementCtx): void => {
  if (value.assignee !== undefined && value.assigneeIsNull !== undefined) {
    // A sentinel like `assignee=none` would collide with a real person, so the
    // two are separate params — which makes them mutually exclusive.
    const message = "Send either assignee or assigneeIsNull, not both";
    ctx.addIssue({ code: "custom", path: ["assignee"], message });
    ctx.addIssue({ code: "custom", path: ["assigneeIsNull"], message });
  }

  if (value.parentId !== undefined && value.parentIsNull !== undefined) {
    const message = "Send either parentId or parentIsNull, not both";
    ctx.addIssue({ code: "custom", path: ["parentId"], message });
    ctx.addIssue({ code: "custom", path: ["parentIsNull"], message });
  }

  // An inverted range is always empty. Silently returning nothing reads to the
  // user as "no tasks exist" rather than "your two date pickers disagree".
  if (value.createdFrom !== undefined && value.createdTo !== undefined) {
    if (value.createdFrom > value.createdTo) {
      ctx.addIssue({
        code: "custom",
        path: ["createdTo"],
        message: "createdTo must be on or after createdFrom",
      });
    }
  }
};

const taskListQueryObjectSchema = z
  .object({
    page: z.coerce
      .number()
      .int()
      .min(1, "Page must be at least 1")
      // Bounded for the same reason `pageSize` is, plus a concrete one: the
      // service computes `skip = (page - 1) * pageSize`, and Prisma's `skip` is
      // an Int32 in the query engine. An unbounded `page` turns a nonsense URL
      // into a 500 instead of the documented empty page.
      .max(MAX_PAGE, `Page must be at most ${MAX_PAGE}`)
      .default(DEFAULT_PAGE),
    pageSize: z.coerce
      .number()
      .int()
      .min(MIN_PAGE_SIZE, `Page size must be at least ${MIN_PAGE_SIZE}`)
      // Rejected, not clamped: a client asking for 500 rows has a bug worth surfacing.
      .max(MAX_PAGE_SIZE, `Page size must be at most ${MAX_PAGE_SIZE}`)
      .default(DEFAULT_PAGE_SIZE),
    sort: taskSortSchema,

    ...taskFilterFields,
  })
  // Unknown params are rejected rather than ignored: a typo'd filter silently
  // returning everything is worse than an error.
  .strict()
  .superRefine(refineTaskFilters);

/**
 * `GET /tasks` query parameters. All optional; `page`, `pageSize`, and `sort`
 * come back filled with their defaults.
 *
 * Server-side only. `useTaskListParams()` on the web **picks the keys it
 * knows** out of `useSearchParams()` instead of feeding raw params in here — a
 * shared link carrying `?utm_source=slack` must not fail the whole parse and
 * silently reset every filter the recipient was meant to see.
 */
export const taskListQuerySchema = z.preprocess(dropEmptyQueryValues, taskListQueryObjectSchema);

export type TaskListQuery = z.infer<typeof taskListQuerySchema>;
export type TaskListQueryInput = z.input<typeof taskListQuerySchema>;

/** The enveloped list response: task summaries plus pagination `meta`. */
export const paginatedTasksSchema = paginatedSchema(taskSummarySchema);
export type PaginatedTasks = z.infer<typeof paginatedTasksSchema>;

/**
 * `GET /tasks/stats` query: the one filter that makes sense for a per-status
 * count — which projects to count.
 */
export const taskStatsQuerySchema = z.preprocess(
  dropEmptyQueryValues,
  z.object({ project: repeatable(projectSchema) }).strict(),
);
export type TaskStatsQuery = z.infer<typeof taskStatsQuerySchema>;
