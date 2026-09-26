import { TASK_STATUSES, type TaskEvent, type TaskStatus } from "@helpdesk/contracts";

/**
 * Phase 4's "live motion" — turning a batch of `GET /events?after=` rows into
 * a plan of what should animate, **before** any canvas/timing code touches
 * it. Kept pure and separate from `scene.ts`/`FloorCanvas.tsx` on purpose: an
 * event → animation decision is exactly the kind of branchy mapping that's
 * miserable to verify by eyeballing a canvas, and cheap to unit test as data
 * in, data out.
 *
 * Scope note: this module decides *what* should animate. Actually drawing a
 * bead travelling the river (the prototype's `route()`, a fading trail, an
 * arrival splash, a flashing target station) is real canvas work layered on
 * top of `drawFrame` — tracked as a follow-up (see `docs/pages/Tasks_Map.md`'s
 * Known gaps) rather than built here, so this pass ships a correct, tested
 * decision layer plus the poll/snap/refresh plumbing around it, rather than
 * an animation renderer built against a moving deadline.
 */

export type MoveAnimation = { kind: "move"; taskId: number; from: TaskStatus; to: TaskStatus };
export type ClaimAnimation = { kind: "claim"; taskId: number; actor: string };
export type PulseAnimation = { kind: "pulse"; taskId: number };
export type LiveAnimation = MoveAnimation | ClaimAnimation | PulseAnimation;

export type LiveAnimationPlan = {
  /** `true` when the batch is too large (or the viewer asked for less motion) to animate individually — the caller should just redraw at the new positions. */
  snap: boolean;
  animations: LiveAnimation[];
};

/** More events than this in one poll reads as "a lot happened while this tab wasn't watching," not a handful of live moves — animating all of them would be noise, not motion. */
export const LIVE_MOTION_SNAP_THRESHOLD = 20;

const isTaskStatus = (value: unknown): value is TaskStatus =>
  typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);

/**
 * `events` should be the page returned by `GET /events?after=` — already
 * oldest-first, already scoped to what's new since the last poll. Events for
 * types this module doesn't animate (comments, dependency edits, …) are
 * ignored rather than erroring; the poll's real job (refreshing the
 * snapshot) doesn't depend on this function recognising every event type.
 */
export const planLiveAnimations = (
  events: readonly TaskEvent[],
  options: { reducedMotion: boolean },
): LiveAnimationPlan => {
  const animations: LiveAnimation[] = [];

  for (const event of events) {
    if (event.type === "task.status_changed") {
      const payload = event.payload as { from?: unknown; to?: unknown };
      if (isTaskStatus(payload.from) && isTaskStatus(payload.to) && payload.from !== payload.to) {
        animations.push({ kind: "move", taskId: event.taskId, from: payload.from, to: payload.to });
      }
    } else if (event.type === "task.claimed") {
      animations.push({ kind: "claim", taskId: event.taskId, actor: event.actor });
    } else if (event.type === "decision.requested") {
      animations.push({ kind: "pulse", taskId: event.taskId });
    }
  }

  const snap = options.reducedMotion || events.length > LIVE_MOTION_SNAP_THRESHOLD;
  return { snap, animations: snap ? [] : animations };
};

/**
 * "3 agents working · synced 12s ago" — the hero's quiet live-status line.
 * `workingCount` is `countWorkingAgents(snapshot.tasks)` (`layout.ts`) —
 * distinct `agent:*` actors with a live claim, **not**
 * `statusCounts.in_progress`: a task can be `in_progress` with no live claim
 * at all (the seed data's "Stalled" tasks), which isn't an agent working.
 */
export const formatLiveStatusLine = (workingCount: number, syncedSecondsAgo: number): string => {
  const agents = workingCount === 0 ? "No agent working" : `${workingCount} agent${workingCount === 1 ? "" : "s"} working`;
  const synced = syncedSecondsAgo < 1 ? "synced just now" : `synced ${Math.round(syncedSecondsAgo)}s ago`;
  return `${agents} · ${synced}`;
};
