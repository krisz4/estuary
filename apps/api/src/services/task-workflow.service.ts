import {
  actorKindOf,
  TERMINAL_TASK_STATUSES,
  type AnswerDecisionInput,
  type FollowUpInput,
  type NextTaskInput,
  type ReleaseTaskInput,
  type Task,
  type TaskLink,
  type TaskStatus,
  type TransitionInput,
} from "@estuary/contracts";
import type { Prisma } from "@prisma/client";

import { env } from "../lib/env.js";
import {
  actorNotPermitted,
  noOpenDecision,
  notClaimHolder,
  taskNotFound,
  validationError,
} from "../lib/errors.js";
import { prisma, writeTransaction } from "../lib/prisma.js";
import { parseLinksColumn, parseOptionsColumn } from "../lib/serialize.js";
import { recordEvent } from "./task-events.js";
import {
  assertClaimAllowsWrite,
  assertDependencyAllowed,
  assertVersion,
  guardedSelect,
  leaseExpiry,
  liveClaim,
  unblockDependents,
  writeTask,
} from "./task-guards.js";
import { loadTask } from "./task-read.js";
import { insertTask } from "./task.service.js";
import {
  applyStatusSideEffects,
  applyTaskRanks,
  PRIORITY_RANK,
  statusNoteFor,
} from "./task-status.js";

/**
 * The agent-facing workflow: transitions, claims, `next`, decisions, and
 * dependencies. See `docs/features/Task_Workflow_API.md` and
 * `docs/features/Task_Status_Lifecycle.md`.
 *
 * Every function reads, checks, and writes inside one transaction, and every
 * task write goes through `writeTask()`, which is conditional on the version
 * the transaction read — so a concurrent change surfaces as `VERSION_CONFLICT`
 * instead of being silently overwritten.
 */

type Db = Prisma.TransactionClient;

const workflowSelect = {
  ...guardedSelect,
  acceptanceCriteria: true,
  links: true,
  startedAt: true,
  project: true,
  labels: { select: { label: true }, orderBy: { label: "asc" } },
  decisions: { where: { status: "open" }, select: { id: true } },
} satisfies Prisma.TaskSelect;

type WorkflowTask = Prisma.TaskGetPayload<{ select: typeof workflowSelect }>;

async function loadForWrite(db: Db, id: number): Promise<WorkflowTask> {
  const row = await db.task.findUnique({ where: { id }, select: workflowSelect });
  if (row === null) throw taskNotFound(id);
  return row;
}

async function withdrawOpenDecisions(db: Db, task: WorkflowTask, actor: string): Promise<void> {
  for (const decision of task.decisions) {
    await db.decision.update({ where: { id: decision.id }, data: { status: "withdrawn" } });
    await recordEvent(db, {
      taskId: task.id,
      type: "decision.withdrawn",
      actor,
      payload: { decisionId: decision.id },
    });
  }
}

/**
 * Whether a write takes the task out of the "suggested" pile. A person's write
 * means a person has seen it; a claim or a close means it is being — or has
 * been — dealt with, by whoever. An agent merely moving its own suggestion
 * around (refining it into `todo`) leaves it in front of people.
 */
const clearsTriage = (actor: string, to: TaskStatus): boolean =>
  actorKindOf(actor) !== "agent" || to === "in_progress" || to === "done" || to === "deferred";

/**
 * Files the follow-ups an agent attached to its hand-off as subtasks of `task`
 * — see `followUpInputSchema`. A title that is already an open subtask is
 * skipped, so a retried hand-off does not file it twice.
 */
async function fileFollowUps(
  db: Db,
  task: WorkflowTask,
  followUps: FollowUpInput[] | undefined,
  actor: string,
): Promise<void> {
  if (followUps === undefined || followUps.length === 0) return;

  const open = await db.task.findMany({
    where: { parentId: task.id, status: { notIn: [...TERMINAL_TASK_STATUSES] } },
    select: { title: true },
  });
  const taken = new Set(open.map((row) => row.title.toLowerCase()));

  for (const followUp of followUps) {
    const key = followUp.title.toLowerCase();
    if (taken.has(key)) continue;
    taken.add(key);

    const ready = Boolean(followUp.acceptanceCriteria);
    await insertTask(
      db,
      {
        title: followUp.title,
        description: followUp.description,
        status: ready ? "todo" : "needs_refinement",
        priority: followUp.priority ?? "medium",
        project: task.project,
        acceptanceCriteria: followUp.acceptanceCriteria ?? null,
        labels: task.labels.map((row) => row.label),
        parentId: task.id,
      },
      actor,
      {
        followUpOf: task.id,
        ...(ready
          ? {}
          : {
              statusNote:
                followUp.missing ??
                "Filed as a follow-up without acceptance criteria — say what done looks like.",
            }),
      },
    );
  }
}

