import {
  attentionKindOf,
  createTaskInputSchema,
  nextTaskInputSchema,
  releaseTaskInputSchema,
  taskListQuerySchema,
  transitionInputSchema,
  updateTaskInputSchema,
  type TransitionInputRaw,
} from "@estuary/contracts";
import { describe, expect, it } from "vitest";

import { prisma } from "../lib/prisma.js";
import { makeDependency, makeTask } from "../test/factories.js";
import { listTasks } from "./task-query.js";
import { createTask, getTask, getTaskStats, updateTask } from "./task.service.js";
import { claimTask, nextTask, releaseTask, transitionTask } from "./task-workflow.service.js";

/**
 * The attention queue: what `GET /tasks?attention=true` selects, the
 * `needsTriage` flag's lifecycle, `concerns` on a QA hand-off, and follow-ups
 * filed from a hand-off. See `docs/features/Attention_Queue.md`.
 */

const HUMAN = "human:krisz";
const AGENT = "agent:claude-code";

const transition = (id: number, raw: TransitionInputRaw, actor = AGENT) =>
  transitionTask(id, transitionInputSchema.parse(raw), actor);

const attentionList = async (extra: Record<string, unknown> = {}) =>
  listTasks(taskListQuerySchema.parse({ attention: "true", pageSize: 100, ...extra }));

describe("attention filter", () => {
  it("selects exactly the rows attentionKindOf classifies, and stats count the same", async () => {
    const done = await makeTask({ status: "done" });
    const open = await makeTask({ status: "todo" });

    const expected = [
      await makeTask({ status: "needs_user_decision" }),
      await makeTask({ status: "needs_user_action" }),
      await makeTask({ status: "needs_qa" }),
      await makeTask({ status: "needs_refinement" }),
      await makeTask({ status: "todo", needsTriage: true }),
      await makeTask({ status: "backlog", needsTriage: true }),
      // Blocked on an outside reason, or on finished work only.
      await makeTask({ status: "blocked", statusNote: "Waiting on the vendor" }),
    ];
    const blockedOnDone = await makeTask({ status: "blocked" });
    await makeDependency(blockedOnDone.id, done.id);
    expected.push(blockedOnDone);

    // Not in front of a person.
    const blockedOnOpen = await makeTask({ status: "blocked" });
    await makeDependency(blockedOnOpen.id, open.id);
    await makeTask({ status: "in_progress", needsTriage: true });
    await makeTask({ status: "deferred", needsTriage: true });
    await makeTask({ status: "backlog" });

    const page = await attentionList();
    const ids = page.data.map((task) => task.id).sort((a, b) => a - b);
    expect(ids).toEqual(expected.map((task) => task.id).sort((a, b) => a - b));

    // The client's classifier agrees with the server's filter on every row.
    const all = await listTasks(taskListQuerySchema.parse({ pageSize: 100 }));
    for (const task of all.data) {
      expect(attentionKindOf(task) !== null, task.reference).toBe(ids.includes(task.id));
    }

    expect((await getTaskStats()).needsAttention).toBe(expected.length);

    const rest = await listTasks(taskListQuerySchema.parse({ attention: "false", pageSize: 100 }));
    expect(rest.meta.total).toBe(all.meta.total - expected.length);
  });
});

describe("needsTriage", () => {
  const create = (actor: string, raw: Record<string, unknown> = {}) =>
    createTask(
      createTaskInputSchema.parse({
        title: "A suggested task",
        description: "Something an agent noticed along the way.",
        ...raw,
      }),
      actor,
    );

  it("marks an agent's task, not a person's", async () => {
    expect((await create(AGENT)).task.needsTriage).toBe(true);
    expect((await create(HUMAN, { title: "Another task" })).task.needsTriage).toBe(false);
  });

  it("is cleared by a claim, so an agent's own tracked work never shows as suggested", async () => {
    const { task } = await create(AGENT, { status: "todo", acceptanceCriteria: "It works." });
    expect((await claimTask(task.id, undefined, AGENT)).needsTriage).toBe(false);
  });

  it("is cleared when task_next picks the task", async () => {
    const { task } = await create(AGENT, { status: "todo", acceptanceCriteria: "It works." });
    const picked = await nextTask(nextTaskInputSchema.parse({}), "agent:codex");
    expect(picked?.id).toBe(task.id);
    expect(picked?.needsTriage).toBe(false);
  });

  it("survives an agent's edit and transition, but not a person's", async () => {
    const { task } = await create(AGENT, { status: "needs_refinement" });

    const edited = await updateTask(
      task.id,
      updateTaskInputSchema.parse({ priority: "high" }),
      AGENT,
    );
    expect(edited.needsTriage).toBe(true);
    const refined = await transition(task.id, { to: "todo", acceptanceCriteria: "It works." });
    expect(refined.needsTriage).toBe(true);

    const seen = await updateTask(task.id, updateTaskInputSchema.parse({ priority: "low" }), HUMAN);
    expect(seen.needsTriage).toBe(false);
  });

  it("accepts an explicit needsTriage: false as the only change (the inbox's Accept)", async () => {
    const { task } = await create(AGENT);
    const accepted = await updateTask(
      task.id,
      updateTaskInputSchema.parse({ needsTriage: false }),
      HUMAN,
    );
    expect(accepted.needsTriage).toBe(false);
    expect(accepted.version).toBe(task.version + 1);
  });

  it("is cleared by dismissing (deferred), even by an agent", async () => {
    const { task } = await create(AGENT);
    const parked = await transition(task.id, { to: "deferred", reason: "Superseded" });
    expect(parked.needsTriage).toBe(false);
  });
});

