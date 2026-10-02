import {
  actorKindOf,
  TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  type CreateTaskInput,
  type Task,
  type TaskFacets,
  type TaskStats,
  type TaskStatus,
  type UpdateTaskInput,
} from "@estuary/contracts";
import type { Prisma } from "@prisma/client";

import { taskNotFound, validationError } from "../lib/errors.js";
import { prisma, writeTransaction } from "../lib/prisma.js";
import { recordEvent } from "./task-events.js";
import {
  assertClaimAllowsWrite,
  assertVersion,
  guardedSelect,
  renewedLease,
  unblockDependents,
  writeTask,
} from "./task-guards.js";
import { attentionWhere } from "./task-query.js";
import { loadTask } from "./task-read.js";
import { applyTaskRanks } from "./task-status.js";

/**
 * Task CRUD, facets, and stats. Every Prisma call for these lives here; nothing
 * in this file knows about `req`, `res`, or HTTP — failures are thrown as
 * `ApiError` and `middleware/errorHandler.ts` is the only thing that writes an
 * error body (`docs/engineering/ARCHITECTURE.md`).
 *
 * Status changes are **not** here: they carry requirements and side effects and
 * live in `task-workflow.service.ts`. The list query is `task-query.ts`.
 *
 * Every write takes the acting `actor` as an argument (the route reads it off
 * `req.actor`) and records an event in the same transaction.
 */

type Db = Prisma.TransactionClient;

/* ------------------------------------------------------------------ *
 * Read
 * ------------------------------------------------------------------ */

export async function getTask(id: number): Promise<Task> {
  return loadTask(prisma, id);
}

/**
 * Distinct non-null values actually present in the table, sorted — the only
 * source of options for the assignee, project, and creator filters, which is
 * what makes their case-sensitive exact matching safe.
 *
 * `groupBy`, not `findMany` + `distinct`: Prisma's `distinct` dedupes **in
 * memory** after selecting one row per task, while `groupBy` emits a real
 * `GROUP BY` that SQLite satisfies from the column's index.
 */
export async function getTaskFacets(): Promise<TaskFacets> {
  const [assigneeRows, projectRows, labelRows, creatorRows] = await Promise.all([
    prisma.task.groupBy({
      by: ["assignee"],
      where: { assignee: { not: null } },
      orderBy: { assignee: "asc" },
    }),
    prisma.task.groupBy({
      by: ["project"],
      where: { project: { not: null } },
      orderBy: { project: "asc" },
    }),
    prisma.taskLabel.groupBy({ by: ["label"], orderBy: { label: "asc" } }),
    prisma.task.groupBy({ by: ["createdBy"], orderBy: { createdBy: "asc" } }),
  ]);

  // The `not: null` filters already exclude nulls; the predicates are for the
  // type checker, which cannot know that from the Prisma types.
  const present = (value: string | null): value is string => value !== null;

  return {
    assignees: assigneeRows.map((row) => row.assignee).filter(present),
    projects: projectRows.map((row) => row.project).filter(present),
    labels: labelRows.map((row) => row.label),
    creators: creatorRows.map((row) => row.createdBy),
  };
}

/**
 * Count per status — every status present, zero included, so a client can index
 * the record without a fallback — plus the size of the inbox: everything
 * `GET /tasks?attention=true` would list (`attentionWhere`), not just the three
 * human statuses.
 */
export async function getTaskStats(projects?: string[]): Promise<TaskStats> {
  const scope: Prisma.TaskWhereInput = projects === undefined ? {} : { project: { in: projects } };
  const [rows, needsAttention] = await Promise.all([
    prisma.task.groupBy({ by: ["status"], where: scope, _count: { _all: true } }),
    prisma.task.count({ where: { AND: [scope, attentionWhere] } }),
  ]);

  const byStatus = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<
    TaskStatus,
    number
  >;
  for (const row of rows) {
    // A status outside the enum (hand-edited row) is dropped rather than
    // reported under a key the contract does not know.
    if (row.status in byStatus) byStatus[row.status as TaskStatus] = row._count._all;
  }

  return { byStatus, needsAttention };
}

/* ------------------------------------------------------------------ *
 * Write
 * ------------------------------------------------------------------ */

/**
 * A parent must exist and must not be the task itself or one of its own
 * descendants — otherwise the subtask tree becomes a loop that every "show the
 * parent chain" view would walk forever.
 */
