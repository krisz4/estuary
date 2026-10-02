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
 * The actor and project come from `identity.mjs`, shared with the SessionEnd
 * hook and derived exactly like the MCP server derives them.
 */
import { apiUrl, explicitActor, getJson, readHookInput, resolveIdentity } from "./identity.mjs";

const main = async () => {
  const { project, worktree, actor } = resolveIdentity(readHookInput());

  // `claimedBy` matches the stored holder even after the lease lapsed, so the
  // live-claim check stays here. One page of 100 is plenty.
  const [inProgress, stats] = await Promise.all([
    getJson(
      `/tasks?status=in_progress&claimedBy=${encodeURIComponent(actor)}&pageSize=100&sort=updatedAt:desc`,
      actor,
    ),
    getJson("/tasks/stats", actor),
  ]);
  const mine = inProgress.data.filter((task) => task.claim?.actor === actor);

  const lines = [
    `Task manager: ${apiUrl}, acting as ${actor}` +
      (explicitActor === undefined
        ? ` (derived per checkout${worktree === undefined ? "" : ` — worktree ${worktree}`}; set TASKS_ACTOR to override).`
        : ".") +
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
      `${stats.needsAttention} task(s) are waiting on a human (decisions, actions, QA, refinement, untriaged suggestions).`,
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
