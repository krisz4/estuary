import { type FloorEdge, type FloorTask } from "@helpdesk/contracts";
import { describe, expect, it } from "vitest";
import {
  ALL_FLOOR_STATUSES,
  MAP_REGIONS,
  MAP_STATIONS,
  UNCONNECTED_GROUP_KEY,
  beadColorIndex,
  beadRadius,
  buildBlockedChains,
  buildMapLayout,
  compareFloorTasks,
  computeDefaultBeltsMode,
  computeDensityScale,
  computeMaxPerCluster,
  computeViewportScale,
  dependencyClosureOf,
  countWorkingAgents,
  isMustShowCrate,
  isValidDropTarget,
  isStaleTask,
  isWorkingTask,
  projectColorIndex,
  sortedProjectKeys,
} from "@/features/floor/layout";

let nextId = 1;

const task = (overrides: Partial<FloorTask> = {}): FloorTask => {
  const id = overrides.id ?? nextId++;
  return {
    id,
    reference: `TASK-${String(id).padStart(6, "0")}`,
    title: overrides.title ?? `Task ${id}`,
    status: overrides.status ?? "backlog",
    statusNote: overrides.statusNote ?? null,
    priority: overrides.priority ?? "medium",
    project: overrides.project === undefined ? "helpdesk" : overrides.project,
    assignee: overrides.assignee ?? null,
    labels: overrides.labels ?? [],
    parentId: overrides.parentId ?? null,
    childCount: overrides.childCount ?? 0,
    createdBy: overrides.createdBy ?? "human:krisz",
    claim: overrides.claim ?? null,
    pullRequestUrl: overrides.pullRequestUrl ?? null,
    version: overrides.version ?? 1,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    completedAt: overrides.completedAt ?? null,
    openBlockerCount: overrides.openBlockerCount ?? 0,
    unblocksCount: overrides.unblocksCount ?? 0,
    matches: overrides.matches ?? true,
  };
};

const edge = (blockerId: number, dependentId: number, satisfied = false): FloorEdge => ({
  blockerId,
  dependentId,
  satisfied,
});

const baseInput = {
  group: "project" as const,
  match: "dim" as const,
  hasActiveFilters: false,
  olderClosedCount: 0,
  edges: [] as FloorEdge[],
  refs: [],
  maxPerCluster: 30,
};

describe("MAP_REGIONS / MAP_STATIONS", () => {
  it("partitions every status into exactly one region, in TASK_STATUSES order", () => {
    const flattened = MAP_REGIONS.flatMap((region) => region.statuses);
    expect(flattened.slice().sort()).toEqual([...ALL_FLOOR_STATUSES].sort());
    expect(MAP_STATIONS).toEqual(flattened);
  });

  it("puts needs_qa in DOING (the reach), not WAITING", () => {
    const doing = MAP_REGIONS.find((region) => region.key === "doing");
    expect(doing?.statuses).toContain("needs_qa");
    const waiting = MAP_REGIONS.find((region) => region.key === "waiting");
    expect(waiting?.statuses).not.toContain("needs_qa");
  });
});

describe("isMustShowCrate", () => {
  const ctx = { hasActiveFilters: false };

  it("is must-show for every human-attention status, in_progress, blocked, and urgent", () => {
    for (const status of ["needs_user_decision", "needs_user_action", "needs_qa"] as const) {
      expect(isMustShowCrate(task({ status }), ctx)).toBe(true);
    }
    expect(isMustShowCrate(task({ status: "in_progress" }), ctx)).toBe(true);
    expect(isMustShowCrate(task({ status: "blocked" }), ctx)).toBe(true);
    expect(isMustShowCrate(task({ priority: "urgent" }), ctx)).toBe(true);
  });

  it("is not must-show for a quiet backlog task", () => {
    expect(isMustShowCrate(task({ status: "backlog", priority: "low" }), ctx)).toBe(false);
  });

  it("does not treat every task as must-show just because matches=true with no active filter", () => {
    expect(isMustShowCrate(task({ matches: true }), { hasActiveFilters: false })).toBe(false);
  });

  it("is must-show when a filter is active and the task matches it, or it is selected / an edge neighbour", () => {
    expect(isMustShowCrate(task({ matches: true }), { hasActiveFilters: true })).toBe(true);
    expect(isMustShowCrate(task({ matches: false }), { hasActiveFilters: true })).toBe(false);
    const selected = task({ id: 99 });
    expect(isMustShowCrate(selected, { hasActiveFilters: false, selectedTaskId: 99 })).toBe(true);
    const neighbor = task({ id: 5 });
    expect(isMustShowCrate(neighbor, { hasActiveFilters: false, edgeNeighborIds: new Set([5]) })).toBe(true);
  });
});

