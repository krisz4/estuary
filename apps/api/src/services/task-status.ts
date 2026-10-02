import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskPriority,
  type TaskStatus,
  type TransitionInput,
} from "@estuary/contracts";

/**
 * Status ranks and the pure half of a transition: what the status note becomes
 * and which timestamps move. See `docs/features/Task_Status_Lifecycle.md`.
 *
 * Everything here is pure: no Prisma, no `req`/`res`. The workflow service
 * composes these into a single write, which is what makes "ranks and timestamps
 * move in the same update as the status" true by construction rather than by
 * discipline.
 *
 * There is **no from→to table** any more. The helpdesk lifecycle had one; the
 * task manager gates on what a transition *carries* (a reason, a question, a
 * summary), which the contract's discriminated union already enforces.
 */

/* ------------------------------------------------------------------ *
 * Ranks
 * ------------------------------------------------------------------ */

/**
 * `statusRank` / `priorityRank` exist only so SQLite can order by lifecycle and
 * severity instead of alphabetically. They are the index of the value in the
 * contract enum, built **from** the contract arrays so a value added there can
 * never be a runtime `undefined` written into an `Int` column.
 */
const rankOf = <T extends string>(values: readonly T[]): Record<T, number> =>
  Object.fromEntries(values.map((value, index) => [value, index])) as Record<T, number>;

export const STATUS_RANK: Record<TaskStatus, number> = rankOf(TASK_STATUSES);
export const PRIORITY_RANK: Record<TaskPriority, number> = rankOf(TASK_PRIORITIES);

/** The subset of a Prisma write payload this module cares about. */
export interface RankableTaskWrite {
  status?: TaskStatus;
  priority?: TaskPriority;
}

/**
 * **The only writer of `statusRank` / `priorityRank`.**
 *
 * Every Prisma write that can touch `status` or `priority` passes its `data`
 * through here, so the derived columns cannot drift from the strings they
 * describe. A field absent from `data` stays absent from the result: a PATCH
 * that does not mention `priority` must not rewrite `priorityRank`.
 */
export const applyTaskRanks = <T extends RankableTaskWrite>(
  data: T,
): T & { statusRank?: number; priorityRank?: number } => ({
  ...data,
  ...(data.status === undefined ? {} : { statusRank: STATUS_RANK[data.status] }),
  ...(data.priority === undefined ? {} : { priorityRank: PRIORITY_RANK[data.priority] }),
});

/* ------------------------------------------------------------------ *
 * Transition payloads
 * ------------------------------------------------------------------ */

/**
 * The text that becomes `statusNote` — the "why" of the new status. Every
 * transition replaces the note, so a task that leaves `blocked` does not keep
 * showing the reason it was blocked. A decision's note is its question; the
 * options live on the `Decision` row.
 */
export function statusNoteFor(input: TransitionInput): string | null {
  switch (input.to) {
    case "needs_user_action":
      return input.instructions;
    case "needs_qa":
      return input.summary;
    case "needs_user_decision":
      return input.decision.question;
    default:
      return input.reason ?? null;
  }
}

/* ------------------------------------------------------------------ *
 * Side effects
 * ------------------------------------------------------------------ */

/** The derived timestamps a status change may write. */
export interface StatusTimestamps {
  startedAt?: Date;
  completedAt?: Date | null;
}

/**
 * | Transition | Effect |
 * | ---------- | ------ |
 * | → `in_progress` | `startedAt = now`, only the first time |
 * | → `done` | `completedAt = now` |
 * | `done` → anything else | `completedAt = null` (reopened) |
 *
 * `startedAt` is never cleared: it answers "when did work first begin", which a
 * later trip back to `todo` does not undo.
 *
 * Pure, and `now` is injectable so a test can pin it.
 */
export function applyStatusSideEffects(
  from: TaskStatus,
  to: TaskStatus,
  current: { startedAt: Date | null },
  now: Date = new Date(),
): StatusTimestamps {
  const effects: StatusTimestamps = {};

  if (to === "in_progress" && current.startedAt === null) effects.startedAt = now;
  if (to === "done") effects.completedAt = now;
  else if (from === "done") effects.completedAt = null;

  return effects;
}
