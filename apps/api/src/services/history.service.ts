import {
  formatReference,
  HISTORY_LONGEST_WAITS,
  HISTORY_MAX_BUCKETS,
  HISTORY_MAX_CYCLE_TIMES,
  HUMAN_WAIT_STATUSES,
  TASK_STATUSES,
  type AgentHistory,
  type CycleTime,
  type HistoryBucketRow,
  type HistoryBucket,
  type HistoryQuery,
  type HistoryResponse,
  type HumanWait,
  type TaskStatus,
} from "@helpdesk/contracts";

import { validationError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";

/**
 * `GET /stats/history` — the Logbook's charts, computed from `TaskEvent`.
 * `docs/features/History_Stats.md`.
 *
 * **The response's `from`/`to` are the *aligned* bucket boundaries, not the raw
 * query params.** Buckets tile a whole number of hour/day/week boundaries, so a
 * `from` of 10:15 with `bucket=hour` is floored to 10:00 and the response says
 * so — every total and chart in the response covers exactly `[from, to)` as
 * echoed back, and nothing is silently dropped at the edges.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

const BUCKET_MS: Record<HistoryBucket, number> = { hour: HOUR_MS, day: DAY_MS, week: WEEK_MS };

/** Floors `date` to the start of its UTC hour, day, or (Monday-starting) week. */
function floorToBoundary(date: Date, bucket: HistoryBucket): Date {
  const floored = new Date(date);
  floored.setUTCMinutes(0, 0, 0);
  if (bucket === "hour") return floored;

  floored.setUTCHours(0);
  if (bucket === "day") return floored;

  // ISO weekday: Monday = 0 … Sunday = 6.
  const isoWeekday = (floored.getUTCDay() + 6) % 7;
  floored.setUTCDate(floored.getUTCDate() - isoWeekday);
  return floored;
}

/** The first boundary at or after `date` — `date` itself when already aligned. */
function ceilToBoundary(date: Date, bucket: HistoryBucket): Date {
  const floored = floorToBoundary(date, bucket);
  return floored.getTime() === date.getTime() ? floored : new Date(floored.getTime() + BUCKET_MS[bucket]);
}

const HUMAN_WAIT_SET = new Set<string>(HUMAN_WAIT_STATUSES);
const isHumanWaitStatus = (status: string): status is (typeof HUMAN_WAIT_STATUSES)[number] =>
  HUMAN_WAIT_SET.has(status);

function minutesStats(values: number[]): {
  count: number;
  medianMinutes: number | null;
  p90Minutes: number | null;
} {
  if (values.length === 0) return { count: 0, medianMinutes: null, p90Minutes: null };
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  return { count: sorted.length, medianMinutes: pick(0.5), p90Minutes: pick(0.9) };
}

const minutesBetween = (start: Date, end: Date): number => (end.getTime() - start.getTime()) / 60_000;

/* ------------------------------------------------------------------ *
 * Event loading
 * ------------------------------------------------------------------ */

const HISTORY_EVENT_TYPES = [
  "task.created",
  "task.deleted",
  "task.status_changed",
  "task.claimed",
  "task.released",
  "decision.requested",
  "decision.answered",
] as const;

interface HistoryEvent {
  id: number;
  taskId: number;
  type: string;
  actor: string;
  createdAt: Date;
  payload: { from?: unknown; to?: unknown; status?: unknown };
}

async function loadEvents(
  project: string[] | undefined,
  until: Date,
): Promise<HistoryEvent[]> {
  const rows = await prisma.taskEvent.findMany({
    where: {
      type: { in: [...HISTORY_EVENT_TYPES] },
      ...(project === undefined ? {} : { project: { in: project } }),
      createdAt: { lte: until },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, taskId: true, type: true, actor: true, createdAt: true, payload: true },
  });

  return rows.map((row) => ({
    id: row.id,
    taskId: row.taskId,
    type: row.type,
    actor: row.actor,
    createdAt: row.createdAt,
    payload: JSON.parse(row.payload) as { from?: unknown; to?: unknown; status?: unknown },
  }));
}

/** Task titles for a set of ids, `null` for one that no longer exists (deleted). */
async function titlesFor(ids: Iterable<number>): Promise<Map<number, string>> {
  const list = [...new Set(ids)];
  if (list.length === 0) return new Map();
  const rows = await prisma.task.findMany({ where: { id: { in: list } }, select: { id: true, title: true } });
  return new Map(rows.map((row) => [row.id, row.title]));
}

/* ------------------------------------------------------------------ *
 * The endpoint
 * ------------------------------------------------------------------ */

export async function getTaskHistory(query: HistoryQuery): Promise<HistoryResponse> {
  const rawTo = query.to === undefined ? new Date() : new Date(query.to);
  const rawFrom = query.from === undefined ? new Date(rawTo.getTime() - 7 * DAY_MS) : new Date(query.from);
  const bucket = query.bucket;

  const alignedStart = floorToBoundary(rawFrom, bucket);
  const alignedEnd = ceilToBoundary(rawTo, bucket);
  const bucketMs = BUCKET_MS[bucket];
  const numBuckets = Math.max(1, Math.round((alignedEnd.getTime() - alignedStart.getTime()) / bucketMs));

  if (numBuckets > HISTORY_MAX_BUCKETS) {
    throw validationError({
      bucket: [
        `This range produces ${numBuckets} ${bucket} buckets; at most ${HISTORY_MAX_BUCKETS} are allowed. Narrow the range or choose a larger bucket.`,
      ],
    });
  }

  const boundaries: Date[] = [];
  for (let i = 0; i <= numBuckets; i += 1) boundaries.push(new Date(alignedStart.getTime() + i * bucketMs));

  const events = await loadEvents(query.project, boundaries[numBuckets]!);
  const generatedAt = new Date();

  /* ---- warm up: apply every event before the window starts ---- */
  const statusOf = new Map<number, TaskStatus>();
  let cursor = 0;
  while (cursor < events.length && events[cursor]!.createdAt < alignedStart) {
    applyStatusEvent(events[cursor]!, statusOf);
    cursor += 1;
  }

  /* ---- per-bucket sweep ---- */
  const buckets: HistoryBucketRow[] = [];
  const humanWaitStints: { taskId: number; status: TaskStatus; startedAt: Date; endedAt: Date | null }[] = [];
  const openHumanWait = new Map<number, { status: TaskStatus; startedAt: Date }>();
  const cycleStart = new Map<number, Date>();
  const cycleTimes: CycleTime[] = [];
  const submissionActor = new Map<number, string>();
  const agents = new Map<string, AgentHistory>();

  const touchAgent = (actor: string): AgentHistory => {
    let row = agents.get(actor);
    if (row === undefined) {
      row = { actor, submitted: 0, approved: 0, sentBack: 0, decisionsRequested: 0, claims: 0, releases: 0 };
      agents.set(actor, row);
    }
    return row;
  };

  let totalCreated = 0;
  let totalCompleted = 0;
  let totalDeferred = 0;
  let totalSentBack = 0;
  let totalDecisionsRequested = 0;
  let totalDecisionsAnswered = 0;
  const humanWaitEndedInRange: number[] = [];

  for (let bucketIndex = 0; bucketIndex < numBuckets; bucketIndex += 1) {
    const bucketEnd = boundaries[bucketIndex + 1]!;
    let created = 0;
    let completed = 0;
    let deferred = 0;
    let sentBack = 0;
    const humanWaitEndedThisBucket: number[] = [];

    while (cursor < events.length && events[cursor]!.createdAt < bucketEnd) {
      const event = events[cursor]!;
      cursor += 1;
      applyStatusEvent(event, statusOf);

      if (event.type === "task.created") {
        created += 1;
        totalCreated += 1;
      } else if (event.type === "task.status_changed") {
        const from = typeof event.payload.from === "string" ? event.payload.from : undefined;
        const to = typeof event.payload.to === "string" ? event.payload.to : undefined;
        if (to === "done") {
          completed += 1;
          totalCompleted += 1;
        }
        if (to === "deferred") {
          deferred += 1;
          totalDeferred += 1;
        }
        if (from === "needs_qa" && to !== undefined && to !== "done" && to !== "deferred") {
          sentBack += 1;
          totalSentBack += 1;
        }

        // Cycle time: in_progress → needs_qa | done.
        if (to === "in_progress") cycleStart.set(event.taskId, event.createdAt);
        else if ((to === "needs_qa" || to === "done") && cycleStart.has(event.taskId)) {
          const start = cycleStart.get(event.taskId)!;
          cycleStart.delete(event.taskId);
          cycleTimes.push({
            taskId: event.taskId,
            reference: formatReference(event.taskId),
            title: null, // filled in below
            actor: event.actor,
            minutes: minutesBetween(start, event.createdAt),
            finishedAt: event.createdAt.toISOString(),
          });
        }

        // Human-wait stints.
        const wasWaiting = openHumanWait.get(event.taskId);
        if (wasWaiting !== undefined) {
          openHumanWait.delete(event.taskId);
          humanWaitStints.push({
            taskId: event.taskId,
            status: wasWaiting.status,
            startedAt: wasWaiting.startedAt,
            endedAt: event.createdAt,
          });
          humanWaitEndedThisBucket.push(humanWaitStints.length - 1);
          humanWaitEndedInRange.push(humanWaitStints.length - 1);
        }
        if (to !== undefined && isHumanWaitStatus(to)) {
          openHumanWait.set(event.taskId, { status: to, startedAt: event.createdAt });
        }

        // Agents: submissions into needs_qa, and their outcome.
        if (to === "needs_qa") {
          submissionActor.set(event.taskId, event.actor);
          touchAgent(event.actor).submitted += 1;
        } else if (from === "needs_qa") {
          const submitter = submissionActor.get(event.taskId);
          if (submitter !== undefined) {
            if (to === "done") touchAgent(submitter).approved += 1;
            else if (to !== "deferred") touchAgent(submitter).sentBack += 1;
            submissionActor.delete(event.taskId);
          }
        }
      } else if (event.type === "task.claimed") {
        touchAgent(event.actor).claims += 1;
      } else if (event.type === "task.released") {
        touchAgent(event.actor).releases += 1;
      } else if (event.type === "decision.requested") {
        totalDecisionsRequested += 1;
        touchAgent(event.actor).decisionsRequested += 1;
      } else if (event.type === "decision.answered") {
        totalDecisionsAnswered += 1;
      }
      // task.deleted is handled by applyStatusEvent (removes the task).
    }

    const statusCounts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<
      TaskStatus,
      number
    >;
    for (const status of statusOf.values()) statusCounts[status] += 1;

    const bucketMinutes = humanWaitEndedThisBucket.map(
      (index) => minutesBetween(humanWaitStints[index]!.startedAt, humanWaitStints[index]!.endedAt!),
    );

    buckets.push({
      start: boundaries[bucketIndex]!.toISOString(),
      end: bucketEnd.toISOString(),
      created,
      completed,
      deferred,
      sentBack,
      statusCounts,
      humanWait: minutesStats(bucketMinutes),
    });
  }

  // Stints still open at the end of the sweep are still waiting, as of now.
  for (const [taskId, waiting] of openHumanWait) {
    humanWaitStints.push({ taskId, status: waiting.status, startedAt: waiting.startedAt, endedAt: null });
  }

  const titleFor = await titlesFor([
    ...cycleTimes.map((c) => c.taskId),
    ...humanWaitStints.map((s) => s.taskId),
  ]);

  for (const cycle of cycleTimes) cycle.title = titleFor.get(cycle.taskId) ?? null;

  const longestWaits: HumanWait[] = humanWaitStints
    .map(
      (stint): HumanWait => ({
        taskId: stint.taskId,
        reference: formatReference(stint.taskId),
        title: titleFor.get(stint.taskId) ?? null,
        status: stint.status,
        minutes: minutesBetween(stint.startedAt, stint.endedAt ?? generatedAt),
        startedAt: stint.startedAt.toISOString(),
        endedAt: stint.endedAt === null ? null : stint.endedAt.toISOString(),
      }),
    )
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, HISTORY_LONGEST_WAITS);

  const humanWaitTotalMinutes = humanWaitEndedInRange.map(
    (index) => minutesBetween(humanWaitStints[index]!.startedAt, humanWaitStints[index]!.endedAt!),
  );

  const agentList = [...agents.values()]
    .filter((agent) => agent.actor.startsWith("agent:"))
    .sort((a, b) => b.submitted - a.submitted);

  return {
    from: alignedStart.toISOString(),
    to: alignedEnd.toISOString(),
    bucket,
    buckets,
    totals: {
      created: totalCreated,
      completed: totalCompleted,
      deferred: totalDeferred,
      sentBack: totalSentBack,
      decisionsRequested: totalDecisionsRequested,
      decisionsAnswered: totalDecisionsAnswered,
      humanWait: minutesStats(humanWaitTotalMinutes),
      cycleTime: minutesStats(cycleTimes.map((c) => c.minutes)),
    },
    cycleTimes: cycleTimes
      .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt))
      .slice(0, HISTORY_MAX_CYCLE_TIMES),
    longestWaits,
    agents: agentList,
  };
}

/** Keeps `statusOf` — the running cumulative status map — in sync with one event. */
function applyStatusEvent(event: HistoryEvent, statusOf: Map<number, TaskStatus>): void {
  if (event.type === "task.deleted") {
    statusOf.delete(event.taskId);
    return;
  }
  if (event.type === "task.created") {
    const status = typeof event.payload.status === "string" ? event.payload.status : undefined;
    if (status !== undefined && (TASK_STATUSES as readonly string[]).includes(status)) {
      statusOf.set(event.taskId, status as TaskStatus);
    }
    return;
  }
  if (event.type === "task.status_changed") {
    const to = typeof event.payload.to === "string" ? event.payload.to : undefined;
    if (to !== undefined && (TASK_STATUSES as readonly string[]).includes(to)) {
      statusOf.set(event.taskId, to as TaskStatus);
    }
  }
}