describe("QA hand-off", () => {
  it("stores concerns with needs_qa and drops them on the next move", async () => {
    const task = await makeTask({ status: "in_progress", claimedBy: AGENT });

    const handed = await transition(task.id, {
      to: "needs_qa",
      summary: "Done.",
      concerns: "Skipped the migration test — no fixture for it.",
    });
    expect(handed.concerns).toBe("Skipped the migration test — no fixture for it.");

    const back = await transition(task.id, { to: "todo" }, HUMAN);
    expect(back.concerns).toBeNull();
  });

  it("leaves concerns null for a routine hand-off", async () => {
    const task = await makeTask({ status: "in_progress", claimedBy: AGENT });
    expect((await transition(task.id, { to: "needs_qa", summary: "Done." })).concerns).toBeNull();
  });
});

describe("follow-ups", () => {
  const followUps = [
    {
      title: "Add a fixture for the migration test",
      description: "The migration test was skipped for lack of a fixture.",
      acceptanceCriteria: "The migration test runs in CI.",
    },
    {
      title: "Decide whether to keep the legacy export",
      description: "Nothing calls it any more, but it is documented.",
      missing: "Is anyone outside this repo using the export?",
      priority: "low" as const,
    },
    {
      title: "Tidy the error copy",
      description: "Two messages say the same thing differently.",
    },
  ];

  it("files each as a suggested subtask: todo with criteria, otherwise needs_refinement", async () => {
    const task = await makeTask({
      status: "in_progress",
      claimedBy: AGENT,
      project: "estuary",
      labels: { create: [{ label: "web" }] },
    });

    const handed = await transition(task.id, { to: "needs_qa", summary: "Done.", followUps });
    expect(handed.children.map((child) => [child.title, child.status])).toEqual([
      ["Add a fixture for the migration test", "todo"],
      ["Decide whether to keep the legacy export", "needs_refinement"],
      ["Tidy the error copy", "needs_refinement"],
    ]);

    const [ready, question, vague] = await Promise.all(
      handed.children.map((child) => getTask(child.id)),
    );
    for (const child of [ready!, question!, vague!]) {
      expect(child).toMatchObject({
        parentId: task.id,
        project: "estuary",
        labels: ["web"],
        needsTriage: true,
        createdBy: AGENT,
      });
    }
    expect(ready!.acceptanceCriteria).toBe("The migration test runs in CI.");
    expect(question!.statusNote).toBe("Is anyone outside this repo using the export?");
    expect(question!.priority).toBe("low");
    expect(vague!.statusNote).toMatch(/say what done looks like/);

    // All three land in the attention queue — suggested and refine.
    const queued = (await attentionList()).data.map((row) => row.id);
    expect(queued).toEqual(expect.arrayContaining(handed.children.map((child) => child.id)));
  });

  it("does not file the same follow-up twice when a hand-off is retried", async () => {
    const task = await makeTask({ status: "in_progress", claimedBy: AGENT });
    await transition(task.id, { to: "needs_qa", summary: "Done.", followUps });
    await transition(task.id, { to: "in_progress" });
    const again = await transition(task.id, { to: "needs_qa", summary: "Done.", followUps });
    expect(again.children).toHaveLength(followUps.length);
  });

  it("files follow-ups from a release, so unfinished work is not lost", async () => {
    const task = await makeTask({ status: "in_progress", claimedBy: AGENT });
    const released = await releaseTask(
      task.id,
      releaseTaskInputSchema.parse({ reason: "Session ending", followUps: [followUps[0]] }),
      AGENT,
    );
    expect(released.status).toBe("todo");
    expect(released.children).toHaveLength(1);
    expect(await prisma.task.count({ where: { parentId: task.id, needsTriage: true } })).toBe(1);
  });

  it("rejects more than ten in one hand-off", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      ...followUps[2],
      title: `Follow-up ${i}`,
    }));
    const parsed = transitionInputSchema.safeParse({
      to: "needs_qa",
      summary: "x",
      followUps: many,
    });
    expect(parsed.success).toBe(false);
  });
});