async function assertParentAllowed(db: Db, taskId: number | null, parentId: number): Promise<void> {
  if (taskId === parentId) {
    throw validationError({ parentId: ["A task cannot be its own parent"] });
  }

  let cursor: number | null = parentId;
  const seen = new Set<number>();
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const row: { parentId: number | null } | null = await db.task.findUnique({
      where: { id: cursor },
      select: { parentId: true },
    });
    if (row === null) {
      throw validationError({
        parentId: [
          cursor === parentId ? `Task ${parentId} does not exist` : "The parent chain is broken",
        ],
      });
    }
    if (taskId !== null && row.parentId === taskId) {
      throw validationError({ parentId: ["That would make the task its own ancestor"] });
    }
    cursor = row.parentId;
  }
}

export interface CreateTaskResult {
  task: Task;
  /** `false` when an existing task was returned for a repeated `idempotencyKey`. */
  created: boolean;
}

/**
 * Create, or replay.
 *
 * With an `idempotencyKey` that already exists **on an open task**, the stored
 * task is returned unchanged and `created` is false — even if the rest of the
 * body differs. The key identifies the *intent*, and an agent retrying after a
 * timeout must not file the same work twice. The unique index is the real
 * guard: two concurrent creates with one key both miss the pre-read, one
 * insert wins, and the loser's `P2002` is turned back into a replay here.
 *
 * When the task holding the key is `done` or `deferred`, the key no longer
 * identifies live intent — a follow-up filed months later under a recycled
 * title must not come back as the closed original. The key is retired from
 * that task (set to `null`, no version bump, no event: it is bookkeeping, not
 * a content change worth recording in either task's history) and a new task is
 * created under the same key, atomically in the same write transaction so a
 * crash between the two never leaves the key on two rows or on none.
 */
export async function createTask(input: CreateTaskInput, actor: string): Promise<CreateTaskResult> {
  const key = input.idempotencyKey;

  if (key !== undefined) {
    const existing = await prisma.task.findUnique({
      where: { idempotencyKey: key },
      select: { id: true, status: true },
    });
    if (existing !== null && !isTerminal(existing.status)) {
      return { task: await loadTask(prisma, existing.id), created: false };
    }
  }

  try {
    const task = await writeTransaction(async (tx) => {
      if (input.parentId != null) await assertParentAllowed(tx, null, input.parentId);

      if (key !== undefined) {
        // Retire the key from whichever closed task still holds it — see the
        // doc comment above. No-op (0 rows) when nothing holds it, or when the
        // holder is still open (the pre-read above would have returned it, but
        // a concurrent transition to done/deferred could have landed since).
        await tx.task.updateMany({
          where: { idempotencyKey: key, status: { in: [...TERMINAL_TASK_STATUSES] } },
          data: { idempotencyKey: null },
        });
      }

      const id = await insertTask(tx, input, actor);
      return loadTask(tx, id);
    });
    return { task, created: true };
  } catch (err) {
    if (key !== undefined && isUniqueViolation(err)) {
      const winner = await prisma.task.findUnique({
        where: { idempotencyKey: key },
        select: { id: true },
      });
      if (winner !== null) return { task: await loadTask(prisma, winner.id), created: false };
    }
    throw err;
  }
}

/**
 * The row + its `task.created` event, inside the caller's transaction. Shared by
 * `createTask` and the follow-ups a hand-off files (`task-workflow.service.ts`).
 *
 * An agent's task starts `needsTriage`: nobody has seen it yet. One the agent
 * goes on to claim at once (its own work, filed to be tracked) is cleared by
 * that claim, so only what it left for others stays in front of people.
 */
export async function insertTask(
  tx: Db,
  input: Omit<CreateTaskInput, "idempotencyKey"> & { idempotencyKey?: string | undefined },
  actor: string,
  extra: { statusNote?: string; followUpOf?: number } = {},
): Promise<number> {
  const row = await tx.task.create({
    data: applyTaskRanks({
      title: input.title,
      description: input.description,
      status: input.status,
      statusNote: extra.statusNote ?? null,
      priority: input.priority,
      project: input.project ?? null,
      assignee: input.assignee ?? null,
      acceptanceCriteria: input.acceptanceCriteria ?? null,
      links: JSON.stringify(input.links ?? []),
      labels: { create: (input.labels ?? []).map((label) => ({ label })) },
      parentId: input.parentId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      createdBy: actor,
      needsTriage: actorKindOf(actor) === "agent",
    }),
    select: { id: true },
  });

  await recordEvent(tx, {
    taskId: row.id,
    type: "task.created",
    actor,
    payload: {
      status: input.status,
      title: input.title,
      ...(extra.followUpOf === undefined ? {} : { followUpOf: extra.followUpOf }),
    },
  });
  return row.id;
}

