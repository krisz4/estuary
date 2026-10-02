import {
  decisionOptionSchema,
  formatReference,
  taskLinkSchema,
  type Comment,
  type CommentKind,
  type Decision,
  type DecisionOption,
  type DecisionStatus,
  type Task,
  type TaskClaim,
  type TaskEvent,
  type TaskEventType,
  type TaskLink,
  type TaskPriority,
  type TaskRef,
  type TaskStatus,
  type TaskSummary,
} from "@estuary/contracts";
import { z } from "zod";

/**
 * The single boundary between a database row and the wire.
 *
 * Two jobs, both of which are silent bugs when a route forgets them:
 *
 * 1. **`Date` → ISO 8601 UTC string.** `JSON.stringify` happens to call
 *    `Date.prototype.toJSON`, so forgetting this looks fine until a value is
 *    reshaped on the way out and a raw `Date` reaches a client as `{}`.
 * 2. **`reference`** (`TASK-000042`) is computed here, never stored — see
 *    `docs/features/Task_Numbering.md`.
 *
 * It also drops the columns that are storage detail — `statusRank`,
 * `priorityRank`, `idempotencyKey`, the raw claim columns — and parses the JSON
 * held in `String` columns (`links`, `options`, `payload`).
 *
 * There is one function per shape rather than a serializer per route, so no
 * route can forget. Routes call these; nothing else builds a response body.
 */

/* ------------------------------------------------------------------ *
 * Row shapes
 *
 * Declared structurally rather than imported from `@prisma/client` so this
 * module stays honest about what it needs, and so `lib/` does not depend on a
 * generated client to typecheck. Prisma's own row types satisfy them.
 * ------------------------------------------------------------------ */

export interface CommentRow {
  id: number;
  taskId: number;
  author: string;
  /** Constrained to `CommentKind` by the zod enum on the only write path. */
  kind: string;
  body: string;
  createdAt: Date;
}

export interface DecisionRow {
  id: number;
  taskId: number;
  status: string;
  question: string;
  options: string;
  recommendedOption: string | null;
  context: string | null;
  requestedBy: string;
  choice: string | null;
  note: string | null;
  answeredBy: string | null;
  createdAt: Date;
  answeredAt: Date | null;
}

