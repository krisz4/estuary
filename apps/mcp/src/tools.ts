import {
  addDependencyInputSchema,
  answerDecisionInputSchema,
  createCommentInputSchema,
  createTaskInputSchema,
  decisionRequestSchema,
  eventsQuerySchema,
  expectedVersionSchema,
  formatTaskSort,
  githubImportInputSchema,
  nextTaskInputSchema,
  parseGithubUrl,
  parseReference,
  releaseTaskInputSchema,
  taskIdSchema,
  taskListQuerySchema,
  taskStatsQuerySchema,
  transitionInputSchema,
  updateTaskInputSchema,
  type Comment,
  type EventsResponse,
  type GithubLinkStatus,
  type NextTaskResponse,
  type PaginatedTasks,
  type Task,
  type TaskGithubStatus,
  type TaskStats,
  type TaskStatus,
  type TransitionInput,
} from "@estuary/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { ApiError, ApiUnavailableError, type ApiClient } from "./api-client.js";
import type { Config } from "./config.js";
import {
  formatApiError,
  formatComment,
  formatEvents,
  formatStats,
  formatTask,
  formatTaskList,
  formatWrite,
} from "./format.js";
import { deriveIdempotencyKey } from "./idempotency.js";

/**
 * The tool surface. Input schemas are the `@estuary/contracts` schemas the API
 * itself validates with, composed rather than retyped — so a bound or an enum
 * that changes in the contract changes here too, and the model sees the same
 * limits the API will enforce.
 *
 * Descriptions are the agent's manual: they are what a model reads when it
 * picks a tool, so each one says *when* to use it and what it leaves behind,
 * not just what it does. The workflow as a whole is in the `task-workflow` skill
 * (`integrations/claude-code/skills/task-workflow/SKILL.md`).
 */

/* ------------------------------------------------------------------ *
 * Shared inputs
 * ------------------------------------------------------------------ */

/**
 * A task by id (`42`) or by reference (`"TASK-000042"`, `"#42"`). Humans quote
 * references in chat; making the model convert them first is a step it gets
 * wrong. Parsed with the contract's `parseReference`, the same parser the list
 * search uses.
 */
export const taskIdInput = z
  .union([
    taskIdSchema,
    z.string().transform((value, ctx) => {
      const id = parseReference(value);
      if (id === null) {
        ctx.addIssue({ code: "custom", message: 'Expected a task id like 42 or "TASK-000042"' });
        return z.NEVER;
      }
      return id;
    }),
  ])
  .describe('Task id (42) or reference ("TASK-000042")');

const expectedVersion = expectedVersionSchema.describe(
  "The task's `version` from your last read. The write fails with VERSION_CONFLICT if someone changed it since — recommended on every write.",
);

type TransitionVariant = (typeof transitionInputSchema.options)[number];
type VariantFor<T extends TaskStatus> = Extract<
  TransitionVariant,
  { shape: { to: z.ZodLiteral<T> } }
>;

/** The branch of the transition union for one target status, so wrappers reuse its field schemas. */
const variantFor = <T extends TaskStatus>(to: T): VariantFor<T> => {
  const found = transitionInputSchema.options.find((option) => option.shape.to.value === to);
  if (found === undefined) throw new Error(`transitionInputSchema has no branch for "${to}"`);
  return found as VariantFor<T>;
};

const listShape = taskListQuerySchema.out.shape;

const FOLLOW_UPS_HELP =
  "Work you found but did not do — your recommendations, what you left out, a bug next door. Each becomes a subtask a human sees: " +
  "give acceptanceCriteria and it is todo; otherwise it is needs_refinement with `missing` (what a person must decide or supply) as the note. " +
  "Use this instead of separate task_create calls or mentioning it only in chat.";
const eventsShape = eventsQuerySchema.out.shape;

/** Most recent comments `task_get` shows by default; the thread can be long. */
export const DEFAULT_COMMENT_LIMIT = 10;
export const MAX_COMMENT_LIMIT = 200;

/* ------------------------------------------------------------------ *
 * Result plumbing
 * ------------------------------------------------------------------ */

