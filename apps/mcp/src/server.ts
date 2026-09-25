import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ApiClient, type FetchLike } from "./api-client.js";
import type { Config } from "./config.js";
import { registerTools } from "./tools.js";

export const SERVER_NAME = "tasks";
export const SERVER_VERSION = "0.1.0";

/**
 * Sent to the client at initialize; Claude Code puts it in the model's context
 * for as long as the server is connected. It is the always-on core of the
 * rules — the `task-workflow` skill carries the long form (triage, when to file
 * follow-ups), so this stays short enough to be worth its context cost.
 */
export const buildInstructions = (config: Config): string =>
  [
    `Task manager for coding agents. You act as ${config.actor}.`,
    "Statuses: backlog (captured, not ready) · needs_refinement (unclear; statusNote says what is missing) · todo (ready, has acceptance criteria) · " +
      "in_progress (claimed by whoever works it) · blocked (waiting on other tasks or an outside event) · needs_user_decision / needs_user_action (waiting on a human) · " +
      "needs_qa (work finished, awaiting human verification) · done (verified; humans only) · deferred (parked on purpose, with a reason).",
    "Work loop: task_next (or task_claim a named task) → read acceptance criteria and comments → task_heartbeat at least every 10 minutes → " +
      "task_comment kind=progress at milestones → finish with exactly one of task_submit_for_qa, task_request_decision, task_request_action, task_block, or task_release.",
    "Rules: agents never mark tasks done — hand off with task_submit_for_qa. Never leave a task claimed and idle. " +
      "Pass expectedVersion from your last read on writes. File follow-ups you discover as new backlog tasks instead of widening the current one.",
  ].join("\n");

export const createServer = (config: Config, fetchImpl?: FetchLike): McpServer => {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: buildInstructions(config) },
  );
  registerTools(server, new ApiClient(config, fetchImpl), config);
  return server;
};