describe("compareFloorTasks / isStaleTask / isWorkingTask", () => {
  it("puts human-attention tasks first, ordered by age", () => {
    const attention = task({ status: "needs_user_decision" });
    const busy = task({ status: "in_progress", priority: "urgent" });
    expect(compareFloorTasks(attention, busy)).toBeLessThan(0);
    const older = task({ status: "needs_qa", updatedAt: "2026-01-01T00:00:00.000Z" });
    const newer = task({ status: "needs_qa", updatedAt: "2026-01-02T00:00:00.000Z" });
    expect(compareFloorTasks(older, newer)).toBeLessThan(0);
  });

  it("is stale when untouched for more than 7 days and not closed", () => {
    const now = new Date("2026-02-01T00:00:00.000Z").getTime();
    expect(isStaleTask(task({ updatedAt: "2026-01-01T00:00:00.000Z" }), now)).toBe(true);
    expect(isStaleTask(task({ updatedAt: "2026-01-30T00:00:00.000Z" }), now)).toBe(false);
    expect(isStaleTask(task({ status: "done", updatedAt: "2026-01-01T00:00:00.000Z" }), now)).toBe(false);
  });

  it("is working only for in_progress with a live claim", () => {
    expect(isWorkingTask(task({ status: "in_progress", claim: null }))).toBe(false);
    expect(
      isWorkingTask(
        task({ status: "in_progress", claim: { actor: "agent:claude-code", expiresAt: "2026-01-01T00:00:00.000Z" } }),
      ),
    ).toBe(true);
  });
});

describe("dependencyClosureOf", () => {
  it("includes the selected task and everything reachable in either direction, excluding other components", () => {
    const closure = dependencyClosureOf(2, [edge(1, 2), edge(2, 3), edge(4, 2)]);
    expect([...closure].sort()).toEqual([1, 2, 3, 4]);
    const isolated = dependencyClosureOf(1, [edge(1, 2), edge(10, 11)]);
    expect(isolated.has(10)).toBe(false);
  });
});

describe("computeDefaultBeltsMode", () => {
  it("is 'project' with every-project scope, 'epic' for one project with parents, 'none' otherwise", () => {
    expect(computeDefaultBeltsMode([], [task()])).toBe("project");
    expect(computeDefaultBeltsMode(["helpdesk"], [task({ parentId: 1 })])).toBe("epic");
    expect(computeDefaultBeltsMode(["helpdesk"], [task({ childCount: 2 })])).toBe("epic");
    expect(computeDefaultBeltsMode(["helpdesk"], [task()])).toBe("none");
  });
});

describe("sortedProjectKeys / projectColorIndex / beadColorIndex", () => {
  it("sorts distinct projects alphabetically, dropping nulls", () => {
    const tasks = [task({ project: "billing" }), task({ project: null }), task({ project: "acme" })];
    expect(sortedProjectKeys(tasks)).toEqual(["acme", "billing"]);
  });

  it("assigns a stable index by sorted position, null for no project, no collisions up to palette size", () => {
    const order = ["acme", "billing", "helpdesk"];
    expect(projectColorIndex("acme", order)).toBe(0);
    expect(projectColorIndex("helpdesk", order)).toBe(2);
    expect(projectColorIndex(null, order)).toBeNull();
  });

  it("colours by project order when group=project, by group sector otherwise", () => {
    const t = task({ project: "helpdesk" });
    expect(beadColorIndex(t, "helpdesk", 3, "project", ["billing", "helpdesk"])).toBe(1);
    expect(beadColorIndex(t, "some-label", 3, "label", ["billing", "helpdesk"])).toBe(3);
  });
});