export interface TaskRow {
  id: number;
  title: string;
  description: string;
  acceptanceCriteria: string | null;
  /** Constrained to `TaskStatus` by the zod enums on every write path. */
  status: string;
  statusNote: string | null;
  concerns: string | null;
  needsTriage: boolean;
  /** Constrained to `TaskPriority` by the zod enums on every write path. */
  priority: string;
  project: string | null;
  assignee: string | null;
  createdBy: string;
  links: string;
  claimedBy: string | null;
  claimExpiresAt: Date | null;
  version: number;
  parentId: number | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

/** A related task, reduced to what a `TaskRef` shows. */
export interface TaskRefRow {
  id: number;
  title: string;
  status: string;
  project: string | null;
}

/**
 * What every task read must load alongside the row. Kept as a type here and as
 * a Prisma `include` in the service (`summaryInclude`), so a read that forgets
 * one of them is a type error at the serializer call rather than a quietly
 * wrong count.
 */
export interface TaskSummaryRelations {
  _count: { comments: number; children: number };
  /** At least the `open` decision (at most one exists); the detail loads them all. */
  decisions: DecisionRow[];
  /** Every dependency, with just enough of the other task to count the unfinished ones. */
  dependencies: { dependsOn: { status: string } }[];
  /** Sorted by `label` ascending — the order `TaskSummary.labels` comes back in. */
  labels: { label: string }[];
}

export interface TaskDetailRelations extends TaskSummaryRelations {
  comments: CommentRow[];
  parent: TaskRefRow | null;
  children: TaskRefRow[];
  dependencies: { dependsOn: TaskRefRow }[];
  dependents: { task: TaskRefRow }[];
}

export interface TaskEventRow {
  id: number;
  taskId: number;
  type: string;
  actor: string;
  /** The task's project when the event was recorded — see `recordEvent()`. */
  project: string | null;
  payload: string;
  createdAt: Date;
  /** The task's current title, joined in by the caller; `null` if it's been deleted. */
  taskTitle: string | null;
}

/* ------------------------------------------------------------------ *
 * Date helpers
 * ------------------------------------------------------------------ */

export const toIso = (value: Date): string => value.toISOString();

export const toIsoOrNull = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

/* ------------------------------------------------------------------ *
 * JSON columns
 * ------------------------------------------------------------------ */

/**
 * JSON columns are parsed **leniently** on the way out. They are written only
 * from zod-validated input, so a parse failure means someone edited the file by
 * hand — and turning that into a 500 on every read of the task (or a 422 on a
 * `GET`, which is what a thrown `ZodError` would become) is worse than showing
 * the task without its links.
 */
const parseJsonColumn = <T>(raw: string, schema: z.ZodType<T>, fallback: T): T => {
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
};

const linksColumn = z.array(taskLinkSchema);
const optionsColumn = z.array(decisionOptionSchema);
const payloadColumn = z.record(z.string(), z.unknown());

/** `Task.links`, parsed with the same lenient rule the serializers use. */
export const parseLinksColumn = (raw: string): TaskLink[] => parseJsonColumn(raw, linksColumn, []);

/** `Decision.options`, parsed with the same lenient rule the serializers use. */
export const parseOptionsColumn = (raw: string): DecisionOption[] =>
  parseJsonColumn(raw, optionsColumn, []);

/* ------------------------------------------------------------------ *
 * Serializers
 * ------------------------------------------------------------------ */

export const serializeComment = (row: CommentRow): Comment => ({
  id: row.id,
  taskId: row.taskId,
  author: row.author,
  kind: row.kind as CommentKind,
  body: row.body,
  createdAt: toIso(row.createdAt),
});

export const serializeDecision = (row: DecisionRow): Decision => ({
  id: row.id,
  taskId: row.taskId,
  status: row.status as DecisionStatus,
  question: row.question,
  options: parseOptionsColumn(row.options),
  recommendedOption: row.recommendedOption,
  context: row.context,
  requestedBy: row.requestedBy,
  choice: row.choice,
  note: row.note,
  answeredBy: row.answeredBy,
  createdAt: toIso(row.createdAt),
  answeredAt: toIsoOrNull(row.answeredAt),
});

export const serializeTaskRef = (row: TaskRefRow): TaskRef => ({
  id: row.id,
  reference: formatReference(row.id),
  title: row.title,
  status: row.status as TaskStatus,
  project: row.project,
});

/**
 * A lease that has run out serializes as `null`: to every consumer an expired
 * claim means exactly what no claim means — anyone may take the task. `now` is
 * injectable so a test can pin the boundary.
 */
export const serializeClaim = (row: TaskRow, now: Date = new Date()): TaskClaim | null =>
  row.claimedBy !== null && row.claimExpiresAt !== null && row.claimExpiresAt > now
    ? { actor: row.claimedBy, expiresAt: toIso(row.claimExpiresAt) }
    : null;

/**
 * List rows and the base of the detail shape.
 *
 * The enum casts are safe by construction: `status` and `priority` are `String`
 * columns whose only writers parse through the zod enums in
 * `packages/contracts` (see `docs/engineering/DATABASE.md`). Re-parsing here
 * would turn a data problem into a `ZodError` on a **read** path.
 *
 * The relations are **required**, not defaulted. This module exists so no route
 * can forget a field; a default would turn a forgotten `include` into every task
 * quietly reporting 0 comments and no decision, instead of a type error.
 */
export const serializeTaskSummary = (row: TaskRow & TaskSummaryRelations): TaskSummary => {
  const openDecision = row.decisions.find((decision) => decision.status === "open") ?? null;

  return {
    id: row.id,
    reference: formatReference(row.id),
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    statusNote: row.statusNote,
    concerns: row.concerns,
    needsTriage: row.needsTriage,
    priority: row.priority as TaskPriority,
    project: row.project,
    assignee: row.assignee,
    acceptanceCriteria: row.acceptanceCriteria,
    links: parseLinksColumn(row.links),
    /** Already sorted by the query's `orderBy: { label: "asc" }`. */
    labels: row.labels.map((label) => label.label),
    parentId: row.parentId,
    childCount: row._count.children,
    createdBy: row.createdBy,
    claim: serializeClaim(row),
    version: row.version,
    openDependencyCount: row.dependencies.filter((dep) => dep.dependsOn.status !== "done").length,
    openDecision: openDecision === null ? null : serializeDecision(openDecision),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    startedAt: toIsoOrNull(row.startedAt),
    completedAt: toIsoOrNull(row.completedAt),
    commentCount: row._count.comments,
  };
};

/** Single task: the summary plus the comment thread (oldest first) and relations. */
export const serializeTask = (row: TaskRow & TaskDetailRelations): Task => ({
  ...serializeTaskSummary(row),
  comments: row.comments.map(serializeComment),
  decisions: row.decisions.map(serializeDecision),
  parent: row.parent === null ? null : serializeTaskRef(row.parent),
  children: row.children.map(serializeTaskRef),
  dependencies: row.dependencies.map((dep) => serializeTaskRef(dep.dependsOn)),
  dependents: row.dependents.map((dep) => serializeTaskRef(dep.task)),
});

export const serializeEvent = (row: TaskEventRow): TaskEvent => ({
  id: row.id,
  taskId: row.taskId,
  taskTitle: row.taskTitle,
  project: row.project,
  type: row.type as TaskEventType,
  actor: row.actor,
  payload: parseJsonColumn(row.payload, payloadColumn, {}),
  createdAt: toIso(row.createdAt),
});