/** Appends links, skipping any URL the task already has. */
const mergeLinks = (existing: TaskLink[], added: TaskLink[]): TaskLink[] => {
  const seen = new Set(existing.map((link) => link.url));
  return [...existing, ...added.filter((link) => !seen.has(link.url) && seen.add(link.url))];
};

/* ------------------------------------------------------------------ *
 * Transition
 * ------------------------------------------------------------------ */

/**
 * The one way a status changes (besides `next`, `release`, answering a
 * decision, and the system's auto-unblock, which all end in the same write).
 *
 * The payload has already been shaped by `transitionInputSchema`, so what is
 * checked here is only what needs the stored row: the version, the claim, the
 * acceptance criteria a `todo` needs, and dependency integrity for `blocked`.
 *
 * A same-status transition is allowed and does write — `blocked → blocked` with
 * a new reason is how a blocker gets updated — except that the claim of an
 * agent re-entering `in_progress` is simply renewed.
 */
export async function transitionTask(
  id: number,
  input: TransitionInput,
  actor: string,
): Promise<Task> {
  return writeTransaction(async (tx) => {
    const task = await loadForWrite(tx, id);
    const now = new Date();
    const from = task.status as TaskStatus;
    const to = input.to;

    assertVersion(task, input.expectedVersion);
    assertClaimAllowsWrite(task, actor, now);

    if (to === "done" && actorKindOf(actor) === "agent" && !env.AGENTS_MAY_COMPLETE) {
      throw actorNotPermitted(
        "Agents hand finished work to needs_qa; a human moves it to done " +
          "(or run the server with AGENTS_MAY_COMPLETE=true)",
      );
    }

    const data: Prisma.TaskUncheckedUpdateManyInput = {
      ...applyTaskRanks({ status: to }),
      statusNote: statusNoteFor(input),
      // Only a needs_qa hand-off carries concerns; any other move drops them.
      concerns: input.to === "needs_qa" ? (input.concerns ?? null) : null,
      ...applyStatusSideEffects(from, to, task, now),
      ...(clearsTriage(actor, to) ? { needsTriage: false } : {}),
    };

    if (input.to === "todo") {
      const criteria =
        input.acceptanceCriteria === undefined ? task.acceptanceCriteria : input.acceptanceCriteria;
      if (!criteria) {
        throw validationError({
          acceptanceCriteria: ["Acceptance criteria are required before a task can be todo"],
        });
      }
      if (input.acceptanceCriteria !== undefined)
        data.acceptanceCriteria = input.acceptanceCriteria;
    }

    if (input.to === "needs_qa" && input.links !== undefined) {
      data.links = JSON.stringify(mergeLinks(parseLinksColumn(task.links), input.links));
    }

    // Claim: taken (or renewed) on entering in_progress, dropped on leaving it.
    const claimed = to === "in_progress";
    const heldBefore = liveClaim(task, now);
    data.claimedBy = claimed ? actor : null;
    data.claimExpiresAt = claimed ? leaseExpiry(now) : null;

    if (input.to === "blocked") {
      for (const dependsOnId of input.blockedBy ?? []) {
        await addDependencyRow(tx, id, dependsOnId, actor, "blockedBy");
      }

      // Blocked on nothing but finished work is a task that would sit in
      // `blocked` forever: auto-unblock only fires when a dependency changes,
      // and none of these ever will. Without a written reason, refuse it.
      if (input.reason === undefined) {
        const open = await tx.taskDependency.count({
          where: { taskId: id, dependsOn: { status: { not: "done" } } },
        });
        if (open === 0) {
          throw validationError({
            blockedBy: ["Every task in blockedBy is already done — nothing to wait for"],
          });
        }
      }
    }

    // Leaving needs_user_decision — or re-entering it with a new question —
    // withdraws the open decision instead of leaving it dangling.
    await withdrawOpenDecisions(tx, task, actor);

    await writeTask(tx, task, data);
    await recordEvent(tx, {
      taskId: id,
      type: "task.status_changed",
      actor,
      payload: { from, to, note: data.statusNote ?? null },
    });

    if (claimed && heldBefore?.claimedBy !== actor) {
      await recordEvent(tx, {
        taskId: id,
        type: "task.claimed",
        actor,
        payload: { expiresAt: (data.claimExpiresAt as Date).toISOString() },
      });
    }

    if (input.to === "needs_user_decision") {
      const { decision } = input;
      const created = await tx.decision.create({
        data: {
          taskId: id,
          question: decision.question,
          options: JSON.stringify(decision.options),
          recommendedOption: decision.recommendedOption ?? null,
          context: decision.context ?? null,
          requestedBy: actor,
        },
        select: { id: true },
      });
      await recordEvent(tx, {
        taskId: id,
        type: "decision.requested",
        actor,
        payload: { decisionId: created.id, question: decision.question },
      });
    }

    if (to === "done") await unblockDependentsOf(tx, id);
    if (input.to === "needs_qa") await fileFollowUps(tx, task, input.followUps, actor);

    return loadTask(tx, id);
  });
}

