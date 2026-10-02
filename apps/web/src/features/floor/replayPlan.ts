import { TASK_STATUSES, type TaskEvent, type TaskStatus } from "@estuary/contracts";
import { TASK_STATUS_LABELS } from "@/lib/formatting";

/**
 * The tide scrubber's replay, planned as **steps between events** rather than
 * a clock sweeping the range: the quiet hours between two status changes are
 * skipped, and each step is one moment the map actually changed. The scrubber
 * writes each step's `at` in turn; `FloorCanvas`'s layout diff then animates
 * the beads that moved, exactly as it does for a live poll.
 *
 * Pure, so the plan is unit-tested without timers (`replayPlan.test.ts`).
 */
export type ReplayStep = {
  /** The snapshot instant — the step's last event, so every event in it is already applied (`GET /floor?at=` is inclusive). */
  atMs: number;
  events: TaskEvent[];
};

/** More status changes than this share steps, so a busy day still replays in ~20 seconds. */
export const REPLAY_MAX_STEPS = 14;

/**
 * Every `task.status_changed` event after `fromMs`, oldest first, split into
 * at most `maxSteps` consecutive chunks of near-equal size. Events at the same
 * instant can't be told apart by a snapshot, so a chunk never splits them.
 */
export const buildReplaySteps = (
  events: readonly TaskEvent[],
  fromMs: number,
  maxSteps: number = REPLAY_MAX_STEPS,
): ReplayStep[] => {
  const moves = events
    .filter((event) => event.type === "task.status_changed")
    .map((event) => ({ event, ms: new Date(event.createdAt).getTime() }))
    .filter(({ ms }) => ms > fromMs)
    .sort((a, b) => a.ms - b.ms || a.event.id - b.event.id);
  if (moves.length === 0) return [];

  const perStep = Math.ceil(moves.length / Math.max(1, maxSteps));
  const steps: ReplayStep[] = [];
  let current: ReplayStep | null = null;
  for (const { event, ms } of moves) {
    const full = current !== null && current.events.length >= perStep && current.atMs !== ms;
    if (current === null || full) {
      current = { atMs: ms, events: [] };
      steps.push(current);
    }
    current.events.push(event);
    current.atMs = ms;
  }
  return steps;
};

const statusLabel = (value: unknown): string | null =>
  typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value)
    ? TASK_STATUS_LABELS[value as TaskStatus]
    : null;

/** "claude-code-ci moved #49 To do → In progress" — the actor without its `agent:`/`human:` prefix. */
export const describeMove = (event: TaskEvent): string => {
  const actor = event.actor.replace(/^(agent|human|system):/, "");
  const payload = event.payload as { from?: unknown; to?: unknown };
  const from = statusLabel(payload.from);
  const to = statusLabel(payload.to);
  return from !== null && to !== null
    ? `${actor} moved #${event.taskId} ${from} → ${to}`
    : `${actor} updated #${event.taskId}`;
};
