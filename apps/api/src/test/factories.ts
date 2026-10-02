import type {
  CommentKind,
  DecisionOption,
  DecisionStatus,
  TaskEventType,
  TaskLink,
  TaskPriority,
  TaskStatus,
} from "@estuary/contracts";
import type { Comment, Decision, Prisma, Task, TaskDependency, TaskEvent } from "@prisma/client";

import { env } from "../lib/env.js";
import { prisma } from "../lib/prisma.js";
import { applyTaskRanks } from "../services/task-status.js";

/**
 * Explicit row builders for API tests.
 *
 * They are builders, not a fixture set: `makeTask({ status: "blocked" })`
 * declares exactly the field the assertion depends on and leaves everything else
 * to a valid default. Tests never read from the seed
 * (`docs/features/Seed_Data.md`) — a suite coupled to seed output breaks the day
 * the seed changes, and the seed's realism is worth nothing to an assertion.
 *
 * These write through Prisma directly rather than through the task service.
 * That is deliberate: a service test that arranges its data with the same
 * service call it is asserting on cannot fail when that call is wrong. The one
 * piece of production code they share is `applyTaskRanks()` — the rank columns
 * are never hand-written numbers here, so a factory row sorts exactly like a row
 * created through the API, and the "ranks stay consistent" tests assert by
 * sorting, never by reading the column.
 */

/** Who a factory row is attributed to unless a test says otherwise. */
export const TEST_HUMAN = "human:tester";

/**
 * Per-module counter, so titles are distinct without being random. Each test
 * file gets a fresh module registry, hence a fresh count — values are
 * reproducible from the file alone.
 */
let sequence = 0;

const minutesFromNow = (minutes: number): Date => new Date(Date.now() + minutes * 60_000);

/* ------------------------------------------------------------------ *
 * Tasks
 * ------------------------------------------------------------------ */

/**
 * Prisma's create input, with `status` / `priority` narrowed to the contract
 * enums (a typo'd status is a compile error, not a row no filter can find) and
 * `links` accepted as an array (the JSON column is the factory's problem).
 * The rank columns are not settable: `applyTaskRanks()` derives them. A test
 * that needs a *drifted* row arranges it with raw SQL after the insert, which
 * is also how the drift would really happen.
 */
export type MakeTaskOverrides = Omit<
  Partial<Prisma.TaskUncheckedCreateInput>,
  "status" | "priority" | "statusRank" | "priorityRank" | "links"
> & {
  status?: TaskStatus;
  priority?: TaskPriority;
  links?: TaskLink[];
};

/**
 * Insert one task and return the row.
 *
 * Defaults: `backlog` / `medium` (the API's own defaults), created by
 * `human:tester`, unassigned, no project, acceptance criteria present (so a
 * `→ todo` test has to opt *out* explicitly with `acceptanceCriteria: null`),
 * `createdAt` now. Anything a test cares about is passed in — including
 * `createdAt`, which date-range, ordering, and paging tests must control rather
 * than hope for.
 *
 * Derived columns follow the status the way the workflow service would leave
 * them, so a fixture is not silently missing what its own invariants require:
 *
 * - `in_progress` → `startedAt` now, and — if `claimedBy` is given without an
 *   expiry — a live lease of `CLAIM_LEASE_MINUTES`.
 * - `done` → `startedAt` and `completedAt` now.
 *
 * Pass `null` to opt out of any of them (key presence, not `??`: `null ??
 * implied` is the implied value, so the documented opt-out would silently do
 * nothing).
 */
export async function makeTask(overrides: MakeTaskOverrides = {}): Promise<Task> {
  sequence += 1;
  const n = sequence;

  const { status = "backlog", priority = "medium", links, ...rest } = overrides;
  const now = new Date();

  const impliedStartedAt = status === "in_progress" || status === "done" ? now : null;
  const impliedCompletedAt = status === "done" ? now : null;
  const impliedExpiry =
    status === "in_progress" && typeof rest.claimedBy === "string"
      ? minutesFromNow(env.CLAIM_LEASE_MINUTES)
      : null;

  return prisma.task.create({
    data: applyTaskRanks({
      title: `Test task ${n}`,
      description: `Description for test task ${n}. Long enough to satisfy the contract bounds.`,
      acceptanceCriteria: `Acceptance criteria for test task ${n}.`,
      createdBy: TEST_HUMAN,
      ...rest,
      links: JSON.stringify(links ?? []),
      status,
      priority,
      startedAt: "startedAt" in rest ? rest.startedAt : impliedStartedAt,
      completedAt: "completedAt" in rest ? rest.completedAt : impliedCompletedAt,
      claimExpiresAt: "claimExpiresAt" in rest ? rest.claimExpiresAt : impliedExpiry,
    }),
  });
}

/**
 * Insert `count` tasks **in order**, one at a time, so ids ascend with the
 * index. `overrides` may be a per-index function — `makeTasks(3, (i) => ({
 * createdAt: new Date(2026, 0, i + 1) }))` — which is what paging and sorting
 * tests need.
 *
 * Sequential on purpose: `Promise.all` here would interleave writes on a
 * single-writer database and make id order non-deterministic.
 */