async function unblockDependentsOf(db: Db, id: number): Promise<void> {
  const dependents = await db.taskDependency.findMany({
    where: { dependsOnId: id },
    select: { taskId: true },
  });
  await unblockDependents(
    db,
    dependents.map((dep) => dep.taskId),
  );
}

/* ------------------------------------------------------------------ *
 * Claims
 * ------------------------------------------------------------------ */

/** `POST /tasks/:taskId/claim` — exactly a transition to `in_progress`. */
export const claimTask = (
  id: number,
  expectedVersion: number | undefined,
  actor: string,
): Promise<Task> =>
  transitionTask(
    id,
    expectedVersion === undefined ? { to: "in_progress" } : { to: "in_progress", expectedVersion },
    actor,
  );

/**
 * The holder extends its lease. Allowed on an *expired* lease too, as long as
 * nobody else has taken the task in the meantime — an agent that paused past
 * its lease and comes back should not have to re-claim its own work.
 *
 * No version bump: the lease is bookkeeping, not content, and bumping the
 * version would make every heartbeat a `VERSION_CONFLICT` for a human editing
 * the same task. (`updatedAt` does move — Prisma manages it on every update.)
 */
export async function heartbeatTask(id: number, actor: string): Promise<Task> {
  return writeTransaction(async (tx) => {
    const task = await loadForWrite(tx, id);
    const now = new Date();

    if (task.status !== "in_progress" || task.claimedBy !== actor) {
      throw notClaimHolder(liveClaim(task, now));
    }

    await tx.task.update({ where: { id }, data: { claimExpiresAt: leaseExpiry(now) } });
    return loadTask(tx, id);
  });
}

/**
 * The holder gives the task up: back to `todo`, claim cleared, so another agent
 * can take it. A human may release anyone's claim (that is how a stuck task is
 * freed without waiting out the lease); an agent only its own.
 */
export async function releaseTask(
  id: number,
  input: ReleaseTaskInput,
  actor: string,
): Promise<Task> {
  return writeTransaction(async (tx) => {
    const task = await loadForWrite(tx, id);
    const now = new Date();

    assertVersion(task, input.expectedVersion);

    const mayRelease =
      task.status === "in_progress" && (task.claimedBy === actor || actorKindOf(actor) !== "agent");
    if (!mayRelease) throw notClaimHolder(liveClaim(task, now));

    const to: TaskStatus = "todo";
    const note = input.reason ?? null;

    await writeTask(tx, task, {
      ...applyTaskRanks({ status: to }),
      statusNote: note,
      claimedBy: null,
      claimExpiresAt: null,
      ...(clearsTriage(actor, to) ? { needsTriage: false } : {}),
    });
    await fileFollowUps(tx, task, input.followUps, actor);
    await recordEvent(tx, {
      taskId: id,
      type: "task.released",
      actor,
      payload: { reason: note, claimedBy: task.claimedBy },
    });
    await recordEvent(tx, {
      taskId: id,
      type: "task.status_changed",
      actor,
      payload: { from: task.status, to, note },
    });

    return loadTask(tx, id);
  });
}

/** How many candidates `next` reads per round. */
const NEXT_CANDIDATES = 10;

/**
 * How many times `next` re-reads its candidates after losing a race on every
 * one of them. Bounded so a pathological write storm cannot spin a request
 * forever; each lost round means some other write committed, so the bound is
 * only ever reached under sustained contention on the very top of the queue.
 */
const NEXT_ROUNDS = 5;

