import { createTaskInputSchema, floorQuerySchema, transitionInputSchema } from "@estuary/contracts";
import { describe, expect, it } from "vitest";

import { prisma } from "../lib/prisma.js";
import { makeDependency, makeTask } from "../test/factories.js";
import { createTask } from "./task.service.js";
import { transitionTask } from "./task-workflow.service.js";
import { getFloorSnapshot } from "./floor.service.js";

/**
 * `GET /floor` — the service half. `docs/features/Floor_Snapshot.md`.
 *
 * Scope-vs-filter and cap-ordering cases use `makeTask` directly (no events
 * needed); replay cases go through the real `createTask` / `transitionTask`
 * services so the event trail the replay rule reads is the one production
 * writes, not a hand-built one.
 */

const HUMAN = "human:tester";

const snapshot = (raw: Record<string, unknown> = {}) =>
  getFloorSnapshot(floorQuerySchema.parse(raw));

const ids = (rows: { id: number }[]): number[] => rows.map((r) => r.id);

describe("scope vs filters", () => {
  it("project removes rows entirely — it is scope, not a filter", async () => {
    const inScope = await makeTask({ project: "estuary", status: "todo" });
    await makeTask({ project: "billing", status: "todo" });

    const result = await snapshot({ project: "estuary" });

    expect(ids(result.tasks)).toEqual([inScope.id]);
    expect(result.meta.total).toBe(1);
  });

  it("every other filter marks matches instead of removing the row", async () => {
    const matching = await makeTask({ status: "todo", priority: "urgent" });
    const other = await makeTask({ status: "todo", priority: "low" });

    const result = await snapshot({ priority: "urgent" });

    expect(ids(result.tasks).sort()).toEqual([matching.id, other.id].sort());
    const byId = new Map(result.tasks.map((t) => [t.id, t]));
    expect(byId.get(matching.id)?.matches).toBe(true);
    expect(byId.get(other.id)?.matches).toBe(false);
    expect(result.meta.matchCount).toBe(1);
  });

  it("matches is true for every row when no filter is active", async () => {
    await makeTask({ status: "todo" });
    const result = await snapshot();
    expect(result.tasks.every((t) => t.matches)).toBe(true);
  });
});

