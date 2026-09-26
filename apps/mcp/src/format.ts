import type {
  Comment,
  EventsResponse,
  GithubLinkStatus,
  PaginatedTasks,
  Task,
  TaskRef,
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
 * Lists are the exception: one line per task carries everything needed to pick
 * one (id, status, version, claim, relations), and the JSON is opt-in
 * (`verbose`). A 20-row page with the JSON is ~14k characters; without, ~4k.
 *
 * JSON is compact (no indentation): it is read by a model, not a person, and
 * every space counts against Claude Code's MCP output budget.
 */

type TaskLike = TaskSummary | Task;

const LIST_TEXT_LIMIT = 280;
/** How much of the description a list row shows. */
export const LIST_SNIPPET_LIMIT = 160;
const LIST_NOTE_LIMIT = 120;

const truncate = (text: string | null, limit: number): string | null =>
  text === null || text.length <= limit
    ? text
    : `${text.slice(0, limit)}… [truncated; task_get for full text]`;

/** Newlines and runs of spaces collapsed, cut at `limit` with an ellipsis. */
const snippet = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit).trimEnd()}…`;
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** `TASK-000042 [in_progress] Fix login redirect · high · project helpdesk · claimed by agent:x until … · v7` */
export const taskLine = (task: TaskLike): string => {
  const parts = [`${task.reference} [${task.status}] ${task.title}`, task.priority];
  if (task.project !== null) parts.push(`project ${task.project}`);
  if (task.labels.length > 0) parts.push(`labels ${task.labels.join(",")}`);
  if (task.claim !== null)
    parts.push(`claimed by ${task.claim.actor} until ${task.claim.expiresAt}`);
  if (task.openDependencyCount > 0) parts.push(`${task.openDependencyCount} open dependencies`);
  parts.push(`v${task.version}`);
  return parts.join(" · ");
};

/**
 * One list row: `TASK-000042 [todo] Title · high · project helpdesk · labels web ·
 * parent #12 · 3 subtasks · 1 open dependency · claimed by agent:x · v7 · updated 2026-09-25`.
 */
export const listLine = (task: TaskSummary): string => {
  const parts = [`${task.reference} [${task.status}] ${task.title}`, task.priority];
  if (task.project !== null) parts.push(`project ${task.project}`);
  if (task.labels.length > 0) parts.push(`labels ${task.labels.join(",")}`);
  if (task.parentId !== null) parts.push(`parent #${task.parentId}`);
  if (task.childCount > 0) parts.push(plural(task.childCount, "subtask"));
  if (task.openDependencyCount > 0)
    parts.push(plural(task.openDependencyCount, "open dependency", "open dependencies"));
  if (task.claim !== null) parts.push(`claimed by ${task.claim.actor}`);
  parts.push(`v${task.version}`, `updated ${task.updatedAt.slice(0, 10)}`);
  return parts.join(" · ");
};

const listRow = (task: TaskSummary): string => {
  const lines = [`- ${listLine(task)}`, `  ${snippet(task.description, LIST_SNIPPET_LIMIT)}`];
  if (task.openDecision !== null) {
    const labels = task.openDecision.options.map((option) => option.label).join(" | ");
    lines.push(`  decision: ${snippet(task.openDecision.question, LIST_NOTE_LIMIT)} [${labels}]`);
  } else if (task.statusNote !== null) {
    lines.push(`  note: ${snippet(task.statusNote, LIST_NOTE_LIMIT)}`);
  }
  return lines.join("\n");
};

const statusNoteLine = (task: TaskLike): string[] =>
  task.statusNote === null ? [] : [`statusNote: ${task.statusNote}`];

/** `TASK-000007 [done] Title`, plus `(project web)` when it lives elsewhere. */
const refLine = (ref: TaskRef, ownProject: string | null): string =>
  `${ref.reference} [${ref.status}] ${ref.title}` +
  (ref.project === ownProject ? "" : ` (project ${ref.project ?? "none"})`);

const relationLines = (task: Task): string[] => {
  const lines: string[] = [];
  if (task.parent !== null) lines.push(`parent: ${refLine(task.parent, task.project)}`);
  const groups: [string, TaskRef[]][] = [
    ["subtasks", task.children],
    ["depends on", task.dependencies],
    ["dependents (wait on this)", task.dependents],
  ];
  for (const [label, refs] of groups) {
    if (refs.length === 0) continue;
    lines.push(`${label}:`, ...refs.map((ref) => `  - ${refLine(ref, task.project)}`));
  }
  return lines;
};

