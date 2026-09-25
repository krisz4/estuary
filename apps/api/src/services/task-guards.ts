import { actorKindOf, SYSTEM_ACTOR, type TaskStatus } from "@helpdesk/contracts";
import type { Prisma } from "@prisma/client";

import { env } from "../lib/env.js";
import {
  dependencyCycle,
  taskAlreadyClaimed,
  validationError,
  versionConflict,
} from "../lib/errors.js";
import { recordEvent } from "./task-events.js";
import { applyTaskRanks } from "./task-status.js";

/**
 * The rules every task write shares: versions, claims, dependency integrity,
 * and auto-unblocking. Pure functions where possible; the rest take the
 * transaction client so they run inside the caller's commit.
 * See `docs/features/Task_Workflow_API.md` § Rules that cut across endpoints.
 */

type Db = Prisma.TransactionClient;

/** The columns the guards read. Every write path selects at least these. */
export interface GuardedTask {
  id: number;
  version: number;
  status: string;
  claimedBy: string | null;
  claimExpiresAt: Date | null;
}

export const guardedSelect = {
  id: true,
  version: true,
  status: true,
  claimedBy: true,
  claimExpiresAt: true,
} satisfies Prisma.TaskSelect;

/* ------------------------------------------------------------------ *
 * Versions
 * ------------------------------------------------------------------ */

export function assertVersion(task: GuardedTask, expected: number | undefined): void {
  if (expected !== undefined && expected !== task.version) {
    throw versionConflict(expected, task.version);
  }
}

/**
 * The write itself is conditional on the version the caller's transaction read,
 * so a concurrent writer that slipped in between the read and this statement
 * turns into a `VERSION_CONFLICT` rather than a lost update. `updateMany`
 * because it is the only Prisma update that accepts a non-unique `where` and
 * reports a count instead of throwing.
 */
export async function writeTask(
  db: Db,
  task: GuardedTask,
  data: Prisma.TaskUncheckedUpdateManyInput,
): Promise<void> {
  const { count } = await db.task.updateMany({
    where: { id: task.id, version: task.version },
    data: { ...data, version: task.version + 1 },
  });

  if (count === 0) {
    const current = await db.task.findUnique({ where: { id: task.id }, select: { version: true } });
    throw versionConflict(task.version, current?.version ?? task.version);
  }
}

/* ------------------------------------------------------------------ *
 * Claims
 * ------------------------------------------------------------------ */

export const leaseExpiry = (now: Date): Date =>
  new Date(now.getTime() + env.CLAIM_LEASE_MINUTES * 60_000);

/** The claim, if it is still live at `now`. */
export function liveClaim(
  task: GuardedTask,
  now: Date,
): { claimedBy: string; expiresAt: Date } | null {
  return task.claimedBy !== null && task.claimExpiresAt !== null && task.claimExpiresAt > now
    ? { claimedBy: task.claimedBy, expiresAt: task.claimExpiresAt }
    : null;
}

/**
 * While anyone holds a live claim, **agents** other than the holder may not
 * write the task. Humans always may — a person overriding a stuck or wrong agent
 * is the point of having a person in the loop.
 */
export function assertClaimAllowsWrite(task: GuardedTask, actor: string, now: Date): void {
  const claim = liveClaim(task, now);
  if (claim === null || claim.claimedBy === actor) return;
  if (actorKindOf(actor) !== "agent") return;

  throw taskAlreadyClaimed(claim.claimedBy, claim.expiresAt);
}

/** Any write by the claim holder renews its lease — activity is a heartbeat. */
export const renewedLease = (
  task: GuardedTask,
  actor: string,
  now: Date,
): { claimExpiresAt?: Date } =>
  task.status === "in_progress" && task.claimedBy === actor
    ? { claimExpiresAt: leaseExpiry(now) }
    : {};

/* ------------------------------------------------------------------ *
 * Dependencies
 * ------------------------------------------------------------------ */

/**
 * Validates `taskId → dependsOnId` before it is inserted: not self, the target
 * exists, and the new edge does not close a loop.
 *
 * The cycle check walks **forward from the target**: if `dependsOnId` already
 * (transitively) depends on `taskId`, adding the edge makes a cycle. The walk
 * is breadth-first with one query per frontier, which is plenty for a task
 * board's dependency depth; `details.path` is the loop the edge would close,
 * starting and ending at `taskId`.
 */
export async function assertDependencyAllowed(
  db: Db,
  taskId: number,
  dependsOnId: number,
  field = "dependsOnId",
): Promise<void> {
  if (taskId === dependsOnId) {
    throw validationError({ [field]: ["A task cannot depend on itself"] });
  }

  const target = await db.task.findUnique({ where: { id: dependsOnId }, select: { id: true } });
  if (target === null) {
    throw validationError({ [field]: [`Task ${dependsOnId} does not exist`] });
  }

  const cameFrom = new Map<number, number>();
  let frontier = [dependsOnId];
  const seen = new Set(frontier);

  while (frontier.length > 0) {
    const edges = await db.taskDependency.findMany({
      where: { taskId: { in: frontier } },
      select: { taskId: true, dependsOnId: true },
    });

    const next: number[] = [];
    for (const edge of edges) {
      if (seen.has(edge.dependsOnId)) continue;
      seen.add(edge.dependsOnId);
      cameFrom.set(edge.dependsOnId, edge.taskId);

      if (edge.dependsOnId === taskId) {
        const path = [taskId];
        for (let node = taskId; node !== dependsOnId;) {
          node = cameFrom.get(node) ?? dependsOnId;
          path.unshift(node);
        }
        throw dependencyCycle([taskId, ...path]);
      }
      next.push(edge.dependsOnId);
    }
    frontier = next;
  }
}

/**
 * Moves every `blocked` task among `candidateIds` whose dependencies are now all
 * `done` to `todo`, as `system:taskmanager`.
 *
 * Called after anything that can finish a blocker: a task reaching `done`, a
 * task being deleted (its dependency rows cascade away), a dependency being
 * removed. A task blocked only by a written reason has no dependency rows and is
 * never touched here — nothing the server can observe says that reason is gone.
 *
 * The acceptance-criteria gate on `→ todo` is not applied: the task was ready
 * enough to be worked before it was blocked.
 */
export async function unblockDependents(db: Db, candidateIds: number[]): Promise<void> {
  if (candidateIds.length === 0) return;

  const ready = await db.task.findMany({
    where: {
      id: { in: candidateIds },
      status: "blocked",
      dependencies: { none: { dependsOn: { status: { not: "done" } } } },
    },
    select: guardedSelect,
  });

  const note = "Unblocked: no unfinished dependencies remain";
  for (const task of ready) {
    const to: TaskStatus = "todo";
    await writeTask(db, task, { ...applyTaskRanks({ status: to }), statusNote: note });
    await recordEvent(db, {
      taskId: task.id,
      type: "task.status_changed",
      actor: SYSTEM_ACTOR,
      payload: { from: task.status, to, note },
    });
  }
}