describe("density / sizing helpers", () => {
  it("computeViewportScale clamps and flattens below the horizontal breakpoint", () => {
    expect(computeViewportScale(880, true)).toBeCloseTo(1);
    expect(computeViewportScale(200, true)).toBe(0.95);
    expect(computeViewportScale(4000, true)).toBe(1.4);
    // Vertical mode's beads are a bit smaller than the old flat 0.95 — a
    // phone-legibility fix (round-3 QA): fewer, calmer beads in a narrow
    // column reads better than the horizontal river's own scale.
    expect(computeViewportScale(300, false)).toBe(0.8);
  });

  it("computeDensityScale is 1 for a small map, shrinks to a floor for a busy one", () => {
    expect(computeDensityScale(5)).toBe(1);
    expect(computeDensityScale(20)).toBe(1);
    expect(computeDensityScale(400)).toBeCloseTo(0.55);
    expect(computeDensityScale(2000)).toBeCloseTo(0.55);
    const mid = computeDensityScale(210);
    expect(mid).toBeGreaterThan(0.55);
    expect(mid).toBeLessThan(1);
  });

  it("beadRadius scales priority by both factors", () => {
    expect(beadRadius("urgent", 1, 1)).toBeCloseTo(8.2);
    expect(beadRadius("urgent", 1, 0.5)).toBeCloseTo(4.1);
  });

  it("computeMaxPerCluster never drops below the floor of 6", () => {
    expect(computeMaxPerCluster(1.4, 1)).toBeGreaterThanOrEqual(6);
    expect(computeMaxPerCluster(0.95, 0.55)).toBeGreaterThanOrEqual(6);
  });
});

describe("buildMapLayout — grouping", () => {
  it("groups by project", () => {
    const tasks = [task({ project: "helpdesk", status: "todo" }), task({ project: "billing", status: "todo" })];
    const layout = buildMapLayout({ ...baseInput, tasks });
    const keys = layout.clusters.todo.beads.map((b) => b.groupKey).sort();
    expect(keys).toEqual(["billing", "helpdesk"]);
  });

  it("collapses into one group with group=none", () => {
    const tasks = [task({ project: "helpdesk", status: "todo" }), task({ project: "billing", status: "todo" })];
    const layout = buildMapLayout({ ...baseInput, group: "none", tasks });
    expect(new Set(layout.clusters.todo.beads.map((b) => b.groupKey)).size).toBe(1);
  });

  it("groups by parent with group=epic, labelling by the parent's title when known", () => {
    const parent = task({ id: 1, title: "Parent epic", status: "todo" });
    const child = task({ id: 2, parentId: 1, status: "todo" });
    const layout = buildMapLayout({ ...baseInput, group: "epic", tasks: [parent, child] });
    const group = layout.groups.find((g) => g.key === "parent-1");
    expect(group?.label).toContain("Parent epic");
  });

  it("groups by connected component with group=chain, singletons folded as Unconnected", () => {
    const a = task({ id: 1, status: "todo" });
    const b = task({ id: 2, status: "todo" });
    const lonely = task({ id: 3, status: "todo" });
    const layout = buildMapLayout({
      ...baseInput,
      group: "chain",
      tasks: [a, b, lonely],
      edges: [edge(1, 2)],
    });
    const groupsAt = new Set(layout.clusters.todo.beads.map((bead) => bead.groupKey));
    expect(groupsAt.has("chain-0")).toBe(true);
    expect(groupsAt.has(UNCONNECTED_GROUP_KEY)).toBe(true);
  });
});