export async function makeTasks(
  count: number,
  overrides: MakeTaskOverrides | ((index: number) => MakeTaskOverrides) = {},
): Promise<Task[]> {
  const rows: Task[] = [];
  for (let index = 0; index < count; index += 1) {
    rows.push(await makeTask(typeof overrides === "function" ? overrides(index) : overrides));
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * Claims
 * ------------------------------------------------------------------ */

/**
 * Overrides for a task `actor` is working on right now: `in_progress`, a live
 * lease. `makeTask(claimedBy("agent:a"))`.
 */
export const claimedBy = (actor: string, minutesLeft = env.CLAIM_LEASE_MINUTES) =>
  ({
    status: "in_progress",
    claimedBy: actor,
    claimExpiresAt: minutesFromNow(minutesLeft),
  }) satisfies MakeTaskOverrides;

/**
 * Overrides for a task whose holder crashed: still `in_progress`, still naming
 * the holder, but the lease ran out `minutesAgo` minutes ago.
 */
export const expiredClaimBy = (actor: string, minutesAgo = 5) =>
  ({
    status: "in_progress",
    claimedBy: actor,
    claimExpiresAt: minutesFromNow(-minutesAgo),
  }) satisfies MakeTaskOverrides;

/**
 * Runs an existing lease out, in the database — the way a crashed agent's
 * lease expires in production, by the clock rather than by any write.
 */
export async function expireClaim(taskId: number, minutesAgo = 1): Promise<void> {
  await prisma.task.update({
    where: { id: taskId },
    data: { claimExpiresAt: minutesFromNow(-minutesAgo) },
  });
}

/* ------------------------------------------------------------------ *
 * Comments
 * ------------------------------------------------------------------ */

export type MakeCommentOverrides = Omit<Partial<Prisma.CommentUncheckedCreateInput>, "kind"> & {
  taskId: number;
  kind?: CommentKind;
};

/**
 * Insert one comment. `taskId` is required rather than defaulted to a
 * freshly-created task: a comment whose parent the test did not name is a
 * comment the test cannot assert about.
 *
 * Note that this does **not** touch `Task.updatedAt` — the same guarantee the
 * comment routes make for non-holders (`docs/features/Comments.md`), so a
 * fixture cannot manufacture a passing test for it.
 */
export async function makeComment(overrides: MakeCommentOverrides): Promise<Comment> {
  sequence += 1;
  const n = sequence;

  return prisma.comment.create({
    data: {
      author: TEST_HUMAN,
      body: `Comment body ${n}`,
      kind: "note",
      ...overrides,
    },
  });
}

/* ------------------------------------------------------------------ *
 * Decisions
 * ------------------------------------------------------------------ */

export type MakeDecisionOverrides = Omit<
  Partial<Prisma.DecisionUncheckedCreateInput>,
  "status" | "options"
> & {
  taskId: number;
  status?: DecisionStatus;
  options?: DecisionOption[];
};

export const DEFAULT_OPTIONS: DecisionOption[] = [
  { label: "Keep the endpoint", description: "Ship behind a flag" },
  { label: "Remove the endpoint" },
];

/**
 * Insert one decision row. It does **not** move the task to
 * `needs_user_decision` — pair it with `makeTask({ status:
 * "needs_user_decision" })`, or use `makeTaskAwaitingDecision()`, so a test that
 * wants the inconsistent combination (an open decision on a `todo` task) can
 * arrange it on purpose.
 */
export async function makeDecision(overrides: MakeDecisionOverrides): Promise<Decision> {
  const { options, ...rest } = overrides;

  return prisma.decision.create({
    data: {
      question: "Should the legacy endpoint stay?",
      requestedBy: "agent:planner",
      ...rest,
      options: JSON.stringify(options ?? DEFAULT_OPTIONS),
    },
  });
}

/** A task in `needs_user_decision` with one open decision, as a transition would leave it. */
export async function makeTaskAwaitingDecision(
  overrides: MakeTaskOverrides = {},
  decision: Omit<MakeDecisionOverrides, "taskId"> = {},
): Promise<{ task: Task; decision: Decision }> {
  const question = decision.question ?? "Should the legacy endpoint stay?";
  const task = await makeTask({
    status: "needs_user_decision",
    statusNote: question,
    ...overrides,
  });
  return { task, decision: await makeDecision({ taskId: task.id, question, ...decision }) };
}

/* ------------------------------------------------------------------ *
 * Dependencies
 * ------------------------------------------------------------------ */

/** `taskId` depends on `dependsOnId` — `taskId` cannot start until `dependsOnId` is done. */
export async function makeDependency(taskId: number, dependsOnId: number): Promise<TaskDependency> {
  return prisma.taskDependency.create({ data: { taskId, dependsOnId } });
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

export type MakeEventOverrides = Omit<
  Partial<Prisma.TaskEventUncheckedCreateInput>,
  "type" | "payload"
> & {
  taskId: number;
  type?: TaskEventType;
  payload?: Record<string, unknown>;
};

/** Insert one event row directly — for feed tests that need exact ids and no task. */
export async function makeEvent(overrides: MakeEventOverrides): Promise<TaskEvent> {
  const { payload, ...rest } = overrides;

  return prisma.taskEvent.create({
    data: {
      type: "task.updated",
      actor: TEST_HUMAN,
      ...rest,
      payload: JSON.stringify(payload ?? {}),
    },
  });
}

/** Every event recorded for a task, oldest first — what the feed would show for it. */
export async function eventsFor(
  taskId: number,
): Promise<{ type: string; actor: string; payload: Record<string, unknown> }[]> {
  const rows = await prisma.taskEvent.findMany({ where: { taskId }, orderBy: { id: "asc" } });
  return rows.map((row) => ({
    type: row.type,
    actor: row.actor,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  }));
}