/** `PR acme/web#12 merged · checks success` / `issue acme/web#7 open` / `PR acme/web#9 — unavailable: …`. */
export const githubLine = (link: GithubLinkStatus): string => {
  const name = `${link.kind === "pull" ? "PR" : "issue"} ${link.repo}#${link.number}`;
  if (link.state === null)
    return `${name} — unavailable${link.error === null ? "" : `: ${link.error}`}`;
  return [`${name} ${link.state}`, ...(link.checks === null ? [] : [`checks ${link.checks}`])].join(
    " · ",
  );
};

export interface FormatTaskOptions {
  /**
   * Keep only the most recent N comments (in the text and the JSON). Omitted:
   * keep them all.
   */
  commentLimit?: number | undefined;
  /** Live GitHub state of the task's links; omitted or empty prints nothing. */
  github?: GithubLinkStatus[] | undefined;
}

const limitComments = (task: Task, limit: number | undefined): { task: Task; note?: string } => {
  if (limit === undefined || task.comments.length <= limit) return { task };
  const omitted = task.comments.length - limit;
  const total = task.comments.length;
  const note =
    limit === 0
      ? `comments: ${total} not shown (commentLimit 0) — task_get with commentLimit: ${total} to read them.`
      : `comments: showing the ${limit} most recent of ${total}; ${omitted} older omitted — task_get with commentLimit: ${total} to read them all.`;
  return { task: { ...task, comments: task.comments.slice(total - limit) }, note };
};

export const formatTask = (
  input: TaskLike,
  heading?: string,
  options: FormatTaskOptions = {},
): string => {
  let task: TaskLike = input;
  let commentNote: string | undefined;
  if ("comments" in input) {
    const limited = limitComments(input, options.commentLimit);
    task = limited.task;
    commentNote = limited.note;
  }

  const lines = [heading, taskLine(task), ...statusNoteLine(task)].filter(
    (line): line is string => line !== undefined,
  );
  if (task.openDecision !== null) {
    const labels = task.openDecision.options.map((option) => option.label).join(" | ");
    lines.push(`open decision: ${task.openDecision.question} [${labels}]`);
  }
  if ("decisions" in task) {
    // An agent picking a task back up after a human answered needs the answer
    // more than anything else in the payload, so it is spelled out, not left in JSON.
    for (const decision of task.decisions) {
      if (decision.status !== "answered") continue;
      const answer = [decision.choice, decision.note].filter((part) => part !== null).join(" — ");
      lines.push(
        `answered decision: ${decision.question} → ${answer} (by ${decision.answeredBy ?? "?"})`,
      );
    }
    lines.push(...relationLines(task));
  }
  for (const link of options.github ?? []) lines.push(`github: ${githubLine(link)}`);
  if (commentNote !== undefined) lines.push(commentNote);
  lines.push(JSON.stringify(task));
  return lines.join("\n");
};

/**
 * One line (plus a description snippet) per task. With `verbose`, the page's
 * JSON follows, long free text cut down: a 100-row page of 5 000-character
 * descriptions would blow past Claude Code's MCP output limit, and nothing in a
 * list decision needs the whole description.
 */
export const formatTaskList = (page: PaginatedTasks, verbose = false): string => {
  const { meta } = page;
  const header =
    meta.total === 0
      ? "No tasks match."
      : `${meta.total} task(s) — page ${meta.page} of ${meta.totalPages}` +
        (meta.hasNextPage ? ` (more: page ${meta.page + 1})` : "") +
        (verbose ? "." : ". task_get a task for its full text, comments, and relations.");
  const lines = [header, ...page.data.map(listRow)];
  if (verbose) {
    lines.push(
      JSON.stringify({
        data: page.data.map((task) => ({
          ...task,
          description: truncate(task.description, LIST_TEXT_LIMIT),
          acceptanceCriteria: truncate(task.acceptanceCriteria, LIST_TEXT_LIMIT),
        })),
        meta,
      }),
    );
  }
  return lines.join("\n");
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
      `- #${event.id} ${event.createdAt} task ${event.taskId}` +
      (event.taskTitle == null ? "" : ` "${event.taskTitle}"`) +
      (event.project === null ? "" : ` (${event.project})`) +
      ` ${event.type} by ${event.actor}`,
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
  INTEGRATION_NOT_CONFIGURED:
    "The GitHub integration is off on this server. File the issue with task_create instead and put its URL in links; tell the human if they expected it on.",
  GITHUB_NOT_FOUND:
    "GitHub has no such issue or PR, or it is private and the server's GITHUB_TOKEN cannot see it. Check the URL / owner/repo#number.",
  GITHUB_UNAVAILABLE:
    "GitHub could not be reached or rate-limited the server. Try again later, or file it with task_create and the issue URL in links.",
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
