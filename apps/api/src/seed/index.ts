import { pathToFileURL } from "node:url";

import {
  actorKindOf,
  actorNameOf,
  type CommentKind,
  type DecisionStatus,
  type TaskEventType,
  type TaskLink,
  type TaskPriority,
  type TaskStatus,
} from "@helpdesk/contracts";

import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { applyTaskRanks } from "../services/task-status.js";
import {
  DEFAULT_REVIEWER,
  DEFAULT_WORKER,
  GITHUB_ORG_URL,
  PR_NUMBER_BASE,
  PRNG_SEED,
  PROGRESS_COUNT_WEIGHTS,
  PROGRESS_NOTES,
  SEED_TASK_COUNT,
  SEED_WINDOW_DAYS,
  TASK_TEMPLATES,
  type SeedDecisionTemplate,
  type SeedTaskTemplate,
  type Weighted,
} from "./seed-data.js";

/**
 * `db:seed` — 62 software-development tasks across three projects, each with
 * the comment thread, decisions, dependencies, and event trail it would have
 * accumulated had it really been worked through the API.
 *
 * **It lives under `src/`, not under `prisma/`, and that is a build constraint
 * rather than a preference.** `tsconfig.build.json` has `rootDir: "src"`, and
 * `docs/operations/DOCKER.md` requires the seed to be *compiled* into the
 * runtime image — `tsx` is a devDependency and is not installed there. A file
 * outside `rootDir` cannot be added to the build at all. `prisma/` keeps the
 * schema and the migrations; the `prisma.seed` hook in `package.json` names this
 * file, which is all Prisma needs.
 *
 * Spec: `docs/features/Seed_Data.md`. The rules that shape this file:
 *
 * 1. **Reproducible.** One fixed PRNG seed drives every draw, and every time is
 *    an offset from the `now` passed in. Two developers running `db:seed` get
 *    the same tasks with the same numbers, which is what makes a screenshot in
 *    a bug report worth anything.
 * 2. **Idempotent.** The script deletes everything first, `sqlite_sequence`
 *    included, so re-seeding produces the same ids rather than appending.
 * 3. **Guarded by `ALLOW_SEED`, not `NODE_ENV`.** The Docker image legitimately
 *    runs a production build *and* wants demo data.
 * 4. **Written through Prisma, but as the services would have written it.** The
 *    seed does not call the workflow service (which stamps `now()` on
 *    everything); it replays each task's history itself. So every invariant the
 *    services maintain — ranks, claims only on `in_progress`, one open decision
 *    per `needs_user_decision` task, `statusNote` from the last transition, an
 *    event for every write — is maintained here by construction, and asserted
 *    in `seed.test.ts`.
 * 5. **Ranks are written through `applyTaskRanks()`** — see `SeedTaskWrite`.
 */

/* ------------------------------------------------------------------ *
 * Write shapes
 * ------------------------------------------------------------------ */

/**
 * **`statusRank` and `priorityRank` are deliberately absent from this type.**
 * The only way a rank reaches Prisma from here is `applyTaskRanks()` adding it
 * — enforced by the compiler, not by this comment. A rank that disagrees with
 * its status string makes the row invisible to every status filter while it
 * still reads back perfectly over `GET /tasks/:id`.
 */