/**
 * `POST /tasks/next` — claim the best available task.
 *
 * Candidates are `todo` tasks with no unfinished dependency, plus `in_progress`
 * tasks whose *agent* lease has run out (a crashed agent's work), best first —
 * see `claimableTodo` / `claimableAbandoned`. Each is
 * taken with a **single conditional `UPDATE`** keyed on the version read: two
 * agents racing for the same row both issue the statement, and exactly one sees
 * `count === 1`; the loser moves on to the next candidate. The statement and its
 * events run in one write transaction (`lib/prisma.ts`), so they cannot
 * interleave with another write and a committed claim always has its events.
 *
 * Losing a race is not the same as there being nothing to do. Any write bumps a
 * candidate's version — a human changing its priority, another agent's `next`
 * — so when *every* candidate read in a round is lost, the candidates are read
 * again rather than answering `null` over a queue that still has work in it.
 *
 * Returns `null` — not an error — only when a fresh read finds no candidate.
 */
export async function nextTask(input: NextTaskInput, actor: string): Promise<Task | null> {
  for (let round = 0; round < NEXT_ROUNDS; round += 1) {
    const now = new Date();
    const candidates = await readNextCandidates(input, now);
    if (candidates.length === 0) return null;

    for (const candidate of candidates) {
      const claimed = await claimCandidate(candidate, actor, now);
      if (claimed !== null) return claimed;
    }
  }

  return null;
}

/**
 * What makes a task claimable by `next`, as a `where` fragment — used both to
 * find candidates and, again, inside the conditional claim itself, so nothing
 * that changed between the two (a blocker reopened, a lease renewed) slips by
 * on a version that happened not to move.
 *
 * - `todo` with no unfinished dependency. Reopening a blocker does not bump the
 *   dependent's version, which is why this is re-checked at claim time.
 * - `in_progress` whose lease has lapsed **and whose holder was an agent** (or
 *   nobody). An expired agent lease means a crashed or abandoned agent; an
 *   expired *human* lease only means a person who does not heartbeat — they are
 *   still working, and an agent taking the task over would be wrong.
 */
const claimableTodo: Prisma.TaskWhereInput = {
  status: "todo",
  dependencies: { none: { dependsOn: { status: { not: "done" } } } },
};

const claimableAbandoned = (now: Date): Prisma.TaskWhereInput => ({
  status: "in_progress",
  AND: [
    { OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lt: now } }] },
    { OR: [{ claimedBy: null }, { claimedBy: { startsWith: "agent:" } }] },
  ],
});

async function readNextCandidates(input: NextTaskInput, now: Date) {
  return prisma.task.findMany({
    where: {
      AND: [
        { OR: [claimableTodo, claimableAbandoned(now)] },
        input.project === undefined ? {} : { project: { in: input.project } },
        // Only tasks carrying at least one of these labels — how an agent in
        // one workspace of a monorepo asks for that workspace's work.
        input.label === undefined ? {} : { labels: { some: { label: { in: input.label } } } },
        input.minPriority === undefined
          ? {}
          : { priorityRank: { gte: PRIORITY_RANK[input.minPriority] } },
      ],
    },
    orderBy: [{ priorityRank: "desc" }, { createdAt: "asc" }, { id: "asc" }],
    take: NEXT_CANDIDATES,
    select: { ...guardedSelect, startedAt: true },
  });
}

type NextCandidate = Awaited<ReturnType<typeof readNextCandidates>>[number];

/** One conditional claim attempt; `null` when another write got there first. */
async function claimCandidate(
  candidate: NextCandidate,
  actor: string,
  now: Date,
): Promise<Task | null> {
  const from = candidate.status as TaskStatus;
  const to: TaskStatus = "in_progress";
  const expiresAt = leaseExpiry(now);
  const note =
    from === "in_progress" && candidate.claimedBy !== null
      ? `Reclaimed from ${candidate.claimedBy} after its lease expired`
      : null;

  // One write transaction for the claim and its events, so a committed claim
  // never lacks its `task.status_changed` / `task.claimed` entries in the feed.
  return writeTransaction(async (tx) => {
    // Eligibility is repeated here, not only in the candidate query: a
    // heartbeat (or the holder's comment) renews a lease, and a reopened
    // blocker re-blocks a todo, *without* bumping this task's version — either
    // can land between the unlocked read above and this statement.
    const { count } = await tx.task.updateMany({
      where: {
        id: candidate.id,
        version: candidate.version,
        ...(from === "todo" ? claimableTodo : claimableAbandoned(now)),
      },
      data: {
        ...applyTaskRanks({ status: to }),
        ...applyStatusSideEffects(from, to, candidate, now),
        statusNote: note,
        claimedBy: actor,
        claimExpiresAt: expiresAt,
        needsTriage: false,
        version: candidate.version + 1,
      },
    });
    if (count === 0) return null;

    await recordEvent(tx, {
      taskId: candidate.id,
      type: "task.status_changed",
      actor,
      payload: { from, to, note },
    });
    await recordEvent(tx, {
      taskId: candidate.id,
      type: "task.claimed",
      actor,
      payload: { expiresAt: expiresAt.toISOString(), via: "next" },
    });
    return loadTask(tx, candidate.id);
  });
}