describe("buildMapLayout — beads and shoals", () => {
  it("shows every task individually under the cluster cap", () => {
    const tasks = [task({ status: "todo" }), task({ status: "todo" })];
    const layout = buildMapLayout({ ...baseInput, tasks, maxPerCluster: 30 });
    expect(layout.clusters.todo.beads).toHaveLength(2);
    expect(layout.clusters.todo.shoal).toBeNull();
  });

  it("always shows must-show beads individually and shoals the rest past the cap", () => {
    const tasks = [
      task({ status: "backlog", priority: "urgent" }),
      ...Array.from({ length: 10 }, () => task({ status: "backlog", priority: "low" })),
    ];
    const layout = buildMapLayout({ ...baseInput, tasks, maxPerCluster: 3 });
    const cluster = layout.clusters.backlog;
    expect(cluster.beads.some((b) => b.task.priority === "urgent")).toBe(true);
    expect(cluster.shoal).not.toBeNull();
    expect((cluster.shoal?.count ?? 0) + cluster.beads.length).toBe(11);
  });

  it("never produces more than one shoal per cluster", () => {
    const tasks = Array.from({ length: 50 }, () => task({ status: "done", priority: "low" }));
    const layout = buildMapLayout({ ...baseInput, tasks, maxPerCluster: 5 });
    expect(layout.clusters.done.shoal).not.toBeNull();
  });

  it("in hide mode, a non-matching task is neither a bead nor part of the shoal, but still counted", () => {
    const tasks = [task({ status: "todo", matches: true }), task({ status: "todo", matches: false })];
    const layout = buildMapLayout({ ...baseInput, match: "hide", tasks, hasActiveFilters: true });
    expect(layout.clusters.todo.beads).toHaveLength(1);
    expect(layout.clusters.todo.totalCount).toBe(2);
    expect(layout.clusters.todo.matchCount).toBe(1);
  });

  it("in dim mode, a non-matching task is still a bead, but flagged dimmed", () => {
    const tasks = [task({ status: "todo", matches: false })];
    const layout = buildMapLayout({ ...baseInput, match: "dim", tasks, hasActiveFilters: true });
    expect(layout.clusters.todo.beads[0]?.dimmed).toBe(true);
  });

  it("marks everything outside a selection's dependency closure as untraced", () => {
    const a = task({ id: 1, status: "todo" });
    const b = task({ id: 2, status: "todo" });
    const unrelated = task({ id: 3, status: "todo" });
    const layout = buildMapLayout({
      ...baseInput,
      group: "none",
      tasks: [a, b, unrelated],
      edges: [edge(1, 2)],
      selectedTaskId: 1,
    });
    const byId = new Map(layout.clusters.todo.beads.map((bead) => [bead.task.id, bead]));
    expect(byId.get(1)?.traced).toBe(true);
    expect(byId.get(2)?.traced).toBe(true);
    expect(byId.get(3)?.traced).toBe(false);
  });

  it("assigns a sequential, zero-based order to shown beads for the phyllotaxis radius", () => {
    const tasks = [task({ status: "todo" }), task({ status: "todo" }), task({ status: "todo" })];
    const layout = buildMapLayout({ ...baseInput, tasks });
    const orders = layout.clusters.todo.beads.map((b) => b.order).sort();
    expect(orders).toEqual([0, 1, 2]);
  });
});

describe("buildMapLayout — taskPosition, ghost beads, and the Logbook pile", () => {
  it("locates every shown task, including one folded into a shoal", () => {
    const tasks = [
      task({ id: 1, status: "backlog", priority: "urgent" }),
      ...Array.from({ length: 10 }, () => task({ status: "backlog", priority: "low" })),
    ];
    const layout = buildMapLayout({ ...baseInput, tasks, maxPerCluster: 3 });
    expect(layout.taskPosition.get(1)?.inShoal).toBe(false);
    const shoaledId = layout.clusters.backlog.shoal?.taskIds[0];
    expect(shoaledId).toBeDefined();
    expect(layout.taskPosition.get(shoaledId ?? -1)?.inShoal).toBe(true);
  });

  it("produces one flat, deduplicated ghost bead per off-scope ref", () => {
    const inScope = task({ id: 1, status: "blocked", project: "helpdesk" });
    const layout = buildMapLayout({
      ...baseInput,
      tasks: [inScope],
      edges: [edge(99, 1)],
      refs: [{ id: 99, reference: "TASK-000099", title: "Off-scope blocker", status: "todo", project: "mobile-app" }],
    });
    expect(layout.ghostBeads).toHaveLength(1);
    expect(layout.ghostBeads[0]?.direction).toBe("blocker");
    expect(layout.ghostBeads[0]?.ref.id).toBe(99);
  });

  it("carries the older-closed count as one snapshot-wide pile, null when zero", () => {
    expect(buildMapLayout({ ...baseInput, tasks: [], olderClosedCount: 212 }).olderClosedPile).toEqual({
      count: 212,
    });
    expect(buildMapLayout({ ...baseInput, tasks: [], olderClosedCount: 0 }).olderClosedPile).toBeNull();
  });
});

