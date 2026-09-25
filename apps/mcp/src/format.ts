import type {
  Comment,
  EventsResponse,
  PaginatedTasks,
  Task,
  TaskStats,
  TaskSummary,
} from "@helpdesk/contracts";

import type { ApiError } from "./api-client.js";

/**
 * Tool results as the model reads them: a line a human would scan first, then
 * the JSON the agent needs to act on (`id`, `version` for `expectedVersion`,
 * `claim`). The summary line leads because a model skims; the JSON follows
 * because a model also copies ids and versions verbatim, and must not have to
 * reconstruct them from prose.
 *
 * JSON is compact (no indentation): it is read by a model, not a person, and
 * every space counts against Claude Code's MCP output budget.
 */

type TaskLike = TaskSummary | Task;

const LIST_TEXT_LIMIT = 280;

const truncate = (text: string | null, limit: number): string | null =>
  text === null || text.length <= limit
    ? text
    : `${text.slice(0, limit)}… [truncated; task_get for full text]`;

/** `TASK-000042 [in_progress] Fix login redirect · high · project helpdesk · claimed by agent:x until … · v7` */
export const taskLine = (task: TaskLike): string => {
  const parts = [`${task.reference} [${task.status}] ${task.title}`, task.priority];
  if (task.project !== null) parts.push(`project ${task.project}`);
  if (task.claim !== null)
    parts.push(`claimed by ${task.claim.actor} until ${task.claim.expiresAt}`);
  if (task.openDependencyCount > 0) parts.push(`${task.openDependencyCount} open dependencies`);
  parts.push(`v${task.version}`);
  return parts.join(" · ");
};

const statusNoteLine = (task: TaskLike): string[] =>
  task.statusNote === null ? [] : [`statusNote: ${task.statusNote}`];

export const formatTask = (task: TaskLike, heading?: string): string => {
  const lines = [heading, taskLine(task), ...statusNoteLine(task)].filter(
    (line): line is string => line !== undefined,
  );
  if (task.openDecision !== null) {
    const labels = task.openDecision.options.map((option) => option.label).join(" | ");
    lines.push(`open decision: ${task.openDecision.question} [${labels}]`);
  }
  // An agent picking a task back up after a human answered needs the answer
  // more than anything else in the payload, so it is spelled out, not left in JSON.
  if ("decisions" in task) {
    for (const decision of task.decisions) {
      if (decision.status !== "answered") continue;
      const answer = [decision.choice, decision.note].filter((part) => part !== null).join(" — ");
      lines.push(
        `answered decision: ${decision.question} → ${answer} (by ${decision.answeredBy ?? "?"})`,
      );
    }
  }
  lines.push(JSON.stringify(task));
  return lines.join("\n");
};

/**
 * The list keeps its JSON, but with long free text cut down: a 100-row page of
 * 5 000-character descriptions would blow past Claude Code's MCP output limit,
 * and nothing in a list decision needs the whole description.
 */
export const formatTaskList = (page: PaginatedTasks): string => {
  const { meta } = page;
  const header =
    meta.total === 0
      ? "No tasks match."
      : `${meta.total} task(s) — page ${meta.page} of ${meta.totalPages}` +
        (meta.hasNextPage ? ` (more: page ${meta.page + 1})` : "");
  const rows = page.data.map((task) => `- ${taskLine(task)}`);
  const compact = {
    data: page.data.map((task) => ({
      ...task,
      description: truncate(task.description, LIST_TEXT_LIMIT),
      acceptanceCriteria: truncate(task.acceptanceCriteria, LIST_TEXT_LIMIT),
    })),
    meta,
  };
  return [header, ...rows, JSON.stringify(compact)].join("\n");
};

export const formatComment = (comment: Comment): string =>
  [
    `Comment #${comment.id} (${comment.kind}) added to task ${comment.taskId}.`,
    JSON.stringify(comment),
  ].join("\n");

export const formatEvents = (feed: EventsResponse): string => {
  const header =
    feed.data.length === 0
      ? `No new events. Poll again with after=${feed.meta.nextAfter}.`
      : `${feed.data.length} event(s). Next poll: after=${feed.meta.nextAfter}` +
        (feed.meta.hasMore ? " (more are waiting — call again now)." : ".");
  const rows = feed.data.map(
    (event) =>
      `- #${event.id} ${event.createdAt} task ${event.taskId} ${event.type} by ${event.actor}`,
  );
  return [header, ...rows, JSON.stringify(feed)].join("\n");
};

export const formatStats = (stats: TaskStats): string => {
  const counts = Object.entries(stats.byStatus)
    .map(([status, count]) => `${status}=${count}`)
    .join(", ");
  return [`${stats.needsAttention} task(s) need a human. ${counts}`, JSON.stringify(stats)].join(
    "\n",
  );
};

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/**
 * One line of "what to do next" for the codes an agent can act on. The API's
 * `message` says what went wrong; this says how to recover, in the terms of the
 * tools the agent has.
 */
const HINTS: Partial<Record<ApiError["code"], string>> = {
  VERSION_CONFLICT:
    "Someone changed the task since you read it: task_get it, reconcile, and retry with the new version as expectedVersion.",
  TASK_ALREADY_CLAIMED:
    "Someone else (details.claimedBy) holds a live claim on this task. Do not work on it — pick another (task_next) or leave a comment instead.",
  NOT_CLAIM_HOLDER:
    "You no longer hold this task (your lease expired or a human took it back). task_get it before doing anything else; claim it again only if it is free.",
  VALIDATION_ERROR: "Fix the fields named in details and call again.",
  AT_LEAST_ONE_FIELD: "Send at least one field to change.",
  UNAUTHORIZED: "The API requires a token: check TASKS_API_TOKEN matches the server's API_TOKEN.",
  ACTOR_NOT_PERMITTED:
    "Agents cannot mark tasks done. Hand finished work over with task_submit_for_qa instead.",
  TASK_NOT_FOUND: "No task with that id — find the right one with task_list (q=…).",
  DEPENDENCY_CYCLE:
    "details.path is the loop that dependency would close; drop or reverse one link.",
  NO_OPEN_DECISION:
    "The task is not waiting on a decision (anymore) — task_get it to see its current status.",
};

export const formatApiError = (error: ApiError, context?: string): string => {
  const lines = [context, `${error.code} (HTTP ${error.status}): ${error.message}`].filter(
    (line): line is string => line !== undefined,
  );
  if (error.details !== undefined) lines.push(`details: ${JSON.stringify(error.details)}`);
  const hint = HINTS[error.code];
  if (hint !== undefined) lines.push(`hint: ${hint}`);
  lines.push(`requestId: ${error.requestId}`);
  return lines.join("\n");
};
