#!/usr/bin/env node
/**
 * SessionStart hook: tells the agent, before its first turn, which tasks it
 * still holds and how many are waiting on a human — so a resumed or restarted
 * session picks its claimed work back up instead of leaving it to expire.
 *
 * Plain text on stdout becomes context for Claude. **It must never get in the
 * way of a session**: any failure (API down, bad config, slow network) exits 0
 * with no output. The MCP tools report connection problems properly when the
 * agent actually uses them.
 *
 * No dependencies — Node's global `fetch` only — so it runs from the plugin
 * directory as-is.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const TIMEOUT_MS = 2500;

/** Plugin options arrive as CLAUDE_PLUGIN_OPTION_*; plain TASKS_* works for manual setups. */
const setting = (option, envName, fallback) => {
  for (const value of [process.env[`CLAUDE_PLUGIN_OPTION_${option}`], process.env[envName]]) {
    if (value !== undefined && value.trim() !== "" && !/^\$\{[^}]*\}$/.test(value.trim()))
      return value.trim();
  }
  return fallback;
};

const apiUrl = setting("API_URL", "TASKS_API_URL", "http://localhost:4000/api/v1").replace(
  /\/+$/,
  "",
);
const actor = setting("ACTOR", "TASKS_ACTOR", "agent:claude-code").toLowerCase();
const token = setting("API_TOKEN", "TASKS_API_TOKEN", undefined);

const readHookInput = () => {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
};

const getJson = async (path) => {
  const headers = { Accept: "application/json", "X-Actor": actor };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${apiUrl}${path}`, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

/** Same rule as `projectSchema` in packages/contracts: a lowercase slug, or nothing. */
const projectSlug = (dir) => {
  if (typeof dir !== "string" || dir === "") return undefined;
  const name = basename(dir).toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) ? name : undefined;
};

const main = async () => {
  const input = readHookInput();
  const project = projectSlug(process.env.CLAUDE_PROJECT_DIR ?? input.cwd);

  // `claimedBy` matches the stored holder even after the lease lapsed, so the
  // live-claim check stays here. One page of 100 is plenty.
  const [inProgress, stats] = await Promise.all([
    getJson(
      `/tasks?status=in_progress&claimedBy=${encodeURIComponent(actor)}&pageSize=100&sort=updatedAt:desc`,
    ),
    getJson("/tasks/stats"),
  ]);
  const mine = inProgress.data.filter((task) => task.claim?.actor === actor);

  const lines = [
    `Task manager: ${apiUrl}, acting as ${actor}.` +
      (project === undefined ? "" : ` Use project "${project}" for tasks in this repository.`),
  ];
  if (mine.length > 0) {
    lines.push(`You still hold ${mine.length} claimed task(s):`);
    for (const task of mine) {
      lines.push(
        `- ${task.reference} ${task.title} (project ${task.project ?? "none"}, lease until ${task.claim.expiresAt})`,
      );
    }
    lines.push(
      "Resume each one (task_get, then task_heartbeat while working) or hand it off / task_release it — never leave it idle.",
    );
  }
  if (stats.needsAttention > 0) {
    lines.push(
      `${stats.needsAttention} task(s) are waiting on a human (needs_user_decision, needs_user_action, needs_qa).`,
    );
  }
  lines.push("Follow the task-workflow skill when working tasks.");
  process.stdout.write(`${lines.join("\n")}\n`);
};

try {
  await main();
} catch {
  // Unreachable, unauthorized, or malformed: stay silent, never block the session.
}
process.exit(0);
