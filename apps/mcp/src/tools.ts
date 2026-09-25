import {
  addDependencyInputSchema,
  answerDecisionInputSchema,
  createCommentInputSchema,
  createTaskInputSchema,
  decisionRequestSchema,
  eventsQuerySchema,
  expectedVersionSchema,
  formatTaskSort,
  nextTaskInputSchema,
  parseReference,
  releaseTaskInputSchema,
  taskIdSchema,
  taskListQuerySchema,
  taskStatsQuerySchema,
  transitionInputSchema,
  updateTaskInputSchema,
  type Comment,
  type EventsResponse,
  type NextTaskResponse,
  type PaginatedTasks,
  type Task,
  type TaskStats,
  type TaskStatus,
  type TransitionInput,
} from "@helpdesk/contracts";
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
} from "./format.js";
import { deriveIdempotencyKey } from "./idempotency.js";

/**
 * The tool surface. Input schemas are the `@helpdesk/contracts` schemas the API
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

  /* ---------------------------- reads ---------------------------- */

  server.registerTool(
    "task_list",
    {
      title: "List tasks",
      description:
        "Search and list tasks (summaries, paged, newest first by default). Filters AND together; values inside one filter OR. " +
        "status/priority/project take arrays. q matches title/description text or a reference like TASK-42. " +
        'sort is "field:direction" with field one of id, createdAt, updatedAt, title, status, priority. ' +
        'To answer a human\'s "what needs me?", use status [needs_user_decision, needs_user_action, needs_qa]. ' +
        "Descriptions are truncated here — task_get a task before working on it.",
      inputSchema: listShape,
      annotations: { readOnlyHint: true },
    },
    (args) =>
      run(async () => {
        const { sort, ...filters } = args;
        const { data } = await api.get<PaginatedTasks>("/tasks", {
          ...filters,
          sort: formatTaskSort(sort),
        });
        return formatTaskList(data);
      }),
  );

  server.registerTool(
    "task_get",
    {
      title: "Get a task",
      description:
        "The full task: description, acceptance criteria, statusNote (why it is in its status), comments, parent/children, " +
        "dependencies/dependents, open decision, claim, and version. Read it before starting work and before any write you want to guard with expectedVersion.",
      inputSchema: { taskId: taskIdInput },
      annotations: { readOnlyHint: true },
    },
    ({ taskId }) =>
      run(async () => {
        const { data } = await api.get<Task>(taskPath(taskId));
        return formatTask(data);
      }),
  );

  server.registerTool(
    "task_events",
    {
      title: "Task events feed",
      description:
        "What changed since a cursor: every create, edit, status change, claim, comment, decision, and dependency change, oldest first. " +
        "Omit `after` (or pass 0) the first time, then pass the returned nextAfter to see only newer events. Optionally narrow to one task.",
      inputSchema: {
        after: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Event id cursor: the nextAfter from your previous call."),
        taskId: taskIdInput.optional(),
        limit: eventsQuerySchema.out.shape.limit,
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
        "Count of tasks per status, plus needsAttention: how many are waiting on a human (needs_user_decision, needs_user_action, needs_qa). " +
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
        "An idempotencyKey is always sent: if you omit one it is derived from project + title, so retrying or re-running never files a duplicate — a repeat returns the existing task unchanged. Pass your own key to file a new task that reuses an old title. " +
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
          ? `Already existed (idempotencyKey "${idempotencyKey}") — returned the existing task unchanged.`
          : `Created ${task.reference}.`;

        if (next === undefined) return formatTask(task, heading);

        // Already where this call wanted it: the first run's transition landed.
        if (replay && task.status === next.to) return formatTask(task, heading);

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
          return formatTask(moved.data, `${heading} Then moved to ${next.to}.`);
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
        "Change a task's fields: title, description, priority, project, assignee, acceptanceCriteria, links (replaces the whole list), parentId. " +
        "Send only what changes; null clears an optional field. Status is not editable here — use task_transition or the hand-off tools.",
      inputSchema: updateTaskInputSchema.extend({ taskId: taskIdInput, expectedVersion }),
    },
    ({ taskId, ...fields }) =>
      run(async () => {
        const { data } = await api.patch<Task>(taskPath(taskId), fields);
        return formatTask(data, "Updated.");
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
      inputSchema: releaseTaskInputSchema.extend({ taskId: taskIdInput, expectedVersion }),
    },
    ({ taskId, ...body }) =>
      run(async () => {
        const { data } = await api.post<Task>(taskPath(taskId, "/release"), body);
        return formatTask(data, "Released.");
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
        "needs_user_action {instructions} · needs_qa {summary, links?} · deferred {reason} · done — humans only; agents get ACTOR_NOT_PERMITTED. " +
        "Leaving in_progress drops your claim. For hand-offs prefer task_submit_for_qa, task_request_decision, task_request_action, task_block.",
      inputSchema: { taskId: taskIdInput, transition: transitionInputSchema },
    },
    ({ taskId, transition: body }) =>
      run(async () => {
        const { data } = await transition(taskId, body);
        return formatTask(data, `Moved to ${body.to}.`);
      }),
  );

  const qa = variantFor("needs_qa").shape;
  server.registerTool(
    "task_submit_for_qa",
    {
      title: "Hand off for QA",
      description:
        "Finish a task: move it to needs_qa for a human to verify. This is how agents complete work — agents cannot mark tasks done. " +
        "Only when the acceptance criteria are met. Releases your claim.",
      inputSchema: {
        taskId: taskIdInput,
        summary: qa.summary.describe(
          "What changed, how to verify it (commands, URLs, screens), and anything deliberately left out.",
        ),
        links: qa.links.describe("PR, branch, or commit links; appended to the task's links."),
        expectedVersion,
      },
    },
    ({ taskId, ...body }) =>
      run(async () => {
        const { data } = await transition(taskId, { to: "needs_qa", ...body });
        return formatTask(data, "Handed off for QA.");
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
        return formatTask(data, "Waiting on a human decision.");
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
        return formatTask(data, "Waiting on a human action.");
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
        return formatTask(data, "Blocked.");
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
        return formatTask(data, "Decision answered.");
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
        return formatTask(data, `Now depends on task ${dependsOnId}.`);
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
        return formatTask(data, `No longer depends on task ${dependsOnId}.`);
      }),
  );
};