describe("buildBlockedChains", () => {
  it("skips components with no unsatisfied edge", () => {
    const a = task({ id: 1, status: "done" });
    const b = task({ id: 2, status: "todo" });
    const chains = buildBlockedChains([a, b], [edge(1, 2, true)]);
    expect(chains).toHaveLength(0);
  });

  it("skips single-task components (nothing to chain)", () => {
    const a = task({ id: 1, status: "blocked" });
    const chains = buildBlockedChains([a], []);
    expect(chains).toHaveLength(0);
  });

  it("groups a chain with an open edge, and finds its bottleneck by unblocksCount", () => {
    const a = task({ id: 1, status: "in_progress", unblocksCount: 3 });
    const b = task({ id: 2, status: "blocked", unblocksCount: 0 });
    const c = task({ id: 3, status: "blocked", unblocksCount: 0 });
    const chains = buildBlockedChains([a, b, c], [edge(1, 2, false), edge(1, 3, true)]);
    expect(chains).toHaveLength(1);
    expect(chains[0]?.nodes.map((n) => n.taskId).sort()).toEqual([1, 2, 3]);
    expect(chains[0]?.bottleneckTaskId).toBe(1);
  });

  it("returns null bottleneck when nothing in the chain unblocks anything", () => {
    const a = task({ id: 1, status: "blocked", unblocksCount: 0 });
    const b = task({ id: 2, status: "todo", unblocksCount: 0 });
    const chains = buildBlockedChains([a, b], [edge(2, 1, false)]);
    expect(chains[0]?.bottleneckTaskId).toBeNull();
  });

  it("orders chains largest first", () => {
    const a = task({ id: 1, status: "blocked" });
    const b = task({ id: 2, status: "todo" });
    const c = task({ id: 3, status: "blocked" });
    const d = task({ id: 4, status: "todo" });
    const e = task({ id: 5, status: "in_progress" });
    const chains = buildBlockedChains(
      [a, b, c, d, e],
      [edge(2, 1, false), edge(4, 3, false), edge(5, 3, true)],
    );
    expect(chains).toHaveLength(2);
    expect(chains[0]?.nodes).toHaveLength(3);
    expect(chains[1]?.nodes).toHaveLength(2);
  });

  it("ignores edges pointing outside the given task set", () => {
    const a = task({ id: 1, status: "blocked" });
    const chains = buildBlockedChains([a], [edge(99, 1, false)]);
    expect(chains).toHaveLength(0);
  });
});

describe("isValidDropTarget", () => {
  it("allows a drop on any station other than the bead's own", () => {
    expect(isValidDropTarget("todo", "in_progress")).toBe(true);
    expect(isValidDropTarget("backlog", "done")).toBe(true);
    expect(isValidDropTarget("blocked", "needs_user_decision")).toBe(true);
  });

  it("rejects dropping a bead back on its own station", () => {
    expect(isValidDropTarget("todo", "todo")).toBe(false);
  });

  it("rejects when the bead's current station is unknown", () => {
    expect(isValidDropTarget(undefined, "todo")).toBe(false);
  });
});

describe("countWorkingAgents", () => {
  const now = new Date("2026-01-01T12:00:00.000Z");

  it("counts a live agent claim", () => {
    const a = task({ id: 1, claim: { actor: "agent:claude-code", expiresAt: "2026-01-01T12:30:00.000Z" } });
    expect(countWorkingAgents([a], now)).toBe(1);
  });

  it("does not count a human's claim", () => {
    const a = task({ id: 1, claim: { actor: "human:krisz", expiresAt: "2026-01-01T12:30:00.000Z" } });
    expect(countWorkingAgents([a], now)).toBe(0);
  });

  it("does not count an expired claim — a task can be in_progress with no live claim at all", () => {
    const a = task({ id: 1, claim: { actor: "agent:claude-code", expiresAt: "2026-01-01T11:00:00.000Z" } });
    expect(countWorkingAgents([a], now)).toBe(0);
  });

  it("does not count a task with no claim", () => {
    const a = task({ id: 1, claim: null });
    expect(countWorkingAgents([a], now)).toBe(0);
  });

  it("counts the same actor holding two claims once, not twice", () => {
    const a = task({ id: 1, claim: { actor: "agent:claude-code", expiresAt: "2026-01-01T12:30:00.000Z" } });
    const b = task({ id: 2, claim: { actor: "agent:claude-code", expiresAt: "2026-01-01T12:45:00.000Z" } });
    expect(countWorkingAgents([a, b], now)).toBe(1);
  });

  it("counts two distinct agents separately", () => {
    const a = task({ id: 1, claim: { actor: "agent:claude-code", expiresAt: "2026-01-01T12:30:00.000Z" } });
    const b = task({ id: 2, claim: { actor: "agent:claude-code-ci", expiresAt: "2026-01-01T12:45:00.000Z" } });
    expect(countWorkingAgents([a, b], now)).toBe(2);
  });
});
