#!/usr/bin/env node
/**
 * SessionEnd hook: when a session ends without handing off a task it was
 * working, release that task back to `todo` — so unfinished agent work never
 * sits in `in_progress` behind a dead lease, looking busy to the human and
 * invisible to every other agent until the lease runs out.
 *
 * **Only this session's tasks.** Two sessions in one checkout share an actor,
 * so "everything this actor holds" would pull work out from under the other
 * one. Candidates come only from successful ownership receipts in this
 * session's transcript. The live claim must match both actor and receipt
 * session id; observing a task or adding a comment never grants ownership.
 *
 * Skipped on `/clear`: the conversation goes on in a new session, and the
 * SessionStart hook reminds it of what it holds.
 *
 * Like SessionStart, **it must never get in the way**: any failure exits 0
 * silently. It costs the agent no tokens — it runs after the last turn.
 */
import { readFileSync } from "node:fs";

import { getJson, postJson, readHookInput, resolveIdentity } from "./identity.mjs";
import { ownedTaskSessions } from "./transcript.mjs";

const REASON =
  "Released automatically: the Claude Code session ended before handing this off. " +
  "Read the progress comments and continue.";

const main = async () => {
  const input = readHookInput();
  if (input.reason === "clear" || typeof input.transcript_path !== "string") return;

  const touched = ownedTaskSessions(readFileSync(input.transcript_path, "utf8"));
  if (touched.size === 0) return;

  const { actor } = resolveIdentity(input);
  const held = await getJson(
    `/tasks?status=in_progress&claimedBy=${encodeURIComponent(actor)}&pageSize=100`,
    actor,
  );
  for (const task of held.data) {
    const sessionId = touched.get(task.id);
    if (sessionId === undefined || task.claim?.sessionId !== sessionId) continue;
    try {
      await postJson(
        `/tasks/${task.id}/release`,
        actor,
        {
          reason: REASON,
          expectedVersion: task.version,
        },
        sessionId,
      );
    } catch {
      // Someone moved it meanwhile (a human, a hand-off racing the exit): leave it.
    }
  }
};

try {
  await main();
} catch {
  // Unreachable, unauthorized, unreadable transcript: stay silent, never block.
}
process.exit(0);
