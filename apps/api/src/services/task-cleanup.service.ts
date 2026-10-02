import {
  actorKindOf,
  SYSTEM_ACTOR,
  type CleanupDoneTasksInput,
  type CleanupDoneTasksResponse,
  type TaskStatus,
} from "@estuary/contracts";
import type { Prisma } from "@prisma/client";

import { env } from "../lib/env.js";
import { actorNotPermitted } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { prisma, writeTransaction } from "../lib/prisma.js";
import { recordEvent } from "./task-events.js";
import { unblockDependents } from "./task-guards.js";

/**
 * Bulk hard-delete of `done` tasks (`docs/features/Task_Cleanup.md`): the
 * human-triggered `POST /tasks/cleanup`, and the retention sweep the API
 * process runs on its own when `DONE_RETENTION_DAYS` is set.
 *
 * Each deleted task gets the same `task.deleted` event a single `DELETE` would
 * record, plus `reason: "cleanup"`, so the Logbook still says what happened and
 * `history` numbers (which are event-based) are unaffected.
 */

const DONE: TaskStatus = "done";
const DAY_MS = 86_400_000;

/**
 * `completedAt` is set on every move to `done`; `updatedAt` is only the fallback
 * for a row that predates it or was hand-edited, so such a task is not kept
 * forever just because the stamp is missing.
 */
function doneWhere(input: CleanupDoneTasksInput, now: Date): Prisma.TaskWhereInput {
  const where: Prisma.TaskWhereInput = { status: DONE };
  if (input.project !== undefined) where.project = { in: input.project };

  if (input.olderThanDays !== undefined && input.olderThanDays > 0) {
    const cutoff = new Date(now.getTime() - input.olderThanDays * DAY_MS);
    where.OR = [{ completedAt: { lt: cutoff } }, { completedAt: null, updatedAt: { lt: cutoff } }];
  }
  return where;
}

/**
 * Agents are refused outright, dry run included: deleting finished work in bulk
 * is a human's call (or the operator's, via the retention setting), the same way
 * closing a task is.
 */
export async function cleanupDoneTasks(
  input: CleanupDoneTasksInput,
  actor: string,
  now: Date = new Date(),
): Promise<CleanupDoneTasksResponse> {
  if (actorKindOf(actor) === "agent") {
    throw actorNotPermitted("Only a human can clean up done tasks");
  }

  const dryRun = input.dryRun ?? false;
  if (dryRun) {
    const rows = await prisma.task.findMany({
      where: doneWhere(input, now),
      select: { id: true },
      orderBy: { id: "asc" },
    });
    const taskIds = rows.map((row) => row.id);
    return { deleted: taskIds.length, taskIds, dryRun };
  }

  // The selection is re-read inside the write transaction, so a task reopened
  // between a dry run and this call is not deleted.
  const taskIds = await writeTransaction(async (tx) => {
    const rows = await tx.task.findMany({
      where: doneWhere(input, now),
      select: {
        id: true,
        title: true,
        project: true,
        dependents: { select: { taskId: true } },
      },
      orderBy: { id: "asc" },
    });
    if (rows.length === 0) return [];

    const ids = rows.map((row) => row.id);
    // Comments, decisions, labels, and dependency rows cascade; subtasks of a
    // deleted parent survive with `parentId` set to null.
    await tx.task.deleteMany({ where: { id: { in: ids } } });

    for (const row of rows) {
      await recordEvent(tx, {
        taskId: row.id,
        type: "task.deleted",
        actor,
        project: row.project,
        payload: { title: row.title, reason: "cleanup" },
      });
    }

    // A done dependency never blocked anyone, so this should find nothing — but
    // it keeps the rule "every delete re-checks its dependents" without exceptions.
    const deleted = new Set(ids);
    const dependents = rows
      .flatMap((row) => row.dependents.map((dep) => dep.taskId))
      .filter((id) => !deleted.has(id));
    await unblockDependents(tx, [...new Set(dependents)]);

    return ids;
  });

  return { deleted: taskIds.length, taskIds, dryRun };
}

/* ------------------------------------------------------------------ *
 * Retention sweep
 * ------------------------------------------------------------------ */

/** How often the sweep runs after the one at boot. */
export const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** One pass: delete tasks done for longer than `days`, as `system:taskmanager`. */
export async function sweepDoneTasks(days: number, now: Date = new Date()) {
  const result = await cleanupDoneTasks({ olderThanDays: days }, SYSTEM_ACTOR, now);
  if (result.deleted > 0) {
    logger.info("Retention sweep deleted done tasks", {
      deleted: result.deleted,
      olderThanDays: days,
    });
  }
  return result;
}

/**
 * Starts the periodic sweep when `DONE_RETENTION_DAYS` is above 0, and returns
 * a stop function. The timer is `unref()`ed so it never holds the process open
 * on shutdown; a failed pass is logged and retried on the next tick rather than
 * taking the server down.
 */
export function startRetentionSweep(days: number = env.DONE_RETENTION_DAYS): () => void {
  if (days <= 0) return () => {};

  const run = (): void => {
    sweepDoneTasks(days).catch((err: unknown) => {
      logger.error("Retention sweep failed", { err });
    });
  };

  run();
  const timer = setInterval(run, RETENTION_SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