const isTerminal = (status: string): boolean =>
  (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";

/** The PATCHable columns, in the order the event lists them. */
const PATCHABLE = [
  "title",
  "description",
  "priority",
  "project",
  "assignee",
  "acceptanceCriteria",
  "links",
  "parentId",
] as const;

/**
 * Partial update of everything except status.
 *
 * A field that resolves to its current value is dropped from the write, and a
 * body where every field is unchanged performs **no write at all** — no version
 * bump, no `updatedAt` move, no event. "Nothing changed" has to mean nothing
 * changed, or an agent re-sending the same PATCH would float the task to the
 * top of an `updatedAt` sort and invalidate every other caller's version.
 */
export async function updateTask(id: number, input: UpdateTaskInput, actor: string): Promise<Task> {
  return writeTransaction(async (tx) => {
    const existing = await tx.task.findUnique({
      where: { id },
      select: {
        ...guardedSelect,
        title: true,
        description: true,
        priority: true,
        project: true,
        assignee: true,
        acceptanceCriteria: true,
        links: true,
        parentId: true,
        needsTriage: true,
        labels: { select: { label: true }, orderBy: { label: "asc" } },
      },
    });
    if (existing === null) throw taskNotFound(id);

    const now = new Date();
    assertVersion(existing, input.expectedVersion);
    assertClaimAllowsWrite(existing, actor, now);

    const incoming: Partial<Record<(typeof PATCHABLE)[number], unknown>> = {
      ...input,
      links: input.links === undefined ? undefined : JSON.stringify(input.links),
    };

    const data: Record<string, unknown> = {};
    for (const field of PATCHABLE) {
      const value = incoming[field];
      if (value !== undefined && value !== existing[field]) data[field] = value;
    }

    // A person editing an agent's suggestion has seen it. An explicit value
    // wins: `needsTriage: false` alone is the inbox's "Accept".
    const triage = input.needsTriage ?? (actorKindOf(actor) === "human" ? false : undefined);
    if (triage !== undefined && triage !== existing.needsTriage) data.needsTriage = triage;

    // `labels` replaces the whole set (same rule as `links`), and is not a
    // column on `Task` — it lives in the `TaskLabel` join table, so it cannot
    // go through the PATCHABLE loop above. Both sides are already sorted
    // (`labelsInputSchema`'s transform; the `orderBy` on the select), so a
    // plain array comparison is exact.
    const currentLabels = existing.labels.map((row) => row.label);
    const labelsChanged =
      input.labels !== undefined &&
      (input.labels.length !== currentLabels.length ||
        input.labels.some((label, index) => label !== currentLabels[index]));

    if (Object.keys(data).length === 0 && !labelsChanged) return loadTask(tx, id);

    if (typeof data.parentId === "number") await assertParentAllowed(tx, id, data.parentId);

    await writeTask(tx, existing, {
      ...applyTaskRanks(data as { priority?: UpdateTaskInput["priority"] }),
      ...renewedLease(existing, actor, now),
    });

    if (labelsChanged) {
      await tx.taskLabel.deleteMany({ where: { taskId: id } });
      if (input.labels!.length > 0) {
        await tx.taskLabel.createMany({
          data: input.labels!.map((label) => ({ taskId: id, label })),
        });
      }
    }

    await recordEvent(tx, {
      taskId: id,
      type: "task.updated",
      actor,
      payload: { fields: labelsChanged ? [...Object.keys(data), "labels"] : Object.keys(data) },
    });

    return loadTask(tx, id);
  });
}

/**
 * Hard delete. Comments, decisions, and dependency rows cascade at the database
 * level; the events stay (their `taskId` is not a foreign key), and a
 * `task.deleted` event is added so the feed says what happened.
 *
 * Tasks that were blocked on this one are re-checked afterwards: with the
 * dependency rows gone, one of them may have nothing left to wait for.
 */
export async function deleteTask(id: number, actor: string): Promise<void> {
  await writeTransaction(async (tx) => {
    const existing = await tx.task.findUnique({
      where: { id },
      select: {
        ...guardedSelect,
        title: true,
        project: true,
        dependents: { select: { taskId: true } },
      },
    });
    if (existing === null) throw taskNotFound(id);

    assertClaimAllowsWrite(existing, actor, new Date());

    await tx.task.delete({ where: { id } });
    await recordEvent(tx, {
      taskId: id,
      type: "task.deleted",
      actor,
      // Explicit: by now the row is gone, so `recordEvent`'s own lookup would
      // stamp `null` instead of the project the task actually belonged to.
      project: existing.project,
      payload: { title: existing.title },
    });

    await unblockDependents(
      tx,
      existing.dependents.map((dep) => dep.taskId),
    );
  });
}