describe("the shipped window", () => {
  it("keeps a closed task inside the 24h window and drops an older one to olderClosedCount", async () => {
    const recent = await makeTask({
      status: "done",
      completedAt: new Date(Date.now() - 60 * 60 * 1000), // 1h ago
    });
    await makeTask({
      status: "done",
      completedAt: new Date(Date.now() - 48 * 60 * 60 * 1000), // 2 days ago
    });

    const result = await snapshot({ shipped: "24h" });

    expect(ids(result.tasks)).toEqual([recent.id]);
    expect(result.meta.olderClosedCount).toBe(1);
    expect(result.meta.total).toBe(2);
  });

  it("7d reaches further back than 24h", async () => {
    const task = await makeTask({
      status: "deferred",
      completedAt: null,
      updatedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 days ago
    });

    expect(ids((await snapshot({ shipped: "24h" })).tasks)).toEqual([]);
    expect(ids((await snapshot({ shipped: "7d" })).tasks)).toEqual([task.id]);
  });

  it("never-open (open-lane) tasks are always included regardless of age", async () => {
    const old = await makeTask({
      status: "backlog",
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    expect(ids((await snapshot()).tasks)).toContain(old.id);
  });
});

describe("meta.statusCounts", () => {
  it("counts every status in scope, all ten keys present", async () => {
    await makeTask({ status: "todo" });
    await makeTask({ status: "blocked" });
    await makeTask({ status: "done", completedAt: new Date() });

    const result = await snapshot();
    expect(result.meta.statusCounts.todo).toBe(1);
    expect(result.meta.statusCounts.blocked).toBe(1);
    expect(result.meta.statusCounts.done).toBe(1);
    expect(result.meta.statusCounts.backlog).toBe(0);
    expect(Object.keys(result.meta.statusCounts)).toHaveLength(10);
  });
});

describe("the cap and its ordering", () => {
  it("puts must-show (blocked, in_progress, needs-attention, urgent) ahead of ordinary tasks", async () => {
    const ordinary = await makeTask({ status: "todo", priority: "low" });
    const blocked = await makeTask({ status: "blocked", priority: "low" });
    await makeDependency(blocked.id, ordinary.id); // give it a real open blocker

    const result = await snapshot();
    const order = ids(result.tasks);
    expect(order.indexOf(blocked.id)).toBeLessThan(order.indexOf(ordinary.id));
  });

  it("orders by priority, then updatedAt desc, within the same must-show bucket", async () => {
    const low = await makeTask({
      status: "todo",
      priority: "low",
      updatedAt: new Date(2026, 0, 1),
    });
    const high = await makeTask({
      status: "todo",
      priority: "high",
      updatedAt: new Date(2026, 0, 1),
    });
    const newerLow = await makeTask({
      status: "todo",
      priority: "low",
      updatedAt: new Date(2026, 0, 5),
    });

    const result = await snapshot();
    const order = ids(result.tasks);
    expect(order.indexOf(high.id)).toBeLessThan(order.indexOf(newerLow.id));
    expect(order.indexOf(newerLow.id)).toBeLessThan(order.indexOf(low.id));
  });
});

describe("dependency graph", () => {
  it("openBlockerCount counts only unfinished dependencies", async () => {
    const doneBlocker = await makeTask({ status: "done", completedAt: new Date() });
    const openBlocker = await makeTask({ status: "todo" });
    const dependent = await makeTask({ status: "blocked" });
    await makeDependency(dependent.id, doneBlocker.id);
    await makeDependency(dependent.id, openBlocker.id);

    const result = await snapshot();
    const row = result.tasks.find((t) => t.id === dependent.id)!;
    expect(row.openBlockerCount).toBe(1);
  });

  it("unblocksCount counts distinct open tasks transitively downstream", async () => {
    // root <- mid <- leaf  (leaf depends on mid, mid depends on root)
    const root = await makeTask({ status: "todo" });
    const mid = await makeTask({ status: "blocked" });
    const leaf = await makeTask({ status: "blocked" });
    await makeDependency(mid.id, root.id);
    await makeDependency(leaf.id, mid.id);

    const result = await snapshot();
    const rootRow = result.tasks.find((t) => t.id === root.id)!;
    expect(rootRow.unblocksCount).toBe(2); // mid and leaf, both open
  });

  it("excludes closed tasks from unblocksCount", async () => {
    const root = await makeTask({ status: "todo" });
    const closedDependent = await makeTask({ status: "done", completedAt: new Date() });
    await makeDependency(closedDependent.id, root.id);

    const result = await snapshot();
    const rootRow = result.tasks.find((t) => t.id === root.id)!;
    expect(rootRow.unblocksCount).toBe(0);
  });

  it("edges touching a returned task are included, satisfied only when the blocker is done", async () => {
    const doneBlocker = await makeTask({ status: "done", completedAt: new Date() });
    const dependent = await makeTask({ status: "blocked" });
    await makeDependency(dependent.id, doneBlocker.id);

    const result = await snapshot();
    expect(result.edges).toContainEqual({
      blockerId: doneBlocker.id,
      dependentId: dependent.id,
      satisfied: true,
    });
  });

  it("refs cover edge endpoints and parents outside the returned scope", async () => {
    const outOfScopeBlocker = await makeTask({
      project: "billing",
      status: "done",
      completedAt: new Date(),
    });
    const dependent = await makeTask({ project: "estuary", status: "blocked" });
    await makeDependency(dependent.id, outOfScopeBlocker.id);

    const result = await snapshot({ project: "estuary" });

    expect(ids(result.tasks)).toEqual([dependent.id]);
    expect(result.refs.map((r) => r.id)).toContain(outOfScopeBlocker.id);
  });

  it("refs cover a parentId outside the returned scope", async () => {
    const parent = await makeTask({ project: "billing" });
    const child = await makeTask({ project: "estuary", parentId: parent.id });

    const result = await snapshot({ project: "estuary" });

    expect(ids(result.tasks)).toEqual([child.id]);
    expect(result.refs.map((r) => r.id)).toContain(parent.id);
  });
});

describe("pullRequestUrl", () => {
  it("picks the first GitHub pull link", async () => {
    const task = await makeTask({
      status: "todo",
      links: [
        { label: "issue", url: "https://github.com/acme/repo/issues/3" },
        { label: "pr", url: "https://github.com/acme/repo/pull/9" },
      ],
    });

    const result = await snapshot();
    expect(result.tasks.find((t) => t.id === task.id)?.pullRequestUrl).toBe(
      "https://github.com/acme/repo/pull/9",
    );
  });

  it("is null when there is no pull link", async () => {
    const task = await makeTask({ status: "todo" });
    const result = await snapshot();
    expect(result.tasks.find((t) => t.id === task.id)?.pullRequestUrl).toBeNull();
  });
});

describe("meta.lastEventId", () => {
  it("is the highest TaskEvent id at snapshot time", async () => {
    await createTask(
      createTaskInputSchema.parse({
        title: "Add retries to the sender",
        description: "Long enough.",
      }),
      HUMAN,
    );
    const maxId = await prisma.taskEvent.findFirst({
      orderBy: { id: "desc" },
      select: { id: true },
    });

    const result = await snapshot();
    expect(result.meta.lastEventId).toBe(maxId?.id ?? 0);
  });

  it("is 0 when nothing ever happened", async () => {
    const result = await snapshot();
    expect(result.meta.lastEventId).toBe(0);
  });
});

describe("replay (?at=)", () => {
  it("reports the status a task had at T, not its current one", async () => {
    const { task } = await createTask(
      createTaskInputSchema.parse({
        title: "Ship the retry logic",
        description: "Long enough description for the schema.",
        status: "todo",
        acceptanceCriteria: "Retries three times with backoff.",
      }),
      HUMAN,
    );

    const afterCreate = new Date();
    await new Promise((r) => setTimeout(r, 5));

    await transitionTask(task.id, transitionInputSchema.parse({ to: "in_progress" }), HUMAN);
    await new Promise((r) => setTimeout(r, 5));
    const afterInProgress = new Date();
    await new Promise((r) => setTimeout(r, 5));

    await transitionTask(
      task.id,
      transitionInputSchema.parse({ to: "needs_qa", summary: "Done" }),
      HUMAN,
    );

    const atCreate = await snapshot({ at: afterCreate.toISOString() });
    expect(atCreate.tasks.find((t) => t.id === task.id)?.status).toBe("todo");

    const atInProgress = await snapshot({ at: afterInProgress.toISOString() });
    expect(atInProgress.tasks.find((t) => t.id === task.id)?.status).toBe("in_progress");

    const live = await snapshot();
    expect(live.tasks.find((t) => t.id === task.id)?.status).toBe("needs_qa");
  });

  it("excludes a task created after T", async () => {
    const before = new Date();
    await new Promise((r) => setTimeout(r, 5));
    await createTask(
      createTaskInputSchema.parse({
        title: "Created later",
        description: "Long enough description.",
      }),
      HUMAN,
    );

    const result = await snapshot({ at: before.toISOString() });
    expect(result.tasks).toEqual([]);
    expect(result.meta.total).toBe(0);
  });

  it("claims are always null under replay", async () => {
    const task = await makeTask({ status: "in_progress", claimedBy: "agent:a" });
    const result = await snapshot({ at: new Date().toISOString() });
    expect(result.tasks.find((t) => t.id === task.id)?.claim).toBeNull();
  });

  it("echoes at in meta and null on the live floor", async () => {
    const at = new Date().toISOString();
    expect((await snapshot({ at })).meta.at).toBe(at);
    expect((await snapshot()).meta.at).toBeNull();
  });
});
