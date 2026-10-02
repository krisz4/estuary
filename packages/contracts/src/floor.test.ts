import { describe, expect, it } from "vitest";
import {
  DEFAULT_FLOOR_SHIPPED_WINDOW,
  FLOOR_FILTER_KEYS,
  FLOOR_TASK_CAP,
  floorQuerySchema,
  floorSnapshotSchema,
} from "./floor.js";
import { taskFilterFields } from "./task-query.js";

const task = {
  id: 42,
  reference: "TASK-000042",
  title: "Add retries to the sender",
  status: "in_progress",
  statusNote: null,
  priority: "high",
  project: "estuary",
  assignee: "agent:claude-code",
  labels: ["api"],
  parentId: null,
  childCount: 0,
  createdBy: "agent:claude-code",
  claim: { actor: "agent:claude-code", expiresAt: "2026-09-20T10:30:00.000Z" },
  pullRequestUrl: null,
  version: 3,
  createdAt: "2026-09-20T09:00:00.000Z",
  updatedAt: "2026-09-20T10:00:00.000Z",
  completedAt: null,
  openBlockerCount: 0,
  unblocksCount: 0,
  matches: true,
};

const meta = {
  total: 1,
  truncated: false,
  olderClosedCount: 0,
  statusCounts: {
    backlog: 0,
    needs_refinement: 0,
    todo: 0,
    in_progress: 1,
    blocked: 0,
    needs_user_decision: 0,
    needs_user_action: 0,
    needs_qa: 0,
    done: 0,
    deferred: 0,
  },
  matchCount: 1,
  shippedSince: "2026-09-19T10:00:00.000Z",
  at: null,
  lastEventId: 101,
  generatedAt: "2026-09-20T10:05:00.000Z",
};

describe("floorQuerySchema", () => {
  it("defaults shipped to 24h and leaves everything else absent", () => {
    expect(floorQuerySchema.parse({})).toEqual({ shipped: DEFAULT_FLOOR_SHIPPED_WINDOW });
  });

  it("accepts the task filter fields, same as the list query", () => {
    const parsed = floorQuerySchema.parse({
      status: "blocked",
      priority: "urgent",
      project: "estuary",
    });
    expect(parsed.status).toEqual(["blocked"]);
    expect(parsed.priority).toEqual(["urgent"]);
    expect(parsed.project).toEqual(["estuary"]);
  });

  it("accepts shipped=7d", () => {
    expect(floorQuerySchema.parse({ shipped: "7d" }).shipped).toBe("7d");
  });

  it("rejects an unknown shipped window", () => {
    expect(floorQuerySchema.safeParse({ shipped: "30d" }).success).toBe(false);
  });

  it("accepts at as an offset datetime and rejects a date-only value", () => {
    expect(floorQuerySchema.parse({ at: "2026-09-20T10:00:00Z" }).at).toBe("2026-09-20T10:00:00Z");
    expect(floorQuerySchema.safeParse({ at: "2026-09-20" }).success).toBe(false);
  });

  it("rejects assignee together with assigneeIsNull — the shared refinement runs here too", () => {
    const result = floorQuerySchema.safeParse({ assignee: "Priya", assigneeIsNull: "true" });
    expect(result.success).toBe(false);
  });

  it("rejects page/pageSize/sort — the floor has no paging", () => {
    expect(floorQuerySchema.safeParse({ page: "2" }).success).toBe(false);
    expect(floorQuerySchema.safeParse({ sort: "priority:desc" }).success).toBe(false);
  });

  it("rejects an unknown parameter", () => {
    expect(floorQuerySchema.safeParse({ belts: "chain" }).success).toBe(false);
  });
});

describe("FLOOR_FILTER_KEYS", () => {
  it("excludes project — scope, not a filter", () => {
    expect(FLOOR_FILTER_KEYS).not.toContain("project");
  });

  it("is exactly the shared task filter fields, minus project", () => {
    const expected = Object.keys(taskFilterFields)
      .filter((key) => key !== "project")
      .sort();
    expect([...FLOOR_FILTER_KEYS].sort()).toEqual(expected);
  });
});

describe("floorSnapshotSchema", () => {
  it("accepts a well-formed snapshot", () => {
    const snapshot = { tasks: [task], edges: [], refs: [], meta };
    expect(floorSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("accepts edges and refs", () => {
    const snapshot = {
      tasks: [task],
      edges: [{ blockerId: 7, dependentId: 42, satisfied: false }],
      refs: [
        {
          id: 7,
          reference: "TASK-000007",
          title: "Upstream work",
          status: "todo",
          project: "estuary",
        },
      ],
      meta,
    };
    expect(floorSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("requires every statusCounts key", () => {
    const { done: _done, ...incomplete } = meta.statusCounts;
    const snapshot = {
      tasks: [],
      edges: [],
      refs: [],
      meta: { ...meta, statusCounts: incomplete },
    };
    expect(floorSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects an extra field on a task row", () => {
    const snapshot = { tasks: [{ ...task, belt: "estuary" }], edges: [], refs: [], meta };
    expect(floorSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });
});

describe("FLOOR_TASK_CAP", () => {
  it("is a positive integer", () => {
    expect(Number.isInteger(FLOOR_TASK_CAP)).toBe(true);
    expect(FLOOR_TASK_CAP).toBeGreaterThan(0);
  });
});
