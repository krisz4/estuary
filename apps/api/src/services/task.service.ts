import {
  HUMAN_ATTENTION_STATUSES,
  TASK_STATUSES,
  type CreateTaskInput,
  type Task,
  type TaskFacets,
  type TaskStats,
  type TaskStatus,
  type UpdateTaskInput,
} from "@helpdesk/contracts";
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
  const [assigneeRows, projectRows, creatorRows] = await Promise.all([
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
    prisma.task.groupBy({ by: ["createdBy"], orderBy: { createdBy: "asc" } }),
  ]);

  // The `not: null` filters already exclude nulls; the predicates are for the
  // type checker, which cannot know that from the Prisma types.
  const present = (value: string | null): value is string => value !== null;

  return {
    assignees: assigneeRows.map((row) => row.assignee).filter(present),
    projects: projectRows.map((row) => row.project).filter(present),
    creators: creatorRows.map((row) => row.createdBy),
  };
}

/**
 * Count per status — every status present, zero included, so a client can index
 * the record without a fallback — plus the size of the inbox.
 */
export async function getTaskStats(projects?: string[]): Promise<TaskStats> {
  const rows = await prisma.task.groupBy({
    by: ["status"],
    where: projects === undefined ? {} : { project: { in: projects } },
    _count: { _all: true },
  });

  const byStatus = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<
    TaskStatus,
    number
  >;
  for (const row of rows) {
    // A status outside the enum (hand-edited row) is dropped rather than
    // reported under a key the contract does not know.
    if (row.status in byStatus) byStatus[row.status as TaskStatus] = row._count._all;
  }

  const needsAttention = HUMAN_ATTENTION_STATUSES.reduce(
    (sum, status) => sum + byStatus[status],
    0,
  );
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
 * With an `idempotencyKey` that already exists, the stored task is returned
 * unchanged and `created` is false — even if the rest of the body differs. The
 * key identifies the *intent*, and an agent retrying after a timeout must not
 * file the same work twice. The unique index is the real guard: two concurrent
 * creates with one key both miss the pre-read, one insert wins, and the loser's
 * `P2002` is turned back into a replay here.
 */
export async function createTask(input: CreateTaskInput, actor: string): Promise<CreateTaskResult> {
  const key = input.idempotencyKey;

  if (key !== undefined) {
    const existing = await prisma.task.findUnique({
      where: { idempotencyKey: key },
      select: { id: true },
    });
    if (existing !== null) return { task: await loadTask(prisma, existing.id), created: false };
  }

  try {
    const task = await writeTransaction(async (tx) => {
      if (input.parentId != null) await assertParentAllowed(tx, null, input.parentId);

      const row = await tx.task.create({
        data: applyTaskRanks({
          title: input.title,
          description: input.description,
          status: input.status,
          priority: input.priority,
          project: input.project ?? null,
          assignee: input.assignee ?? null,
          acceptanceCriteria: input.acceptanceCriteria ?? null,
          links: JSON.stringify(input.links ?? []),
          parentId: input.parentId ?? null,
          idempotencyKey: key ?? null,
          createdBy: actor,
        }),
        select: { id: true },
      });

      await recordEvent(tx, {
        taskId: row.id,
        type: "task.created",
        actor,
        payload: { status: input.status, title: input.title },
      });

      return loadTask(tx, row.id);
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

    if (Object.keys(data).length === 0) return loadTask(tx, id);

    if (typeof data.parentId === "number") await assertParentAllowed(tx, id, data.parentId);

    await writeTask(tx, existing, {
      ...applyTaskRanks(data as { priority?: UpdateTaskInput["priority"] }),
      ...renewedLease(existing, actor, now),
    });
    await recordEvent(tx, {
      taskId: id,
      type: "task.updated",
      actor,
      payload: { fields: Object.keys(data) },
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
      select: { ...guardedSelect, title: true, dependents: { select: { taskId: true } } },
    });
    if (existing === null) throw taskNotFound(id);

    assertClaimAllowsWrite(existing, actor, new Date());

    await tx.task.delete({ where: { id } });
    await recordEvent(tx, {
      taskId: id,
      type: "task.deleted",
      actor,
      payload: { title: existing.title },
    });

    await unblockDependents(
      tx,
      existing.dependents.map((dep) => dep.taskId),
    );
  });
}
