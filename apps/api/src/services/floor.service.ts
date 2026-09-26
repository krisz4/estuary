import {
  formatReference,
  HUMAN_ATTENTION_STATUSES,
  parseGithubUrl,
  parseSearchTerms,
  TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  type FloorEdge,
  type FloorQuery,
  type FloorSnapshot,
  type FloorTask,
  FLOOR_FILTER_KEYS,
  FLOOR_TASK_CAP,
  type TaskRef,
  type TaskStatus,
} from "@helpdesk/contracts";

import type { Prisma } from "@prisma/client";

import { parseLinksColumn } from "../lib/serialize.js";
import { prisma } from "../lib/prisma.js";
import { buildWhere, needsEscapedSearch, resolveTextSearch, type TaskWhereQuery } from "./task-query.js";
import { PRIORITY_RANK } from "./task-status.js";

/**
 * `GET /floor` — one compact snapshot of everything in scope, for the floor
 * view. See `docs/pages/Floor_And_Logbook_Plan.md` and
 * `docs/features/Floor_Snapshot.md` for the shape and the rules below.
 *
 * `project` is **scope**: it removes rows entirely. Every other filter param
 * only marks `matches` — the floor dims non-matching tasks in place rather than
 * moving anything.
 */

const SHIPPED_WINDOW_MS: Record<FloorQuery["shipped"], number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

/** A task is "must-show" — always drawn individually, never piled — under any of these. */
function isMustShow(status: TaskStatus, priority: string): boolean {
  return (
    (HUMAN_ATTENTION_STATUSES as readonly string[]).includes(status) ||
    status === "in_progress" ||
    status === "blocked" ||
    priority === "urgent"
  );
}

/** Sort key for the cap: must-show first, then priority desc, then updatedAt desc. */
function floorSortKey(row: {
  status: TaskStatus;
  priority: string;
  updatedAt: Date;
}): [number, number, number] {
  const mustShow = isMustShow(row.status, row.priority);
  return [
    mustShow ? 0 : 1,
    -(PRIORITY_RANK[row.priority as keyof typeof PRIORITY_RANK] ?? 0),
    -row.updatedAt.getTime(),
  ];
}