const text = (body: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text: body }],
  ...(isError ? { isError: true } : {}),
});

/**
 * Runs a handler and turns the two expected failure kinds into `isError`
 * results the model can read and act on. Anything else is a bug in this server;
 * it propagates and the SDK reports its message as a tool error.
 */
const run = async (handler: () => Promise<string | CallToolResult>): Promise<CallToolResult> => {
  try {
    const result = await handler();
    return typeof result === "string" ? text(result) : result;
  } catch (error) {
    if (error instanceof ApiError) return text(formatApiError(error), true);
    if (error instanceof ApiUnavailableError) return text(error.message, true);
    throw error;
  }
};

const taskPath = (id: number, suffix = "") => `/tasks/${id}${suffix}`;

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

export const registerTools = (server: McpServer, api: ApiClient, config: Config): void => {
  const defaultProjectNote =
    config.defaultProject === undefined
      ? "No default project is configured, so omitting it searches every project."
      : `Omitting it uses the default project "${config.defaultProject}".`;

  const transition = (id: number, body: TransitionInput) =>
    api.post<Task>(taskPath(id, "/transition"), body);

  /**
   * Live state of a task's GitHub links, for `task_get`. Best-effort by design:
   * any failure prints nothing rather than failing the read. The integration is
   * optional, so the first "not configured" answer is remembered and every later
   * `task_get` skips the request; a transient failure is not remembered.
   */
  let githubEnabled = true;
  const githubStatus = async (task: Task): Promise<GithubLinkStatus[]> => {
    if (!githubEnabled) return [];
    if (!task.links.some((link) => parseGithubUrl(link.url) !== null)) return [];
    try {
      const { data } = await api.get<TaskGithubStatus>(taskPath(task.id, "/github"));
      return data.data;
    } catch (error) {
      // NOT_FOUND: an API from before the integration existed has no such route.
      if (
        error instanceof ApiError &&
        (error.code === "INTEGRATION_NOT_CONFIGURED" || error.code === "NOT_FOUND")
      ) {
        githubEnabled = false;
      }
      return [];
    }
  };

  /* ---------------------------- reads ---------------------------- */

  server.registerTool(
    "task_list",
    {
      title: "List tasks",
      description:
        "Search and list tasks, paged, newest first by default: one line per task (status, priority, project, labels, parent, subtasks, open dependencies, claim, version) plus a description snippet. " +
        "Filters AND together; values inside one filter OR. status/priority/project/label take arrays. " +
        'q: every whitespace-separated term must match (double-quote a phrase: "login redirect" safari is two terms), searched across title, description, acceptance criteria, status note, links, and comments; a term like TASK-42 also matches that task. ' +
        "Relations: dependsOn: X = who waits on X (its dependents); dependencyOf: X = what X waits on; parentId: X = X's subtasks; parentIsNull: true = top-level tasks and epics only. " +
        "label narrows inside a project — in a monorepo, the workspace (web, api). " +
        "Search before filing a follow-up, so you do not file a duplicate. " +
        'sort is "field:direction" with field one of id, createdAt, updatedAt, title, status, priority. ' +
        'To answer a human\'s "what needs me?", use attention: true — decisions, actions, QA, refinement, untriaged agent suggestions, and tasks blocked on an outside reason, in one call. ' +
        "verbose: true appends the rows as JSON. task_get a task before working on it.",
      inputSchema: {
        ...listShape,
        parentId: taskIdInput.optional().describe("Only subtasks of this task."),
        dependsOn: taskIdInput
          .optional()
          .describe("Only tasks that depend on this one (who waits on it)."),
        dependencyOf: taskIdInput
          .optional()
          .describe("Only tasks this one depends on (what it waits on)."),
        verbose: z
          .boolean()
          .optional()
          .describe("Append the page as JSON (descriptions truncated). Costs ~3x the tokens."),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      run(async () => {
        const { sort, verbose, ...filters } = args;
        const { data } = await api.get<PaginatedTasks>("/tasks", {
          ...filters,
          sort: formatTaskSort(sort),
        });
        return formatTaskList(data, verbose === true);
      }),
  );

  server.registerTool(
    "task_get",
    {
      title: "Get a task",
      description:
        "The full task: description, acceptance criteria, statusNote (why it is in its status), the most recent comments, parent/subtasks, " +
        "dependencies/dependents, open and answered decisions, claim, version, and the live state of its GitHub PR/issue links when the server has the GitHub integration. " +
        "Read it before starting work and before any write you want to guard with expectedVersion.",
      inputSchema: {
        taskId: taskIdInput,
        commentLimit: z
          .number()
          .int()
          .min(0)
          .max(MAX_COMMENT_LIMIT)
          .optional()
          .describe(
            `How many of the most recent comments to include (default ${DEFAULT_COMMENT_LIMIT}; 0 = none). The output says how many older ones were left out.`,
          ),
      },
      annotations: { readOnlyHint: true },
    },
    ({ taskId, commentLimit }) =>
      run(async () => {
        const { data } = await api.get<Task>(taskPath(taskId));
        const github = await githubStatus(data);
        return formatTask(data, undefined, {
          commentLimit: commentLimit ?? DEFAULT_COMMENT_LIMIT,
          github,
        });
      }),
  );

  server.registerTool(
    "task_events",
    {
      title: "Task events feed",
      description:
        "What changed since a cursor: every create, edit, status change, claim, comment, decision, dependency change, and linked GitHub PR event, oldest first. " +
        "Omit `after` (or pass 0) the first time, then pass the returned nextAfter to see only newer events. " +
        `Covers every project unless you narrow it: taskId (one task), project (e.g. ["${config.defaultProject ?? "estuary"}"]), actor (who did it, e.g. a human's human:<name>), type (e.g. ["task.status_changed", "decision.answered"]).`,
      inputSchema: {
        after: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Event id cursor: the nextAfter from your previous call."),
        taskId: taskIdInput.optional(),
        project: eventsShape.project.describe("Only events of tasks in these projects."),
        actor: eventsShape.actor.describe("Only events by this actor, e.g. human:dana."),
        type: eventsShape.type.describe("Only these event types."),
        limit: eventsShape.limit,
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      run(async () => {
        const { data } = await api.get<EventsResponse>("/events", args);
        return formatEvents(data);
      }),
  );

  server.registerTool(
    "task_stats",
    {
      title: "Task counts",
      description:
        "Count of tasks per status, plus needsAttention: how many are waiting on a person (what task_list attention: true returns). " +
        "Cheap; use it for a quick overview before listing.",
      inputSchema: taskStatsQuerySchema.out.shape,
      annotations: { readOnlyHint: true },
    },
    ({ project }) =>
      run(async () => {
        const { data } = await api.get<TaskStats>("/tasks/stats", { project });
        return formatStats(data);
      }),
  );

  /* --------------------------- creating --------------------------- */

  server.registerTool(
    "task_create",
    {
      title: "Create a task",
      description:
        "File a new task. New work goes in backlog (the default). Use needs_refinement when it is too vague to act on, and todo only when you can write acceptanceCriteria (required for todo). " +
        `project is the repository's slug. ${defaultProjectNote} ` +
        "Subtasks: set parentId. " +
        "labels: the monorepo workspace(s) the task is about (web, api) and/or its kind (bug, flaky-test). " +
        "An idempotencyKey is always sent: if you omit one it is derived from project + title, so retrying or re-running never files a duplicate — while a task with that key is still open, a repeat returns it unchanged. " +
        "Once that task is done or deferred the key is retired and a new task is created. Pass your own key to file a second open task under an existing title. " +
        "Optional `transition` moves the task on right after creating it (e.g. to blocked with blockedBy, or in_progress to claim it). " +
        "That is two requests, not one atomic write: if the transition fails the task still exists — the error says so; fix it with task_transition, do not create again.",
      inputSchema: createTaskInputSchema.safeExtend({
        transition: transitionInputSchema
          .optional()
          .describe("Applied after creation; same payload as task_transition."),
      }),
    },
    ({ transition: next, ...fields }) =>
      run(async () => {
        // `null` means "no project" on purpose; only an omitted project falls back.
        const project = fields.project === undefined ? config.defaultProject : fields.project;
        const idempotencyKey = fields.idempotencyKey ?? deriveIdempotencyKey(project, fields.title);
        const created = await api.post<Task>("/tasks", { ...fields, project, idempotencyKey });
        const task = created.data;
        const replay = created.status === 200;
        const heading = replay
          ? `Already open as ${task.reference} (idempotencyKey "${idempotencyKey}") — returned the existing task unchanged, no duplicate filed.`
          : `Created ${task.reference}.`;

        // A fresh task echoes only what the agent needs next (reference,
        // version); a replay returns the stored task in full, since what is
        // stored may differ from what this call sent.
        const show = (shown: Task, line: string) =>
          replay ? formatTask(shown, line) : formatWrite(shown, line);

        if (next === undefined) return show(task, heading);

        // Already where this call wanted it: the first run's transition landed.
        if (replay && task.status === next.to) return show(task, heading);

        // On a replay, only finish a transition the first run never got to. A task
        // that has moved on since (claimed, handed to QA, …) must not be dragged
        // back to where the original call wanted it.
        if (replay && task.status !== fields.status) {
          return formatTask(
            task,
            `${heading} It has moved on since (now ${task.status}), so the transition was skipped.`,
          );
        }

        try {
          const moved = await transition(task.id, {
            ...next,
            expectedVersion: next.expectedVersion ?? task.version,
          });
          return show(moved.data, `${heading} Then moved to ${next.to}.`);
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          const context =
            `${task.reference} WAS created (status ${task.status}), but moving it to ${next.to} failed. ` +
            `Do not create it again — fix the payload and call task_transition on ${task.reference}.`;
          return text(formatApiError(error, context), true);
        }
      }),
  );

  server.registerTool(
    "task_update",
    {
      title: "Edit a task",
      description:
        "Change a task's fields: title, description, priority, project, assignee, acceptanceCriteria, links (replaces the whole list), labels (replaces the whole set), parentId. " +
        "Send only what changes; null clears an optional field. Status is not editable here — use task_transition or the hand-off tools.",
      inputSchema: updateTaskInputSchema.extend({ taskId: taskIdInput, expectedVersion }),
    },
    ({ taskId, ...fields }) =>
      run(async () => {
        const { data } = await api.patch<Task>(taskPath(taskId), fields);
        return formatWrite(data, "Updated.");
      }),
  );

  const importShape = githubImportInputSchema.shape;
  const bareIssue = /^#?(\d{1,9})$/;
  server.registerTool(
    "task_import_github_issue",
    {
      title: "Import a GitHub issue",
      description:
        "Turn a GitHub issue into a task: its title, its body as the description, and a link back. " +
        (config.githubRepo === undefined
          ? 'issue is the issue URL or "owner/repo#123". '
          : `issue is the issue URL, "owner/repo#123", or "#123" for this repository (${config.githubRepo}). `) +
        "Idempotent per issue: importing an issue whose task is still open returns that task instead of a duplicate. " +
        "project defaults to the issue's repository name. Lands in backlog (or needs_refinement); refine it into todo with acceptance criteria before working it. " +
        "Needs the GitHub integration on the server (INTEGRATION_NOT_CONFIGURED otherwise — then use task_create with the issue URL in links).",
      inputSchema: {
        issue: z
          .string()
          .trim()
          .min(1)
          .describe('Issue URL (https://github.com/owner/repo/issues/123) or "owner/repo#123".'),
        project: importShape.project.describe(
          "Project slug. Omitted: the issue's repository name.",
        ),
        status: importShape.status,
        priority: importShape.priority,
        labels: importShape.labels,
      },
    },
    ({ issue, ...rest }) =>
      run(async () => {
        const bare = bareIssue.exec(issue);
        if (bare !== null) {
          if (config.githubRepo === undefined) {
            return text(
              `"${issue}" names no repository and this checkout's origin is not on GitHub. Pass the issue URL or "owner/repo#${bare[1]}".`,
              true,
            );
          }
          issue = `${config.githubRepo}#${bare[1]}`;
        }
        if (parseGithubUrl(issue, true)?.kind !== "issue") {
          return text(
            `"${issue}" is not a GitHub issue. Pass an issue URL (…/issues/123) or "owner/repo#123" — pull requests cannot be imported.`,
            true,
          );
        }
        const imported = await api.post<Task>("/integrations/github/import", { issue, ...rest });
        const task = imported.data;
        const heading =
          imported.status === 200
            ? `Already imported as ${task.reference} (still open) — returned it unchanged.`
            : `Imported ${issue} as ${task.reference}.`;
        return formatTask(task, heading);
      }),
  );

  /* ------------------------ claims & leases ------------------------ */

  server.registerTool(
    "task_next",
    {
      title: "Claim the next task",
      description:
        "Atomically claim the best available task and move it to in_progress for you: the highest-priority todo whose dependencies are all done, " +
        "or an in_progress task whose previous holder's lease expired (continue their work — read its comments first). " +
        `${defaultProjectNote} Pass allProjects: true to take work from any project. ` +
        'label: only tasks carrying one of these labels — pass your workspace (e.g. ["web"]) when you work in one part of a monorepo. ' +
        "Then: task_get is not needed (the full task is returned) — read the acceptance criteria and comments, work, heartbeat, and finish with one hand-off.",
      inputSchema: nextTaskInputSchema.extend({
        allProjects: z
          .boolean()
          .optional()
          .describe("Ignore the default project and consider every project."),
      }),
    },
    ({ allProjects, ...filters }) =>
      run(async () => {
        const project =
          filters.project ??
          (allProjects === true || config.defaultProject === undefined
            ? undefined
            : [config.defaultProject]);
        const { data } = await api.post<NextTaskResponse>("/tasks/next", { ...filters, project });
        if (data.task === null) {
          const scope = project === undefined ? "any project" : `project ${project.join(", ")}`;
          return (
            `Nothing to claim in ${scope}: no todo task with its dependencies done, and no expired lease. ` +
            (project === undefined ? "" : "Try allProjects: true, or ") +
            "task_list backlog / needs_refinement tasks to find work that could be refined into todo."
          );
        }
        return formatTask(
          data.task,
          `Claimed ${data.task.reference} — it is yours until the lease expires; heartbeat while you work.`,
        );
      }),
  );

  server.registerTool(
    "task_claim",
    {
      title: "Claim a task",
      description:
        "Claim a specific task and move it to in_progress for you (a lease, ~30 minutes, renewed by heartbeat). " +
        "Use when a human names the task to work on; otherwise prefer task_next. Fails with TASK_ALREADY_CLAIMED if someone else holds a live lease — then leave it alone.",
      inputSchema: { taskId: taskIdInput, expectedVersion },
    },
    ({ taskId, expectedVersion: version }) =>
      run(async () => {
        const { data } = await api.post<Task>(taskPath(taskId, "/claim"), {
          expectedVersion: version,
        });
        return formatTask(data, "Claimed.");
      }),
  );

  server.registerTool(
    "task_heartbeat",
    {
      title: "Extend your lease",
      description:
        "Keep your claim alive while you work on a task you hold. Call it at least every 10 minutes of work and before anything long-running (a big test run, a build). " +
        "If the lease lapses, another agent may take the task over. Does not change the task's version.",
      inputSchema: { taskId: taskIdInput },
      annotations: { idempotentHint: true },
    },
    ({ taskId }) =>
      run(async () => {
        const { data } = await api.post<Task>(taskPath(taskId, "/heartbeat"));
        return `Lease extended until ${data.claim?.expiresAt ?? "(no live claim)"} — ${data.reference} v${data.version}.`;
      }),
  );

  server.registerTool(
    "task_release",
    {
      title: "Release a task",
      description:
        "Give up a task you hold without finishing it; it goes back to todo for someone else. " +
        "Use when you are stopping (end of session, switching tasks, out of your depth) and none of the hand-offs fit. " +
        "The reason should say what you did and what is left, so the next agent can continue.",
      inputSchema: releaseTaskInputSchema.extend({
        taskId: taskIdInput,
        followUps: releaseTaskInputSchema.shape.followUps.describe(FOLLOW_UPS_HELP),
        expectedVersion,
      }),
    },
    ({ taskId, ...body }) =>
      run(async () => {
        const { data } = await api.post<Task>(taskPath(taskId, "/release"), body);
        return formatWrite(data, "Released.");
      }),
  );

  /* -------------------------- transitions -------------------------- */

  server.registerTool(
    "task_transition",
    {
      title: "Change a task's status",
      description:
        "Move a task to any status; the payload is what that status requires. " +
        "backlog {reason?} · needs_refinement {reason: what is unclear} · todo {acceptanceCriteria unless the task has them} · " +
        "in_progress {} (claims it for you) · blocked {reason and/or blockedBy task ids} · needs_user_decision {decision} · " +
        "needs_user_action {instructions} · needs_qa {summary, links?, concerns?, followUps?} · deferred {reason} · done — humans only; agents get ACTOR_NOT_PERMITTED. " +
        "Leaving in_progress drops your claim. For hand-offs prefer task_submit_for_qa, task_request_decision, task_request_action, task_block.",
      inputSchema: { taskId: taskIdInput, transition: transitionInputSchema },
    },
    ({ taskId, transition: body }) =>
      run(async () => {
        const { data } = await transition(taskId, body);
        return formatWrite(data, `Moved to ${body.to}.`);
      }),
  );

  const qa = variantFor("needs_qa").shape;
  server.registerTool(
    "task_submit_for_qa",
    {
      title: "Hand off for QA",
      description:
        "Finish a task: move it to needs_qa for a human to verify. This is how agents complete work — agents cannot mark tasks done. " +
        "Only when the acceptance criteria are met. Releases your claim. " +
        "If the server's GitHub webhook is connected, putting the task reference (e.g. TASK-000042) in the PR title or branch name links the PR to the task automatically; either way, pass the PR in links.",
      inputSchema: {
        taskId: taskIdInput,
        summary: qa.summary.describe(
          "What changed, how to verify it (commands, URLs, screens), and anything deliberately left out.",
        ),
        links: qa.links.describe("PR, branch, or commit links; appended to the task's links."),
        concerns: qa.concerns.describe(
          "Only if a reviewer must look at something specific: a deviation from the criteria, a risk, a shortcut, a test you could not run. Omit for routine work — the human can then approve it in one click.",
        ),
        followUps: qa.followUps.describe(FOLLOW_UPS_HELP),
        expectedVersion,
      },
    },
    ({ taskId, ...body }) =>
      run(async () => {
        const { data } = await transition(taskId, { to: "needs_qa", ...body });
        return formatWrite(data, "Handed off for QA.");
      }),
  );

  server.registerTool(
    "task_request_decision",
    {
      title: "Ask a human to decide",
      description:
        "Stop and ask a human to choose, when the call is not yours to make: product or UX trade-offs, architecture, scope changes, anything risky, destructive, or costly. " +
        "Moves the task to needs_user_decision and releases your claim. Ask one question; offer 2–6 distinct options, each with a description of its consequences; " +
        "name your recommendedOption (must be one of the labels) if you have one; put what you found in context. " +
        "Once answered the task returns to todo with the answer in its statusNote.",
      inputSchema: decisionRequestSchema.safeExtend({ taskId: taskIdInput, expectedVersion }),
    },
    ({ taskId, expectedVersion: version, ...decision }) =>
      run(async () => {
        const { data } = await transition(taskId, {
          to: "needs_user_decision",
          decision,
          expectedVersion: version,
        });
        return formatWrite(data, "Waiting on a human decision.");
      }),
  );

  server.registerTool(
    "task_request_action",
    {
      title: "Ask a human to act",
      description:
        "Hand off when a human must do something you cannot: grant access, create a secret or account, approve something in an external system, test on real hardware. " +
        "Moves the task to needs_user_action and releases your claim.",
      inputSchema: {
        taskId: taskIdInput,
        instructions: variantFor("needs_user_action").shape.instructions.describe(
          "Exactly what to do, where, and how to tell it worked — written so the human needs nothing else.",
        ),
        expectedVersion,
      },
    },
    ({ taskId, ...body }) =>
      run(async () => {
        const { data } = await transition(taskId, { to: "needs_user_action", ...body });
        return formatWrite(data, "Waiting on a human action.");
      }),
  );

  const blocked = variantFor("blocked").shape;
  server.registerTool(
    "task_block",
    {
      title: "Mark a task blocked",
      description:
        "The task cannot move until something else happens. Name the tasks it waits on in blockedBy (they become dependencies, and the task returns to todo by itself once they are all done), " +
        "and/or give a reason for an external blocker. Releases your claim. Not for questions to a human — use task_request_decision or task_request_action.",
      inputSchema: {
        taskId: taskIdInput,
        reason: blocked.reason.describe(
          "What it is waiting for. Required unless blockedBy names a task.",
        ),
        blockedBy: blocked.blockedBy.describe("Ids of the tasks this one waits on."),
        expectedVersion,
      },
    },
    ({ taskId, ...body }) =>
      run(async () => {
        const { data } = await transition(taskId, { to: "blocked", ...body });
        return formatWrite(data, "Blocked.");
      }),
  );

  server.registerTool(
    "task_answer_decision",
    {
      title: "Answer a decision",
      description:
        "Record a human's answer to a task's open decision — use it only when the human has told you their answer in this conversation. " +
        "choice must be one of the option labels; note carries free-form nuance (either or both). The task returns to todo for the next agent. " +
        "The answer is attributed to your actor.",
      inputSchema: answerDecisionInputSchema.safeExtend({ taskId: taskIdInput }),
    },
    ({ taskId, ...body }) =>
      run(async () => {
        const { data } = await api.post<Task>(taskPath(taskId, "/decision/answer"), body);
        return formatWrite(data, "Decision answered.");
      }),
  );

  /* ------------------------ comments & deps ------------------------ */

  server.registerTool(
    "task_comment",
    {
      title: "Comment on a task",
      description:
        "Add to a task's thread. kind: progress — your working log while you hold the task (post at meaningful milestones: approach chosen, part done, surprise found); " +
        "qa_feedback — why a needs_qa hand-off is being sent back; note — anything else (the default). Comments are allowed on any task, claimed or not.",
      inputSchema: createCommentInputSchema.extend({ taskId: taskIdInput }),
    },
    ({ taskId, ...body }) =>
      run(async () => {
        const { data } = await api.post<Comment>(taskPath(taskId, "/comments"), body);
        return formatComment(data);
      }),
  );

  server.registerTool(
    "task_add_dependency",
    {
      title: "Add a dependency",
      description:
        "Record that taskId cannot start until dependsOnId is done. task_next skips it until then (deferred does not count as done). " +
        "Adding an existing dependency is a no-op; one that would close a loop fails with DEPENDENCY_CYCLE.",
      inputSchema: addDependencyInputSchema.extend({
        taskId: taskIdInput,
        dependsOnId: addDependencyInputSchema.shape.dependsOnId.describe(
          "The task that must be done first.",
        ),
      }),
    },
    ({ taskId, dependsOnId }) =>
      run(async () => {
        const { data } = await api.post<Task>(taskPath(taskId, "/dependencies"), { dependsOnId });
        return formatWrite(data, `Now depends on task ${dependsOnId}.`);
      }),
  );

  server.registerTool(
    "task_remove_dependency",
    {
      title: "Remove a dependency",
      description:
        "Drop taskId's dependency on dependsOnId. If that was the last unfinished blocker of a blocked task, the task returns to todo by itself.",
      inputSchema: { taskId: taskIdInput, dependsOnId: taskIdInput },
    },
    ({ taskId, dependsOnId }) =>
      run(async () => {
        const { data } = await api.delete<Task>(taskPath(taskId, `/dependencies/${dependsOnId}`));
        return formatWrite(data, `No longer depends on task ${dependsOnId}.`);
      }),
  );
};