export interface SeedTaskWrite {
  title: string;
  description: string;
  acceptanceCriteria: string | null;
  status: TaskStatus;
  statusNote: string | null;
  priority: TaskPriority;
  project: string | null;
  assignee: string | null;
  createdBy: string;
  /** JSON `TaskLink[]`. */
  links: string;
  claimedBy: string | null;
  claimExpiresAt: Date | null;
  version: number;
  idempotencyKey: string | null;
  createdAt: Date;
  /**
   * Written explicitly even though the column is `@updatedAt`: Prisma stamps
   * `now()` on create unless a value is supplied, which would give every task
   * the same `updatedAt` and make `?sort=updatedAt:desc` look broken. It is the
   * time of the last write to the row — a transition, or a heartbeat.
   */
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface SeedCommentWrite {
  author: string;
  kind: CommentKind;
  body: string;
  createdAt: Date;
}

export interface SeedDecisionWrite {
  status: DecisionStatus;
  question: string;
  /** JSON `DecisionOption[]`. */
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

/**
 * Ids an event payload needs but the generator cannot know: they are assigned
 * by autoincrement at insert time and patched into the payload then.
 */
export type SeedEventRef =
  | { comment: number } // index into this task's `comments`
  | { decision: number } // index into this task's `decisions`
  | { dependsOn: string }; // template key

export interface SeedEventWrite {
  type: TaskEventType;
  actor: string;
  payload: Record<string, unknown>;
  ref?: SeedEventRef;
  createdAt: Date;
}

export interface SeedDependencyWrite {
  dependsOn: string;
  createdAt: Date;
}

export interface SeedTask {
  key: string;
  parentKey: string | null;
  dependencies: SeedDependencyWrite[];
  task: SeedTaskWrite;
  comments: SeedCommentWrite[];
  decisions: SeedDecisionWrite[];
  events: SeedEventWrite[];
}

/* ------------------------------------------------------------------ *
 * Deterministic randomness
 * ------------------------------------------------------------------ */

/**
 * mulberry32 — a 32-bit PRNG that is four lines long, has no dependencies, and
 * is identical on every platform and Node version. `Math.random()` is none of
 * those things, and reproducibility is the point.
 */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const pick = <T>(random: () => number, values: readonly T[]): T => {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) throw new Error("Cannot pick from an empty pool");
  return value;
};

const weightedPick = <T>(random: () => number, options: readonly Weighted<T>[]): T => {
  const total = options.reduce((sum, option) => sum + option.weight, 0);
  let threshold = random() * total;

  for (const option of options) {
    threshold -= option.weight;
    if (threshold < 0) return option.value;
  }

  const last = options.at(-1);
  if (last === undefined) throw new Error("Cannot pick from an empty weight table");
  return last.value;
};

/** Uniform in `[min, max)`. */
const between = (random: () => number, min: number, max: number): number =>
  min + random() * (max - min);

/* ------------------------------------------------------------------ *
 * Lifecycle plan
 * ------------------------------------------------------------------ */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * One thing that happened to a task, before it has a time. A step with
 * `write: true` is one write to the task row — one `version` bump — even when
 * it produces several events (a claim is `task.status_changed` +
 * `task.claimed`; a `blocked` transition carrying `blockedBy` adds its
 * `dependency.added` events in the same write), exactly as the workflow service
 * does it.
 */
interface Step {
  actor: string;
  write: boolean;
  transition?: { from: TaskStatus; to: TaskStatus; note: string | null };
  claim?: boolean;
  dependencies?: readonly string[];
  decisionRequest?: number;
  decisionAnswer?: number;
  comment?: { kind: CommentKind; body: string };
  /** Lands in the same millisecond as the step before it. See `planSteps`. */
  sameInstantAsPrevious?: boolean;
}

/**
 * The status a task was filed in. Only `backlog`, `needs_refinement`, and
 * `todo` are creatable, and none of the others carry their required note on
 * create, so:
 *
 * - an agent files work it has specified in `todo` directly (acceptance
 *   criteria included);
 * - everything else starts in `backlog` and gets where it is by transitions —
 *   including `needs_refinement`, whose "what is unclear" note only a
 *   transition can carry.
 */
function creationStatusOf(template: SeedTaskTemplate): TaskStatus {
  const passesThroughTodo = !["backlog", "needs_refinement", "deferred"].includes(template.status);
  return actorKindOf(template.createdBy) === "agent" && passesThroughTodo ? "todo" : "backlog";
}

const decisionAnswerNote = (choice: string | undefined, note: string | undefined): string =>
  // The same wording `answerDecision()` writes into `statusNote`.
  `Decision: ${[choice, note].filter(Boolean).join(" — ")}`;

/**
 * The ordered history that ends in `template.status`, mirroring the workflow
 * service's rules: claiming is a transition to `in_progress`; `done` is reached
 * from `needs_qa` by a human (agents stop at `needs_qa`); answering a decision
 * sends the task back to `todo`; a QA bounce goes back to `todo` for the agent
 * to reclaim.
 */
function planSteps(
  template: SeedTaskTemplate,
  templateIndex: number,
  random: () => number,
): Step[] {
  const worker = template.worker ?? DEFAULT_WORKER;
  const reviewer = template.reviewer ?? DEFAULT_REVIEWER;
  const steps: Step[] = [];
  let current = creationStatusOf(template);

  const move = (to: TaskStatus, actor: string, note: string | null, extra: Partial<Step> = {}) => {
    steps.push({ actor, write: true, transition: { from: current, to, note }, ...extra });
    current = to;
  };

  const comment = (actor: string, kind: CommentKind, body: string) =>
    steps.push({ actor, write: false, comment: { kind, body } });

  /**
   * A stretch of work: claim, then one to three working notes.
   *
   * **Every third task's two-note stretch lands both notes in the same
   * millisecond, on purpose.** `createdAt` alone is not a total order over
   * comments, so the read path orders by `[createdAt asc, id asc]`; without a
   * collision in the data, dropping that `id` tiebreaker would break nothing
   * visible and the regression would ship. See `docs/features/Comments.md`.
   */
  const work = () => {
    move("in_progress", worker, null, { claim: true });
    const count = weightedPick(random, PROGRESS_COUNT_WEIGHTS);
    for (let n = 0; n < count; n += 1) {
      steps.push({
        actor: worker,
        write: false,
        comment: { kind: "progress", body: pick(random, PROGRESS_NOTES) },
        sameInstantAsPrevious: n === 1 && templateIndex % 3 === 0,
      });
    }
  };

  const note = (): string => {
    if (template.statusNote === undefined) {
      throw new Error(`Seed template "${template.key}" (${template.status}) needs a statusNote`);
    }
    return template.statusNote;
  };

  for (const entry of template.comments ?? []) {
    if (entry.at === "start") comment(entry.author, entry.kind, entry.body);
  }

  // Blockers of a `blocked` task arrive with the transition (`blockedBy`);
  // anyone else's are added on their own, soon after filing.
  if (template.dependsOn !== undefined && template.status !== "blocked") {
    steps.push({ actor: template.createdBy, write: true, dependencies: template.dependsOn });
  }

  let decisionIndex = 0;

  switch (template.status) {
    case "backlog":
      break;
    case "needs_refinement":
      move("needs_refinement", template.worker ?? DEFAULT_WORKER, note());
      break;
    case "deferred":
      move("deferred", reviewer, note());
      break;
    default: {
      if (current === "backlog") move("todo", template.createdBy, null);

      const answered = template.answeredDecision;
      if (answered !== undefined) {
        work();
        move("needs_user_decision", worker, answered.question, {
          decisionRequest: decisionIndex,
        });
        move("todo", answered.answeredBy, decisionAnswerNote(answered.choice, answered.note), {
          decisionAnswer: decisionIndex,
        });
        decisionIndex += 1;
      }

      if (template.status === "todo") break;
      work();

      switch (template.status) {
        case "in_progress":
          break;
        case "blocked":
          move("blocked", worker, note(), { dependencies: template.dependsOn ?? [] });
          break;
        case "needs_user_decision": {
          const open = requireOpenDecision(template);
          move("needs_user_decision", worker, open.question, { decisionRequest: decisionIndex });
          break;
        }
        case "needs_user_action":
        case "needs_qa":
          move(template.status, worker, note());
          break;
        case "done": {
          if (template.qaSummary === undefined) {
            throw new Error(`Seed template "${template.key}" (done) needs a qaSummary`);
          }
          move("needs_qa", worker, template.qaSummary);
          if (template.qaFeedback !== undefined) {
            comment(reviewer, "qa_feedback", template.qaFeedback);
            move("todo", reviewer, "Sent back from QA — see the qa_feedback comment.");
            work();
            move("needs_qa", worker, template.qaResubmit ?? template.qaSummary);
          }
          move("done", reviewer, template.statusNote ?? null);
          break;
        }
        default:
          throw new Error(`Seed template "${template.key}": unhandled status ${template.status}`);
      }
    }
  }

  for (const entry of template.comments ?? []) {
    if (entry.at !== "start") comment(entry.author, entry.kind, entry.body);
  }

  if (current !== template.status) {
    throw new Error(
      `Seed template "${template.key}" planned to ${current}, not ${template.status}`,
    );
  }
  return steps;
}

function requireOpenDecision(template: SeedTaskTemplate): SeedDecisionTemplate {
  if (template.decision === undefined) {
    throw new Error(`Seed template "${template.key}" (needs_user_decision) needs a decision`);
  }
  return template.decision;
}

/* ------------------------------------------------------------------ *
 * Timeline
 * ------------------------------------------------------------------ */

export interface BuildSeedOptions {
  /** Defaults to the shipped constant; tests vary it to check structure, not luck. */
  seed?: number;
  /** Lease length for claims. `seedDatabase` passes `CLAIM_LEASE_MINUTES`. */
  leaseMinutes?: number;
}

/**
 * The whole dataset, as plain objects. Pure: same `now` and options in, same
 * rows out, and nothing here touches Prisma — which is what lets every
 * invariant be asserted without a database.
 *
 * Rows come back **sorted by `createdAt` ascending**, so autoincrement hands out
 * task numbers in chronological order. Parents and blockers are always older
 * than the tasks that point at them (checked here), which also makes the
 * dependency graph acyclic by construction.
 */
export function buildSeedTasks(now: Date, options: BuildSeedOptions = {}): SeedTask[] {
  const random = createRandom(options.seed ?? PRNG_SEED);
  const leaseMs = (options.leaseMinutes ?? 30) * MINUTE;
  const nowMs = now.getTime();

  const rows = TASK_TEMPLATES.map((template, index) =>
    buildTask(template, index, random, nowMs, leaseMs),
  ).sort((a, b) => a.task.createdAt.getTime() - b.task.createdAt.getTime());

  assertReferences(rows);
  return rows;
}

function buildTask(
  template: SeedTaskTemplate,
  index: number,
  random: () => number,
  nowMs: number,
  leaseMs: number,
): SeedTask {
  const worker = template.worker ?? DEFAULT_WORKER;
  const creationStatus = creationStatusOf(template);
  const steps = planSteps(template, index, random);

  // Up to ±0.35 days of jitter keeps templates a day apart in order, and never
  // lands a task in the future or "0 minutes ago".
  const createdMs = Math.min(
    Math.round(nowMs - template.daysAgo * DAY + between(random, -0.35, 0.35) * DAY),
    nowMs - 2 * HOUR,
  );

  /* When did the task reach its current status (`finalMs`), and how long did
   * the thread keep going after that (`tailEndMs`)? A live claim was taken in
   * the last few hours and heartbeated minutes ago; an expired one belongs to
   * an agent that went quiet days ago; everything else settled somewhere in
   * its lifetime. */
  const lastWrite = steps.reduce((last, step, n) => (step.write ? n : last), -1);
  const live = template.status === "in_progress" && template.claim !== "expired";
  const expired = template.status === "in_progress" && template.claim === "expired";

  let finalMs: number;
  let tailEndMs: number;
  let heartbeatMs: number | null = null;

  if (lastWrite === -1) {
    finalMs = createdMs;
    tailEndMs = createdMs + (nowMs - createdMs) * between(random, 0.3, 0.8);
  } else if (live) {
    finalMs = nowMs - between(random, 40, 240) * MINUTE;
    heartbeatMs = nowMs - between(random, 0.5, Math.min(8, leaseMs / MINUTE / 2)) * MINUTE;
    tailEndMs = heartbeatMs - 30_000;
  } else if (expired) {
    finalMs = nowMs - between(random, 1.5, 3.5) * DAY;
    heartbeatMs = finalMs + between(random, 1, 3) * HOUR;
    tailEndMs = heartbeatMs - 60_000;
  } else {
    finalMs = createdMs + (nowMs - createdMs) * between(random, 0.45, 0.85);
    tailEndMs = finalMs + (nowMs - finalMs) * between(random, 0.25, 0.85);
  }

  if (lastWrite !== -1 && finalMs <= createdMs) {
    throw new Error(`Seed template "${template.key}" is too young for its history`);
  }

  // History spread across (created, final); the last write at `final`; the
  // tail spread across (final, tailEnd]. One slot per step keeps them ordered.
  const times: number[] = [];
  const slot = (from: number, to: number, count: number, n: number) =>
    Math.round(from + ((to - from) * (n + 0.15 + 0.7 * random())) / count);

  const historyCount = Math.max(lastWrite, 0);
  const tailCount = steps.length - (lastWrite + 1);
  steps.forEach((step, n) => {
    let at: number;
    if (n < lastWrite) at = slot(createdMs, finalMs, historyCount, n);
    else if (n === lastWrite) at = Math.round(finalMs);
    else at = slot(finalMs, tailEndMs, tailCount, n - lastWrite - 1);

    const previous = times.at(-1);
    times.push(step.sameInstantAsPrevious && previous !== undefined ? previous : at);
  });

  /* Replay the steps into rows and events. */
  const comments: SeedCommentWrite[] = [];
  const decisions: SeedDecisionWrite[] = [];
  const dependencies: SeedDependencyWrite[] = [];
  const events: SeedEventWrite[] = [
    {
      type: "task.created",
      actor: template.createdBy,
      payload: { status: creationStatus, title: template.title },
      createdAt: new Date(createdMs),
    },
  ];

  let status = creationStatus;
  let statusNote: string | null = null;
  let version = 1;
  let lastWriteMs = createdMs;
  let startedMs: number | null = null;
  let completedMs: number | null = null;
  let claimedBy: string | null = null;
  let claimExpiresMs: number | null = null;

  steps.forEach((step, n) => {
    const atMs = times[n] ?? createdMs;
    const at = new Date(atMs);
    const event = (type: TaskEventType, payload: Record<string, unknown>, ref?: SeedEventRef) =>
      events.push({ type, actor: step.actor, payload, createdAt: at, ...(ref ? { ref } : {}) });

    for (const key of step.dependencies ?? []) {
      dependencies.push({ dependsOn: key, createdAt: at });
      event("dependency.added", {}, { dependsOn: key });
    }

    if (step.decisionAnswer !== undefined) {
      const decision = decisions[step.decisionAnswer];
      const answered = template.answeredDecision;
      if (decision === undefined || answered === undefined) {
        throw new Error(`Seed template "${template.key}": answer without a question`);
      }
      decision.status = "answered";
      decision.choice = answered.choice ?? null;
      decision.note = answered.note ?? null;
      decision.answeredBy = step.actor;
      decision.answeredAt = at;
      event(
        "decision.answered",
        { choice: decision.choice, note: decision.note },
        { decision: step.decisionAnswer },
      );
    }

    if (step.transition !== undefined) {
      const { from, to, note } = step.transition;
      status = to;
      statusNote = note;
      event("task.status_changed", { from, to, note });

      if (to === "in_progress" && startedMs === null) startedMs = atMs;
      completedMs = to === "done" ? atMs : null;
      // Taken on entering in_progress, dropped on leaving it.
      claimedBy = step.claim ? step.actor : null;
      claimExpiresMs = step.claim ? atMs + leaseMs : null;
      if (step.claim) event("task.claimed", { expiresAt: new Date(atMs + leaseMs).toISOString() });
    }

    if (step.decisionRequest !== undefined) {
      const source =
        step.decisionRequest === 0 && template.answeredDecision !== undefined
          ? template.answeredDecision
          : requireOpenDecision(template);
      decisions.push({
        status: "open",
        question: source.question,
        options: JSON.stringify(source.options),
        recommendedOption: source.recommendedOption ?? null,
        context: source.context ?? null,
        requestedBy: step.actor,
        choice: null,
        note: null,
        answeredBy: null,
        createdAt: at,
        answeredAt: null,
      });
      event(
        "decision.requested",
        { question: source.question },
        { decision: decisions.length - 1 },
      );
    }

    if (step.comment !== undefined) {
      comments.push({ author: step.actor, ...step.comment, createdAt: at });
      event("comment.created", { kind: step.comment.kind }, { comment: comments.length - 1 });
    }

    if (step.write) {
      version += 1;
      lastWriteMs = atMs;
    }
  });

  // A heartbeat extends the lease and touches `updatedAt` without a version bump.
  if (heartbeatMs !== null) {
    claimExpiresMs = heartbeatMs + leaseMs;
    lastWriteMs = Math.max(lastWriteMs, heartbeatMs);
  }

  const everStarted = startedMs !== null;
  const assignee =
    template.assignee !== undefined ? template.assignee : everStarted ? worker : null;

  const task: SeedTaskWrite = {
    title: template.title,
    description: template.description,
    acceptanceCriteria: template.acceptanceCriteria ?? null,
    status,
    statusNote,
    priority: template.priority,
    project: template.project,
    assignee,
    createdBy: template.createdBy,
    links: JSON.stringify(linksFor(template, index, worker)),
    claimedBy,
    claimExpiresAt: claimExpiresMs === null ? null : new Date(claimExpiresMs),
    version,
    idempotencyKey:
      actorKindOf(template.createdBy) === "agent"
        ? `${actorNameOf(template.createdBy)}:${template.project ?? "inbox"}:${template.key}`
        : null,
    createdAt: new Date(createdMs),
    updatedAt: new Date(lastWriteMs),
    startedAt: startedMs === null ? null : new Date(startedMs),
    completedAt: completedMs === null ? null : new Date(completedMs),
  };

  return {
    key: template.key,
    parentKey: template.parent ?? null,
    dependencies,
    task,
    comments,
    decisions,
    events,
  };
}

/**
 * Explicit links win. Otherwise work handed to QA carries the PR it was
 * reviewed in and the branch it was built on — what the `needs_qa` transition's
 * `links` would have appended.
 */
function linksFor(template: SeedTaskTemplate, index: number, worker: string): TaskLink[] {
  if (template.links !== undefined) return template.links;
  if (template.project === null) return [];
  if (template.status !== "needs_qa" && template.status !== "done") return [];

  const repo = `${GITHUB_ORG_URL}/${template.project}`;
  const pr = PR_NUMBER_BASE[template.project] + index;
  const branch = `${actorNameOf(worker)}/${template.key}`;
  return [
    { label: `PR #${pr}`, url: `${repo}/pull/${pr}` },
    { label: `Branch ${branch}`, url: `${repo}/tree/${branch}` },
  ];
}

/**
 * Every `parent` and `dependsOn` names a real template **older** than the task
 * pointing at it. Parents must be inserted first (the child's insert carries
 * `parentId`), and edges that only ever point backwards in time cannot form a
 * cycle — the same guarantee `DEPENDENCY_CYCLE` gives the API.
 */
function assertReferences(rows: SeedTask[]): void {
  const position = new Map(rows.map((row, n) => [row.key, n]));
  if (position.size !== rows.length) throw new Error("Seed template keys must be unique");

  rows.forEach((row, n) => {
    const targets = [
      ...(row.parentKey === null ? [] : [row.parentKey]),
      ...row.dependencies.map((dep) => dep.dependsOn),
    ];
    for (const key of targets) {
      const at = position.get(key);
      if (at === undefined) throw new Error(`Seed task "${row.key}" references unknown "${key}"`);
      if (at >= n) throw new Error(`Seed task "${row.key}" references newer task "${key}"`);
    }
  });
}

/* ------------------------------------------------------------------ *
 * The guard
 * ------------------------------------------------------------------ */

/**
 * Seeding wipes the database, so it is refused where "wipe the database" is
 * least likely to be what was meant.
 *
 * **The switch is `ALLOW_SEED`, and `NODE_ENV` only decides the default.** A
 * production build is exactly what the Docker image runs, and that image ships
 * demo data — keying the refusal on `NODE_ENV=production` alone would make the
 * container unable to seed at all.
 *
 * Pure and exported so this decision is testable without setting environment
 * variables in a worker that has already parsed them.
 */
export const isSeedAllowed = (nodeEnv: string, allowSeed: boolean): boolean =>
  allowSeed || nodeEnv !== "production";

export class SeedNotAllowedError extends Error {
  constructor() {
    super(
      "Refusing to seed: NODE_ENV=production and ALLOW_SEED is not set. " +
        "Seeding deletes every task, comment, decision, dependency and event first. " +
        "Set ALLOW_SEED=true to proceed (see docs/engineering/ENVIRONMENT_VARIABLES.md).",
    );
    this.name = "SeedNotAllowedError";
  }
}

/* ------------------------------------------------------------------ *
 * The write
 * ------------------------------------------------------------------ */

export interface SeedResult {
  tasks: number;
  comments: number;
  decisions: number;
  dependencies: number;
  events: number;
}

/** Autoincrement tables whose counters are reset, so a re-seed reuses ids from 1. */
const SEQUENCED_TABLES = ["Task", "Comment", "Decision", "TaskEvent"];

/**
 * Wipe, then insert — in one transaction, so an interrupted seed cannot leave
 * a half-populated database.
 *
 * `sqlite_sequence` is reset alongside the delete so a re-seed reuses the same
 * ids. Without it `TASK-000042` would mean a different task on every run.
 *
 * Insert order is what makes ids chronological in every table: tasks oldest
 * first; then comments, decisions, and events each sorted by time across
 * *all* tasks (a stable sort, so same-millisecond rows keep their causal
 * order). An events poller reading `after=<id>` therefore sees history in the
 * order it happened.
 */
export async function seedDatabase(options: { now?: Date } = {}): Promise<SeedResult> {
  if (!isSeedAllowed(env.NODE_ENV, env.ALLOW_SEED)) throw new SeedNotAllowedError();

  const rows = buildSeedTasks(options.now ?? new Date(), {
    leaseMinutes: env.CLAIM_LEASE_MINUTES,
  });

  return prisma.$transaction(
    async (tx) => {
      // TaskEvent has no foreign key (it outlives its task), so the cascade
      // from Task would not clear it; the others are cleared explicitly too
      // rather than trusting the cascade to do it.
      for (const table of ["TaskEvent", "Decision", "TaskDependency", "Comment", "Task"]) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}"`);
      }
      await tx.$executeRawUnsafe(
        `DELETE FROM sqlite_sequence WHERE name IN (${SEQUENCED_TABLES.map((t) => `'${t}'`).join(", ")})`,
      );

      /* Tasks, oldest first. Parents are older than their children, so a
       * parent's id is always known by the time a child needs it. */
      const idByKey = new Map<string, number>();
      const idOf = (key: string): number => {
        const id = idByKey.get(key);
        if (id === undefined) throw new Error(`Seed: task "${key}" not inserted yet`);
        return id;
      };

      for (const row of rows) {
        const { id } = await tx.task.create({
          data: {
            // The only route a rank takes into this insert. See `SeedTaskWrite`.
            ...applyTaskRanks(row.task),
            parentId: row.parentKey === null ? null : idOf(row.parentKey),
          },
          select: { id: true },
        });
        idByKey.set(row.key, id);
      }

      const dependencies = rows.flatMap((row) =>
        row.dependencies.map((dep) => ({
          taskId: idOf(row.key),
          dependsOnId: idOf(dep.dependsOn),
          createdAt: dep.createdAt,
        })),
      );
      await tx.taskDependency.createMany({ data: dependencies });

      /* Comments and decisions, chronological across all tasks, one insert at a
       * time so each id can be recorded for the events that reference it. */
      const byTime = <T extends { at: Date }>(items: T[]): T[] =>
        items.sort((a, b) => a.at.getTime() - b.at.getTime());

      const commentIds = rows.map(() => [] as number[]);
      const comments = byTime(
        rows.flatMap((row, r) =>
          row.comments.map((comment, c) => ({ r, c, comment, at: comment.createdAt })),
        ),
      );
      for (const { r, c, comment } of comments) {
        const { id } = await tx.comment.create({
          data: { ...comment, taskId: idOf(rows[r]!.key) },
          select: { id: true },
        });
        commentIds[r]![c] = id;
      }

      const decisionIds = rows.map(() => [] as number[]);
      const decisions = byTime(
        rows.flatMap((row, r) =>
          row.decisions.map((decision, d) => ({ r, d, decision, at: decision.createdAt })),
        ),
      );
      for (const { r, d, decision } of decisions) {
        const { id } = await tx.decision.create({
          data: { ...decision, taskId: idOf(rows[r]!.key) },
          select: { id: true },
        });
        decisionIds[r]![d] = id;
      }

      /* Events, chronological across all tasks. `createMany` inserts in array
       * order, so ids follow time. */
      const resolve = (r: number, ref: SeedEventRef | undefined): Record<string, number> => {
        if (ref === undefined) return {};
        if ("comment" in ref) return { commentId: commentIds[r]![ref.comment]! };
        if ("decision" in ref) return { decisionId: decisionIds[r]![ref.decision]! };
        return { dependsOnId: idOf(ref.dependsOn) };
      };

      const events = byTime(
        rows.flatMap((row, r) => row.events.map((event) => ({ r, event, at: event.createdAt }))),
      ).map(({ r, event }) => ({
        taskId: idOf(rows[r]!.key),
        type: event.type,
        actor: event.actor,
        payload: JSON.stringify({ ...resolve(r, event.ref), ...event.payload }),
        createdAt: event.createdAt,
      }));
      await tx.taskEvent.createMany({ data: events });

      return {
        tasks: rows.length,
        comments: comments.length,
        decisions: decisions.length,
        dependencies: dependencies.length,
        events: events.length,
      };
    },
    // ~200 single-row inserts plus three bulk ones on a cold SQLite file fits
    // easily, but the default 5 s interactive timeout is tight enough on a
    // loaded CI box to be worth not thinking about again.
    { timeout: 30_000 },
  );
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

/**
 * Run only when this file is the process entrypoint, so importing it from a test
 * does not seed anything. `prisma db seed` and `tsx src/seed/index.ts` both come
 * through here.
 */
const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  const startedAt = Date.now();

  try {
    const result = await seedDatabase();
    logger.info("Seed complete", {
      ...result,
      expectedTasks: SEED_TASK_COUNT,
      windowDays: SEED_WINDOW_DAYS,
      durationMs: Date.now() - startedAt,
      database: env.DATABASE_URL,
    });
  } catch (err) {
    logger.error("Seed failed", { err });
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
