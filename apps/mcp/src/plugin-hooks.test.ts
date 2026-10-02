import { describe, expect, it } from "vitest";

/**
 * The Claude Code plugin's hooks are dependency-free `.mjs` with no workspace of
 * their own; their testable logic is tested from here. The SessionEnd hook
 * releases only the tasks *this* session touched (two sessions in one checkout
 * share an actor), so the transcript reading is what must be right.
 */

type TranscriptModule = { touchedTaskIds: (transcript: string) => Set<number> };
const { touchedTaskIds } = (await import(
  new URL("../../../integrations/claude-code/scripts/transcript.mjs", import.meta.url).href
)) as TranscriptModule;

const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
  });

const toolResult = (id: string, text: string) =>
  JSON.stringify({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }],
    },
  });

const TOOL = "mcp__plugin_estuary_tasks__";

describe("touchedTaskIds", () => {
  it("collects the taskId of every task tool call, in any of its spellings", () => {
    const transcript = [
      toolUse("a", `${TOOL}task_claim`, { taskId: 42 }),
      toolUse("b", `${TOOL}task_heartbeat`, { taskId: "TASK-000043" }),
      toolUse("c", "mcp__tasks__task_comment", { taskId: "#44", body: "x" }),
    ].join("\n");
    expect([...touchedTaskIds(transcript)]).toEqual([42, 43, 44]);
  });

  it("reads the task task_next and task_create answered with", () => {
    const transcript = [
      toolUse("n", `${TOOL}task_next`, {}),
      toolResult("n", "Claimed.\nTASK-000007 [in_progress] Fix it · high · v3"),
      toolUse("c", `${TOOL}task_create`, { title: "New", description: "Something new" }),
      toolResult("c", "Created TASK-000008.\nTASK-000008 [todo] New · medium · v1"),
    ].join("\n");
    expect([...touchedTaskIds(transcript)]).toEqual([7, 8]);
  });

  it("ignores other tools, other results, and unparseable lines", () => {
    const transcript = [
      "not json",
      "",
      toolUse("r", "Read", { taskId: 99 }),
      toolUse("l", `${TOOL}task_list`, { q: "TASK-000050" }),
      toolResult("l", "TASK-000050 [todo] Listed, not worked"),
      JSON.stringify({ type: "summary", summary: "TASK-000051" }),
    ].join("\n");
    expect(touchedTaskIds(transcript).size).toBe(0);
  });
});
