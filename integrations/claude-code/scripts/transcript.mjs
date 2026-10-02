#!/usr/bin/env node
/**
 * Reads a Claude Code transcript (JSONL) for the tasks a session worked
 * through the task tools. Its own module so `apps/mcp/src/plugin-hooks.test.ts`
 * can test it without running a hook.
 */

/** `mcp__plugin_estuary_tasks__task_claim` → `task_claim`; anything else → undefined. */
const taskTool = (name) => /(?:^|__)(task_[a-z_]+)$/.exec(name ?? "")?.[1];

/** `42`, `"42"`, `"TASK-000042"`, `"#42"` → 42. */
const toId = (value) => {
  const match = /^(?:TASK-|#)?0*(\d{1,15})$/i.exec(String(value ?? "").trim());
  return match === null ? undefined : Number(match[1]);
};

const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
      : "";

/** Task ids this session's transcript worked through the task tools. */
export const touchedTaskIds = (transcript) => {
  const ids = new Set();
  // Tools whose *result* names the task (it did not exist, or was not chosen, before the call).
  const answersWithTask = new Set();

  for (const line of transcript.split("\n")) {
    if (line.trim() === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (part?.type === "tool_use") {
        const tool = taskTool(part.name);
        if (tool === undefined) continue;
        const id = toId(part.input?.taskId);
        if (id !== undefined) ids.add(id);
        if (tool === "task_next" || tool === "task_create") answersWithTask.add(part.id);
      } else if (part?.type === "tool_result" && answersWithTask.has(part.tool_use_id)) {
        const id = toId(/TASK-\d+/.exec(textOf(part.content))?.[0]);
        if (id !== undefined) ids.add(id);
      }
    }
  }
  return ids;
};
