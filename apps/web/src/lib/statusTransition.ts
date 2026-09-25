import { taskStatusSchema, type TaskStatus } from "@helpdesk/contracts";
import { errorDescription } from "@/lib/errorMessages";

/**
 * Status-change helpers shared by the detail page's picker, the board, and the
 * inbox.
 *
 * ## There is no transition table, on either side
 *
 * Any status may move to any other (`docs/features/Task_Workflow_API.md`); what
 * a status *requires* is expressed as the shape of the transition payload — a
 * reason for `blocked`, a question for `needs_user_decision`, a summary for
 * `needs_qa`. So the only question the client asks before a move is "does this
 * target need anything from the user?", answered by `transitionNeedsInput`,
 * and the answer decides between posting straight away and opening
 * `TransitionDialog`.
 *
 * The client still does not second-guess the server: a direct move that comes
 * back `VALIDATION_ERROR` (the acceptance criteria the task was thought to have
 * were cleared by an agent a second ago) is simply reopened in the dialog with
 * the server's messages on its fields.
 */

export const isTaskStatus = (value: string): value is TaskStatus =>
  taskStatusSchema.safeParse(value).success;

/**
 * Targets whose payload has a required field. `todo` is conditional and handled
 * below: its `acceptanceCriteria` is required only when the task has none yet.
 */
const ALWAYS_NEEDS_INPUT: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "needs_refinement",
  "blocked",
  "needs_user_decision",
  "needs_user_action",
  "needs_qa",
  "deferred",
]);

/**
 * `true` when moving `task` to `target` needs the dialog.
 *
 * `backlog`, `in_progress` and `done` never do — their payload is an optional
 * reason, which a drag or a picker has no way to ask for and no need to.
 */
export const transitionNeedsInput = (
  target: TaskStatus,
  task: { acceptanceCriteria: string | null },
): boolean => {
  if (target === "todo") return task.acceptanceCriteria === null;
  return ALWAYS_NEEDS_INPUT.has(target);
};

/**
 * Copy for a failed status change, for the toast or the inline message beside
 * the control. Returns `undefined` when there is no error at all.
 *
 * `errorDescription` rather than the bare copy: the failures specific to a
 * move — a claim held by an agent, `ACTOR_NOT_PERMITTED` — carry details worth
 * naming ("agent:claude-code holds the claim").
 */
export const statusChangeErrorMessage = (error: unknown): string | undefined => {
  if (error === undefined || error === null) return undefined;
  return errorDescription(error);
};