function compareSortKeys(a: [number, number, number], b: [number, number, number]): number {
  for (let index = 0; index < a.length; index += 1) {
    const diff = a[index]! - b[index]!;
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The subset of a `FloorQuery` that selects rows — everything but `project`, `shipped`, `at`. */
const pickFilterFields = (query: FloorQuery): TaskWhereQuery => ({
  status: query.status,
  priority: query.priority,
  project: undefined,
  label: query.label,
  assignee: query.assignee,
  assigneeIsNull: query.assigneeIsNull,
  createdBy: query.createdBy,
  claimedBy: query.claimedBy,
  parentId: query.parentId,
  parentIsNull: query.parentIsNull,
  dependsOn: query.dependsOn,
  dependencyOf: query.dependencyOf,
  q: query.q,
  createdFrom: query.createdFrom,
  createdTo: query.createdTo,
});

const hasActiveFilter = (query: FloorQuery): boolean =>
  FLOOR_FILTER_KEYS.some((key) => query[key] !== undefined);

/** Every id in `candidateIds` that satisfies the (non-project) filters. */
async function resolveMatchedIds(
  query: FloorQuery,
  candidateIds: number[],
): Promise<Set<number> | null> {
  if (!hasActiveFilter(query) || candidateIds.length === 0) return null;

  const filters = pickFilterFields(query);
  const escapedTerms =
    filters.q === undefined ? [] : parseSearchTerms(filters.q).filter(needsEscapedSearch);
  const termMatches = new Map(
    await Promise.all(
      escapedTerms.map(async (term): Promise<[string, number[]]> => [
        term,
        await resolveTextSearch(prisma, term),
      ]),
    ),
  );

  const where = buildWhere(filters, termMatches);
  const rows = await prisma.task.findMany({
    where: { AND: [{ id: { in: candidateIds } }, where] },
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
}

/* ------------------------------------------------------------------ *
 * Replay (`?at=`)
 * ------------------------------------------------------------------ */

interface ReplayResult {
  /** `status` at T. Absent for a task created after T (it should be excluded). */
  status: Map<number, TaskStatus>;
  /** When the task entered its replayed status — the "closedAt" the shipped window uses. */
  statusAt: Map<number, Date>;
}

/**
 * Status at T, for the given task ids, from `task.status_changed` events.
 *
 * **The rule:** a task's status at T is the `to` of its last `task.status_changed`
 * event with `createdAt <= T`. A task with no such event is at the status its
 * `task.created` event recorded (`payload.status`) if that event happened at or
 * before T; failing that (no `task.created` event at all — a row written
 * outside the normal write path, e.g. a hand-seeded fixture) it falls back to
 * the task's *current* status, which is a best effort, not a guarantee — the
 * task manager has recorded a `task.created` event for every task created
 * through the API since events existed, so this fallback is not expected to be
 * exercised in practice.
 *
 * One event query for every id in `taskIds`, not one per task.
 */
async function replayStatuses(
  taskIds: number[],
  at: Date,
  currentStatus: Map<number, TaskStatus>,
): Promise<ReplayResult> {
  const status = new Map<number, TaskStatus>();
  const statusAt = new Map<number, Date>();
  if (taskIds.length === 0) return { status, statusAt };

  const events = await prisma.taskEvent.findMany({
    where: {
      taskId: { in: taskIds },
      type: { in: ["task.status_changed", "task.created"] },
      createdAt: { lte: at },
    },
    orderBy: [{ taskId: "asc" }, { id: "asc" }],
    select: { taskId: true, type: true, payload: true, createdAt: true },
  });

  const createdStatus = new Map<number, { status: TaskStatus; at: Date }>();
  for (const event of events) {
    if (event.type === "task.created") {
      // Ascending order: keep only the first one seen per task.
      if (!createdStatus.has(event.taskId)) {
        const payload = JSON.parse(event.payload) as { status?: unknown };
        const value = payload.status;
        if (typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value)) {
          createdStatus.set(event.taskId, { status: value as TaskStatus, at: event.createdAt });
        }
      }
      continue;
    }

    // `task.status_changed`, ascending order: the last write wins, giving the
    // latest status_changed event at or before T.
    const payload = JSON.parse(event.payload) as { to?: unknown };
    const to = payload.to;
    if (typeof to === "string" && (TASK_STATUSES as readonly string[]).includes(to)) {
      status.set(event.taskId, to as TaskStatus);
      statusAt.set(event.taskId, event.createdAt);
    }
  }

  for (const taskId of taskIds) {
    if (status.has(taskId)) continue;
    const created = createdStatus.get(taskId);
    if (created !== undefined) {
      status.set(taskId, created.status);
      statusAt.set(taskId, created.at);
    } else {
      const fallback = currentStatus.get(taskId);
      if (fallback !== undefined) {
        status.set(taskId, fallback);
        statusAt.set(taskId, at);
      }
    }
  }

  return { status, statusAt };
}

/* ------------------------------------------------------------------ *
 * Dependency graph
 * ------------------------------------------------------------------ */

interface DependencyGraph {
  /** `taskId → the ids it depends on`. */
  dependsOnOf: Map<number, Set<number>>;
  /** `blockerId → the ids that depend on it` — the reverse edge, for `unblocksCount`. */
  dependentsOf: Map<number, Set<number>>;
  /** Every node id touched by an edge. */
  nodeIds: Set<number>;
}

async function loadDependencyGraph(): Promise<DependencyGraph> {
  const edges = await prisma.taskDependency.findMany({ select: { taskId: true, dependsOnId: true } });

  const dependsOnOf = new Map<number, Set<number>>();
  const dependentsOf = new Map<number, Set<number>>();
  const nodeIds = new Set<number>();

  for (const edge of edges) {
    nodeIds.add(edge.taskId);
    nodeIds.add(edge.dependsOnId);

    if (!dependsOnOf.has(edge.taskId)) dependsOnOf.set(edge.taskId, new Set());
    dependsOnOf.get(edge.taskId)!.add(edge.dependsOnId);

    if (!dependentsOf.has(edge.dependsOnId)) dependentsOf.set(edge.dependsOnId, new Set());
    dependentsOf.get(edge.dependsOnId)!.add(edge.taskId);
  }

  return { dependsOnOf, dependentsOf, nodeIds };
}

/**
 * Every non-closed task transitively downstream of `node`, memoized so the
 * whole graph is walked once regardless of how many nodes ask.
 *
 * Cycles are prevented at write time (`assertDependencyAllowed`), but this
 * still guards against one: `visiting` breaks a cycle by treating a node
 * revisited mid-walk as having no further downstream (rather than recursing
 * forever), so a corrupted graph degrades to an undercount instead of a hang.
 */
function downstreamOf(
  node: number,
  graph: DependencyGraph,
  statusOf: Map<number, TaskStatus>,
  memo: Map<number, Set<number>>,
  visiting: Set<number> = new Set(),
): Set<number> {
  const cached = memo.get(node);
  if (cached !== undefined) return cached;
  if (visiting.has(node)) return new Set();

  visiting.add(node);
  const result = new Set<number>();
  for (const dependent of graph.dependentsOf.get(node) ?? []) {
    result.add(dependent);
    for (const id of downstreamOf(dependent, graph, statusOf, memo, visiting)) result.add(id);
  }
  visiting.delete(node);
  memo.set(node, result);
  return result;
}

/* ------------------------------------------------------------------ *
 * The snapshot
 * ------------------------------------------------------------------ */

const taskSelect = {
  id: true,
  title: true,
  status: true,
  statusNote: true,
  priority: true,
  project: true,
  assignee: true,
  parentId: true,
  createdBy: true,
  links: true,
  claimedBy: true,
  claimExpiresAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  completedAt: true,
  labels: { select: { label: true }, orderBy: { label: "asc" } },
  _count: { select: { children: true } },
} satisfies Prisma.TaskSelect;

type FloorRow = Prisma.TaskGetPayload<{ select: typeof taskSelect }>;

const toTaskRef = (row: { id: number; title: string; status: string; project: string | null }): TaskRef => ({
  id: row.id,
  reference: formatReference(row.id),
  title: row.title,
  status: row.status as TaskStatus,
  project: row.project,
});

export async function getFloorSnapshot(query: FloorQuery): Promise<FloorSnapshot> {
  const generatedAt = new Date();
  const at = query.at === undefined ? null : new Date(query.at);
  const now = at ?? generatedAt;

  const scopeWhere = query.project === undefined ? {} : { project: { in: query.project } };
  const rows = await prisma.task.findMany({
    where: {
      ...scopeWhere,
      ...(at === null ? {} : { createdAt: { lte: at } }),
    },
    select: taskSelect,
  });

  const currentStatus = new Map(rows.map((row) => [row.id, row.status as TaskStatus]));

  // Replay only touches the graph nodes and the scoped rows — the two sets
  // whose status this response actually reports — not every task in the
  // database, so it stays a bounded query even when `at` is far in the past.
  const graph = await loadDependencyGraph();
  const replayIds = [...new Set([...rows.map((row) => row.id), ...graph.nodeIds])];

  const { status: replayedStatus, statusAt: replayedStatusAt } =
    at === null ? { status: currentStatus, statusAt: new Map<number, Date>() } : await replayStatuses(replayIds, at, currentStatus);

  // A task created after T never existed at T.
  const visibleRows = rows.filter((row) => at === null || replayedStatus.has(row.id));

  const statusOf = new Map<number, TaskStatus>(replayedStatus);
  // Fill in the status of graph nodes outside scope (a cross-project blocker or
  // dependent) in one query, for the live floor — replay already covered these
  // via `replayIds` above.
  if (at === null) {
    const missing = [...graph.nodeIds].filter((id) => !statusOf.has(id));
    if (missing.length > 0) {
      const external = await prisma.task.findMany({
        where: { id: { in: missing } },
        select: { id: true, status: true },
      });
      for (const row of external) statusOf.set(row.id, row.status as TaskStatus);
    }
  }

  const statusCounts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<
    TaskStatus,
    number
  >;
  for (const row of visibleRows) {
    const status = replayedStatus.get(row.id) ?? (row.status as TaskStatus);
    statusCounts[status] += 1;
  }

  const shippedSince = new Date(now.getTime() - SHIPPED_WINDOW_MS[query.shipped]);

  const openRows: FloorRow[] = [];
  const recentClosedRows: FloorRow[] = [];
  let olderClosedCount = 0;

  for (const row of visibleRows) {
    const status = replayedStatus.get(row.id) ?? (row.status as TaskStatus);
    if (!(TERMINAL_TASK_STATUSES as readonly string[]).includes(status)) {
      openRows.push(row);
      continue;
    }

    const closedAt = at === null ? (row.completedAt ?? row.updatedAt) : (replayedStatusAt.get(row.id) ?? row.updatedAt);
    if (closedAt >= shippedSince) recentClosedRows.push(row);
    else olderClosedCount += 1;
  }

  const included = [...openRows, ...recentClosedRows];
  const includedIds = included.map((row) => row.id);

  const matchedIds = await resolveMatchedIds(query, includedIds);

  included.sort((a, b) => {
    const statusA = replayedStatus.get(a.id) ?? (a.status as TaskStatus);
    const statusB = replayedStatus.get(b.id) ?? (b.status as TaskStatus);
    return compareSortKeys(
      floorSortKey({ status: statusA, priority: a.priority, updatedAt: a.updatedAt }),
      floorSortKey({ status: statusB, priority: b.priority, updatedAt: b.updatedAt }),
    );
  });

  const truncated = included.length > FLOOR_TASK_CAP;
  const capped = included.slice(0, FLOOR_TASK_CAP);
  const cappedIds = new Set(capped.map((row) => row.id));

  const memo = new Map<number, Set<number>>();

  const tasks: FloorTask[] = capped.map((row): FloorTask => {
    const status = replayedStatus.get(row.id) ?? (row.status as TaskStatus);
    const dependsOnIds = [...(graph.dependsOnOf.get(row.id) ?? [])];
    const openBlockerCount = dependsOnIds.filter((id) => statusOf.get(id) !== "done").length;
    const downstream = downstreamOf(row.id, graph, statusOf, memo);
    const unblocksCount = [...downstream].filter(
      (id) => !(TERMINAL_TASK_STATUSES as readonly string[]).includes(statusOf.get(id) ?? "done"),
    ).length;

    const links = parseLinksColumn(row.links);
    const pullRequestUrl =
      links.find((link) => parseGithubUrl(link.url)?.kind === "pull")?.url ?? null;

    const claim =
      at !== null || row.claimedBy === null || row.claimExpiresAt === null || row.claimExpiresAt <= now
        ? null
        : { actor: row.claimedBy, expiresAt: row.claimExpiresAt.toISOString() };

    return {
      id: row.id,
      reference: formatReference(row.id),
      title: row.title,
      status,
      statusNote: row.statusNote,
      priority: row.priority as FloorTask["priority"],
      project: row.project,
      assignee: row.assignee,
      labels: row.labels.map((label) => label.label),
      parentId: row.parentId,
      childCount: row._count.children,
      createdBy: row.createdBy,
      claim,
      pullRequestUrl,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      completedAt: row.completedAt === null ? null : row.completedAt.toISOString(),
      openBlockerCount,
      unblocksCount,
      matches: matchedIds === null ? true : matchedIds.has(row.id),
    };
  });

  const matchCount = tasks.filter((task) => task.matches).length;

  // Edges touching a returned task, and the ids they point at that are not
  // themselves returned — those become `refs`.
  const edges: FloorEdge[] = [];
  const refIds = new Set<number>();
  for (const [taskId, dependsOnIds] of graph.dependsOnOf) {
    for (const dependsOnId of dependsOnIds) {
      if (!cappedIds.has(taskId) && !cappedIds.has(dependsOnId)) continue;
      edges.push({
        blockerId: dependsOnId,
        dependentId: taskId,
        satisfied: statusOf.get(dependsOnId) === "done",
      });
      if (!cappedIds.has(taskId)) refIds.add(taskId);
      if (!cappedIds.has(dependsOnId)) refIds.add(dependsOnId);
    }
  }
  for (const row of capped) {
    if (row.parentId !== null && !cappedIds.has(row.parentId)) refIds.add(row.parentId);
  }

  const refRows =
    refIds.size === 0
      ? []
      : await prisma.task.findMany({
          where: { id: { in: [...refIds] } },
          select: { id: true, title: true, status: true, project: true },
        });
  const refs: TaskRef[] = refRows.map(toTaskRef);

  const lastEvent = await prisma.taskEvent.findFirst({ orderBy: { id: "desc" }, select: { id: true } });

  return {
    tasks,
    edges,
    refs,
    meta: {
      total: visibleRows.length,
      truncated,
      olderClosedCount,
      statusCounts,
      matchCount,
      shippedSince: shippedSince.toISOString(),
      at: at === null ? null : at.toISOString(),
      lastEventId: lastEvent?.id ?? 0,
      generatedAt: generatedAt.toISOString(),
    },
  };
}
