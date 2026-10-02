import type { Task, TaskSummary } from "@estuary/contracts";
import type { Prisma } from "@prisma/client";

import { taskNotFound } from "../lib/errors.js";
import { serializeTask, serializeTaskSummary } from "../lib/serialize.js";

/**
 * The read shapes every task service shares, in one place so the list, the
 * detail, and every write that returns the task it just changed load exactly
 * the same relations. `lib/serialize.ts` declares the matching row types, so a
 * read that drops one of these is a compile error at the serializer call.
 */

type Db = Prisma.TransactionClient;

/** A related task, reduced to what `TaskRef` shows. `project` lets a dependency
 * pointer cross repositories without a second lookup. */
const refSelect = {
  id: true,
  title: true,
  status: true,
  project: true,
} satisfies Prisma.TaskSelect;

/**
 * What a list row needs beyond its own columns: the comment count, the child
 * count (an epic in a list), the open decision (the inbox renders it inline),
 * each dependency's status (to count the unfinished ones), and the label set.
 * One query per relation, not per row — Prisma batches an `include` across the
 * page.
 */
export const summaryInclude = {
  _count: { select: { comments: true, children: true } },
  decisions: { where: { status: "open" } },
  dependencies: { select: { dependsOn: { select: { status: true } } } },
  labels: { select: { label: true }, orderBy: { label: "asc" } },
} satisfies Prisma.TaskInclude;

/**
 * The detail adds the thread, the relation lists, and the full decision history
 * (the summary's `decisions` include is narrowed to the open one; this widens it,
 * and the serializer picks the open one out of the full list).
 *
 * Comments come back oldest-first, `createdAt` then `id`. The `id` tiebreaker is
 * load-bearing: several comments can land inside the same millisecond (the seed
 * does it on purpose), and without it their order would differ between reads.
 */
export const detailInclude = {
  ...summaryInclude,
  decisions: { orderBy: { id: "desc" } },
  comments: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
  parent: { select: refSelect },
  children: { select: refSelect, orderBy: { id: "asc" } },
  dependencies: {
    select: { dependsOn: { select: refSelect } },
    orderBy: { dependsOnId: "asc" },
  },
  dependents: { select: { task: { select: refSelect } }, orderBy: { taskId: "asc" } },
} satisfies Prisma.TaskInclude;

/** Load and serialize one task, or throw `TASK_NOT_FOUND`. */
export async function loadTask(db: Db, id: number): Promise<Task> {
  const row = await db.task.findUnique({ where: { id }, include: detailInclude });
  if (row === null) throw taskNotFound(id);
  return serializeTask(row);
}

export async function loadTaskSummaries(
  db: Db,
  args: Omit<Prisma.TaskFindManyArgs, "include" | "select">,
): Promise<TaskSummary[]> {
  const rows = await db.task.findMany({ ...args, include: summaryInclude });
  return rows.map(serializeTaskSummary);
}