/* ------------------------------------------------------------------ *
 * Decisions
 * ------------------------------------------------------------------ */

/**
 * Records the answer and hands the task back to `todo`, where the next agent to
 * pick it up finds the answer in `statusNote` and on the decision itself.
 *
 * The acceptance-criteria gate on `→ todo` does not apply: the task was already
 * in flight when the question was asked.
 */
export async function answerDecision(
  id: number,
  input: AnswerDecisionInput,
  actor: string,
): Promise<Task> {
  return writeTransaction(async (tx) => {
    const task = await loadForWrite(tx, id);
    const openId = task.decisions[0]?.id;
    if (task.status !== "needs_user_decision" || openId === undefined) throw noOpenDecision();

    const decision = await tx.decision.findUniqueOrThrow({ where: { id: openId } });
    const labels = parseOptionsColumn(decision.options).map((option) => option.label);
    if (input.choice !== undefined && !labels.includes(input.choice)) {
      throw validationError({ choice: [`Choose one of: ${labels.join(", ")}`] });
    }

    const now = new Date();
    await tx.decision.update({
      where: { id: openId },
      data: {
        status: "answered",
        choice: input.choice ?? null,
        note: input.note ?? null,
        answeredBy: actor,
        answeredAt: now,
      },
    });

    const to: TaskStatus = "todo";
    const note = `Decision: ${[input.choice, input.note].filter(Boolean).join(" — ")}`;

    // The answer is a person's, even when an agent records it from chat.
    await writeTask(tx, task, {
      ...applyTaskRanks({ status: to }),
      statusNote: note,
      needsTriage: false,
    });
    await recordEvent(tx, {
      taskId: id,
      type: "decision.answered",
      actor,
      payload: { decisionId: openId, choice: input.choice ?? null, note: input.note ?? null },
    });
    await recordEvent(tx, {
      taskId: id,
      type: "task.status_changed",
      actor,
      payload: { from: task.status, to, note },
    });

    return loadTask(tx, id);
  });
}

/* ------------------------------------------------------------------ *
 * Dependencies
 * ------------------------------------------------------------------ */

/** Inserts one edge after validating it; an edge that already exists is a no-op. */
async function addDependencyRow(
  db: Db,
  taskId: number,
  dependsOnId: number,
  actor: string,
  field: string,
): Promise<boolean> {
  const existing = await db.taskDependency.findUnique({
    where: { taskId_dependsOnId: { taskId, dependsOnId } },
  });
  if (existing !== null) return false;

  await assertDependencyAllowed(db, taskId, dependsOnId, field);
  await db.taskDependency.create({ data: { taskId, dependsOnId } });
  await recordEvent(db, { taskId, type: "dependency.added", actor, payload: { dependsOnId } });
  return true;
}

export async function addDependency(id: number, dependsOnId: number, actor: string): Promise<Task> {
  return writeTransaction(async (tx) => {
    const task = await loadForWrite(tx, id);
    assertClaimAllowsWrite(task, actor, new Date());

    const added = await addDependencyRow(tx, id, dependsOnId, actor, "dependsOnId");
    if (added) await writeTask(tx, task, {});

    return loadTask(tx, id);
  });
}

/**
 * Removing an edge that does not exist is a no-op success, like adding one that
 * does: both leave the task in the state the caller asked for. Removing the
 * last unfinished blocker of a `blocked` task unblocks it.
 */
export async function removeDependency(
  id: number,
  dependsOnId: number,
  actor: string,
): Promise<Task> {
  return writeTransaction(async (tx) => {
    const task = await loadForWrite(tx, id);
    assertClaimAllowsWrite(task, actor, new Date());

    const { count } = await tx.taskDependency.deleteMany({ where: { taskId: id, dependsOnId } });
    if (count > 0) {
      await writeTask(tx, task, {});
      await recordEvent(tx, {
        taskId: id,
        type: "dependency.removed",
        actor,
        payload: { dependsOnId },
      });
      await unblockDependents(tx, [id]);
    }

    return loadTask(tx, id);
  });
}
