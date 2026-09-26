import {
  HUMAN_ATTENTION_STATUSES,
  TASK_STATUSES,
  formatReference,
  type FloorEdge,
  type FloorTask,
  type TaskPriority,
  type TaskRef,
  type TaskStatus,
} from "@helpdesk/contracts";
import { type FloorMatchMode, type MapGroupBy } from "@/pages/tasks-map/useFloorParams";

/**
 * The Map's layout engine — a **pure** function from tasks/edges/refs (and
 * view state) to station clusters, beads, shoals, and the maps the renderer
 * needs for arcs and ghost beads. This is the model half of the Estuary
 * design (`docs/pages/Tasks_Floor.md`); `scene.ts` is the pixel/geometry half
 * (station positions along the river spline, the terrain, the actual phyllotaxis
 * angle/radius, day/night).
 *
 * Kept from the Foundry-era layout engine, unchanged in spirit: the must-show
 * rule, the six grouping modes (`project | epic | chain | agent | label |
 * none`, still called `belts` in the URL as a deprecated alias — see
 * `useFloorParams`), connected-component chain grouping, the dependency
 * closure (trace), project-colour index assignment, and the "+N in the
 * Logbook" older-closed count. Replaced: the belts×stations grid and its
 * slot/pile placement, which do not apply to a radial cluster — see
 * `MapCluster`'s shoal below for the equivalent.
 */

/* ------------------------------------------------------------------ *
 * Stations and regions
 * ------------------------------------------------------------------ */

export type MapRegionKey = "plan" | "doing" | "waiting" | "closed";

export type MapRegion = {
  key: MapRegionKey;
  /** The all-caps lane label painted on the map ("PLAN", "DOING", …). */
  name: string;
  /** The place name under it ("headwaters", "the reach", …). */
  place: string;
  statuses: readonly TaskStatus[];
};

export const MAP_REGIONS: readonly MapRegion[] = [
  { key: "plan", name: "PLAN", place: "headwaters", statuses: ["backlog", "needs_refinement", "todo"] },
  { key: "doing", name: "DOING", place: "the reach", statuses: ["in_progress", "needs_qa"] },
  {
    key: "waiting",
    name: "WAITING",
    place: "the lagoon",
    statuses: ["blocked", "needs_user_decision", "needs_user_action"],
  },
  { key: "closed", name: "CLOSED", place: "the mouth", statuses: ["done", "deferred"] },
];

/** Every station, region order then station order within it. Equal to `TASK_STATUSES` under a different grouping. */
export const MAP_STATIONS: readonly TaskStatus[] = MAP_REGIONS.flatMap((region) => region.statuses);

export const mapRegionOf = (status: TaskStatus): MapRegionKey =>
  MAP_REGIONS.find((region) => region.statuses.includes(status))?.key ?? "plan";

export const ALL_FLOOR_STATUSES: readonly TaskStatus[] = TASK_STATUSES;

/** Stations that glow as attention pools — the yellow/red halos in the prototype. */
export const POOL_STATIONS: Record<TaskStatus, "attn" | "block" | undefined> = {
  backlog: undefined,
  needs_refinement: undefined,
  todo: undefined,
  in_progress: undefined,
  needs_qa: "attn",
  done: undefined,
  deferred: undefined,
  blocked: "block",
  needs_user_decision: "attn",
  needs_user_action: "attn",
};

const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 3, high: 2, medium: 1, low: 0 };

/* ------------------------------------------------------------------ *
 * Sizing — bead radius and cluster capacity
 * ------------------------------------------------------------------ */

export const BASE_PRIORITY_RADIUS: Record<TaskPriority, number> = {
  low: 4,
  medium: 5.4,
  high: 6.8,
  urgent: 8.2,
};

/** The prototype's `BS` — a viewport-width scale, flat below the horizontal breakpoint. */
export const computeViewportScale = (viewportWidth: number, horizontal: boolean): number =>
  // Vertical mode's beads are a bit smaller than before (`0.8`, was `0.95`)
  // — one of the phone-legibility fixes alongside the taller canvas, fewer
  // callouts, and shorter plates (see `scene.ts`'s `drawFrame`/`drawPlate`).
  horizontal ? Math.min(1.4, Math.max(0.95, viewportWidth / 880)) : 0.8;

/**
 * A task-count-driven scale, independent of viewport width — "few tasks, big
 * beads; many, smaller, down to a floor." 20 or fewer visible tasks on the
 * whole map is full size; 400 or more is the floor.
 */
export const computeDensityScale = (visibleCount: number): number => {
  const MIN = 0.55;
  const FULL_AT = 20;
  const FLOOR_AT = 400;
  if (visibleCount <= FULL_AT) return 1;
  if (visibleCount >= FLOOR_AT) return MIN;
  const t = (visibleCount - FULL_AT) / (FLOOR_AT - FULL_AT);
  return 1 - t * (1 - MIN);
};

export const beadRadius = (
  priority: TaskPriority,
  viewportScale: number,
  densityScale: number,
): number => BASE_PRIORITY_RADIUS[priority] * viewportScale * densityScale;

export const CLUSTER_SPACING_BASE = 10;
export const MAX_CLUSTER_RADIUS_BASE = 68;

/** How many beads a station cluster shows individually before the rest fold into a shoal. */
export const computeMaxPerCluster = (viewportScale: number, densityScale: number): number => {
  const spacing = CLUSTER_SPACING_BASE * viewportScale * densityScale;
  const maxRadius = MAX_CLUSTER_RADIUS_BASE * viewportScale;
  return Math.max(6, Math.floor((maxRadius / spacing) ** 2));
};

/* ------------------------------------------------------------------ *
 * Must-show / ordering / stale / working — unchanged from the Foundry engine
 * ------------------------------------------------------------------ */

const isHumanAttention = (status: TaskStatus): boolean =>
  (HUMAN_ATTENTION_STATUSES as readonly TaskStatus[]).includes(status);

export type MustShowContext = {
  hasActiveFilters: boolean;
  selectedTaskId?: number | null;
  edgeNeighborIds?: ReadonlySet<number>;
};

/**
 * Drag-to-transition's only drop-validity rule: any status may move to any
 * other (`lib/statusTransition.ts` — there is no transition table), so the
 * one invalid drop is a bead dropped back on the station it's already at.
 * `currentStation` is `undefined` for a task `buildMapLayout` didn't place
 * (shouldn't happen for a bead actually being dragged, but a drag that
 * somehow outlives its own layout shouldn't silently "succeed" either).
 */
export const isValidDropTarget = (currentStation: TaskStatus | undefined, target: TaskStatus): boolean =>
  currentStation !== undefined && target !== currentStation;

export const isMustShowCrate = (task: FloorTask, ctx: MustShowContext): boolean =>
  isHumanAttention(task.status) ||
  task.status === "in_progress" ||
  task.status === "blocked" ||
  task.priority === "urgent" ||
  (ctx.hasActiveFilters && task.matches) ||
  task.id === ctx.selectedTaskId ||
  (ctx.edgeNeighborIds?.has(task.id) ?? false);

export const compareFloorTasks = (a: FloorTask, b: FloorTask): number => {
  const aAttention = isHumanAttention(a.status);
  const bAttention = isHumanAttention(b.status);
  if (aAttention !== bAttention) return aAttention ? -1 : 1;
  if (aAttention && bAttention) {
    const byAge = a.updatedAt.localeCompare(b.updatedAt);
    if (byAge !== 0) return byAge;
  }
  const byPriority = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
  if (byPriority !== 0) return byPriority;
  const byUnblocks = b.unblocksCount - a.unblocksCount;
  if (byUnblocks !== 0) return byUnblocks;
  return a.updatedAt.localeCompare(b.updatedAt);
};

const STALE_MS = 7 * 24 * 60 * 60 * 1000;

export const isStaleTask = (task: FloorTask, now: number): boolean =>
  task.status !== "done" &&
  task.status !== "deferred" &&
  now - new Date(task.updatedAt).getTime() > STALE_MS;

export const isWorkingTask = (task: FloorTask): boolean =>
  task.status === "in_progress" && task.claim !== null;

/* ------------------------------------------------------------------ *
 * Beads, shoals, clusters
 * ------------------------------------------------------------------ */

export type MapBead = {
  task: FloorTask;
  dimmed: boolean;
  mustShow: boolean;
  traced: boolean;
  groupKey: string;
  groupIndex: number;
  /** Sequential position among this cluster's shown beads — the renderer's phyllotaxis radius index. */
  order: number;
};

export type MapShoal = {
  count: number;
  matchCount: number;
  priorityMix: Record<TaskPriority, number>;
  taskIds: number[];
};

export type MapGroupInfo = { key: string; label: string; index: number; count: number };

export type MapCluster = {
  station: TaskStatus;
  beads: MapBead[];
  shoal: MapShoal | null;
  /** Groups present in this cluster (including ones folded into the shoal), in sector order. */
  groups: MapGroupInfo[];
  totalCount: number;
  matchCount: number;
};

export type MapGhostBead = { ref: TaskRef; direction: "blocker" | "dependent" };

export type MapTaskPosition = { station: TaskStatus; order: number; inShoal: boolean };

export type OlderClosedPile = { count: number };

export type MapLayout = {
  clusters: Record<TaskStatus, MapCluster>;
  edges: readonly FloorEdge[];
  taskPosition: ReadonlyMap<number, MapTaskPosition>;
  refIndex: ReadonlyMap<number, TaskRef>;
  ghostBeads: MapGhostBead[];
  olderClosedPile: OlderClosedPile | null;
  /** The whole map's group legend — union across stations, stable order. */
  groups: readonly MapGroupInfo[];
};

/* ------------------------------------------------------------------ *
 * Dependency closure (trace)
 * ------------------------------------------------------------------ */

export const dependencyClosureOf = (
  selectedTaskId: number,
  edges: readonly FloorEdge[],
): ReadonlySet<number> => {
  const forward = new Map<number, number[]>();
  const backward = new Map<number, number[]>();
  for (const edge of edges) {
    (forward.get(edge.blockerId) ?? forward.set(edge.blockerId, []).get(edge.blockerId)!).push(
      edge.dependentId,
    );
    (backward.get(edge.dependentId) ?? backward.set(edge.dependentId, []).get(edge.dependentId)!).push(
      edge.blockerId,
    );
  }
  const closure = new Set<number>([selectedTaskId]);
  const queue = [selectedTaskId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of [...(forward.get(current) ?? []), ...(backward.get(current) ?? [])]) {
      if (!closure.has(next)) {
        closure.add(next);
        queue.push(next);
      }
    }
  }
  return closure;
};

/* ------------------------------------------------------------------ *
 * Chain grouping — connected components, largest first
 * ------------------------------------------------------------------ */

export const UNCONNECTED_GROUP_KEY = "__unconnected__";
const NO_PROJECT_GROUP_KEY = "__no_project__";
const NO_PARENT_GROUP_KEY = "__no_parent__";
const NO_LABEL_GROUP_KEY = "__no_label__";
const UNASSIGNED_GROUP_KEY = "__unassigned__";
export const ALL_GROUP_KEY = "__all__";

const computeChainComponents = (
  tasks: readonly FloorTask[],
  edges: readonly FloorEdge[],
): Map<number, string> => {
  const parent = new Map<number, number>();
  const find = (id: number): number => {
    let root = id;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    let cursor = id;
    while (parent.get(cursor) !== undefined && parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  for (const task of tasks) parent.set(task.id, task.id);
  const inScope = new Set(tasks.map((task) => task.id));
  for (const edge of edges) {
    if (inScope.has(edge.blockerId) && inScope.has(edge.dependentId)) union(edge.blockerId, edge.dependentId);
  }

  const componentMembers = new Map<number, number[]>();
  for (const task of tasks) {
    const root = find(task.id);
    (componentMembers.get(root) ?? componentMembers.set(root, []).get(root)!).push(task.id);
  }

  const ordered = [...componentMembers.entries()]
    .filter(([, members]) => members.length > 1)
    .sort((a, b) => b[1].length - a[1].length || Math.min(...a[1]) - Math.min(...b[1]));

  const keyByRoot = new Map<number, string>();
  ordered.forEach(([root], index) => keyByRoot.set(root, `chain-${index}`));

  const assignment = new Map<number, string>();
  for (const task of tasks) {
    const root = find(task.id);
    assignment.set(task.id, keyByRoot.get(root) ?? UNCONNECTED_GROUP_KEY);
  }
  return assignment;
};

/* ------------------------------------------------------------------ *
 * Blocked chains — for the Map landing page's "In flight" section: every
 * connected component (by dependency edge, same union-find as chain
 * grouping above) that still has at least one unsatisfied edge, as a small
 * node-link graph the renderer draws left→right. Pure and unit-tested —
 * `TasksMapPage`'s "In flight" section only formats what this returns.
 * ------------------------------------------------------------------ */

export type BlockedChainNode = {
  taskId: number;
  reference: string;
  title: string;
  status: TaskStatus;
  region: MapRegionKey;
  unblocksCount: number;
};

export type BlockedChainEdge = { blockerId: number; dependentId: number; satisfied: boolean };

export type BlockedChain = {
  key: string;
  nodes: BlockedChainNode[];
  edges: BlockedChainEdge[];
  /** The node with the highest `unblocksCount` in this chain, when it unblocks anything at all. */
  bottleneckTaskId: number | null;
};

export const buildBlockedChains = (
  tasks: readonly FloorTask[],
  edges: readonly FloorEdge[],
): BlockedChain[] => {
  const taskById = new Map(tasks.map((task) => [task.id, task] as const));
  const parent = new Map<number, number>();
  const find = (id: number): number => {
    let root = id;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    let cursor = id;
    while (parent.get(cursor) !== undefined && parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  for (const task of tasks) parent.set(task.id, task.id);
  const inScope = new Set(tasks.map((task) => task.id));
  const relevantEdges = edges.filter((edge) => inScope.has(edge.blockerId) && inScope.has(edge.dependentId));
  for (const edge of relevantEdges) union(edge.blockerId, edge.dependentId);

  const componentEdges = new Map<number, FloorEdge[]>();
  for (const edge of relevantEdges) {
    const root = find(edge.blockerId);
    (componentEdges.get(root) ?? componentEdges.set(root, []).get(root)!).push(edge);
  }
  const componentMembers = new Map<number, number[]>();
  for (const task of tasks) {
    const root = find(task.id);
    (componentMembers.get(root) ?? componentMembers.set(root, []).get(root)!).push(task.id);
  }

  const chains: BlockedChain[] = [];
  for (const [root, memberIds] of componentMembers) {
    const compEdges = componentEdges.get(root) ?? [];
    if (!compEdges.some((edge) => !edge.satisfied)) continue;

    const nodes: BlockedChainNode[] = memberIds
      .map((id) => taskById.get(id))
      .filter((task): task is FloorTask => task !== undefined)
      .map((task) => ({
        taskId: task.id,
        reference: task.reference,
        title: task.title,
        status: task.status,
        region: mapRegionOf(task.status),
        unblocksCount: task.unblocksCount,
      }));
    if (nodes.length < 2) continue;

    const bottleneck = nodes.reduce<BlockedChainNode | null>(
      (best, node) => (best === null || node.unblocksCount > best.unblocksCount ? node : best),
      null,
    );

    chains.push({
      key: `chain-${root}`,
      nodes,
      edges: compEdges.map((edge) => ({
        blockerId: edge.blockerId,
        dependentId: edge.dependentId,
        satisfied: edge.satisfied,
      })),
      bottleneckTaskId: bottleneck !== null && bottleneck.unblocksCount > 0 ? bottleneck.taskId : null,
    });
  }

  return chains.sort(
    (a, b) => b.nodes.length - a.nodes.length || Math.min(...a.nodes.map((n) => n.taskId)) - Math.min(...b.nodes.map((n) => n.taskId)),
  );
};

/* ------------------------------------------------------------------ *
 * Grouping — key + label per mode
 * ------------------------------------------------------------------ */

const groupAssignment = (
  tasks: readonly FloorTask[],
  edges: readonly FloorEdge[],
  mode: MapGroupBy,
): Map<number, string> => {
  if (mode === "chain") return computeChainComponents(tasks, edges);

  const map = new Map<number, string>();
  for (const task of tasks) {
    const key = ((): string => {
      switch (mode) {
        case "none":
          return ALL_GROUP_KEY;
        case "epic":
          return task.parentId === null ? NO_PARENT_GROUP_KEY : `parent-${task.parentId}`;
        case "agent":
          return task.claim?.actor ?? task.assignee ?? UNASSIGNED_GROUP_KEY;
        case "label":
          return task.labels[0] ?? NO_LABEL_GROUP_KEY;
        case "project":
        default:
          return task.project ?? NO_PROJECT_GROUP_KEY;
      }
    })();
    map.set(task.id, key);
  }
  return map;
};

const groupLabelOf = (
  key: string,
  mode: MapGroupBy,
  refIndex: ReadonlyMap<number, TaskRef>,
  taskIndex: ReadonlyMap<number, FloorTask>,
): string => {
  if (key === UNCONNECTED_GROUP_KEY) return "Unconnected";
  if (mode === "none") return "All tasks";
  if (mode === "project") return key === NO_PROJECT_GROUP_KEY ? "No project" : key;
  if (mode === "agent") return key === UNASSIGNED_GROUP_KEY ? "Unassigned" : key;
  if (mode === "label") return key === NO_LABEL_GROUP_KEY ? "No label" : key;
  if (mode === "epic") {
    if (key === NO_PARENT_GROUP_KEY) return "No parent";
    const parentId = Number(key.slice("parent-".length));
    const title = taskIndex.get(parentId)?.title ?? refIndex.get(parentId)?.title;
    return title === undefined ? formatReference(parentId) : `${formatReference(parentId)} ${title}`;
  }
  if (mode === "chain") return key.startsWith("chain-") ? `Chain ${Number(key.slice(6)) + 1}` : key;
  return key;
};

/** `group=epic` when scope is one project with parents; `none` for one project without; `project` otherwise. */
/**
 * Distinct `agent:*` actors currently holding a **live** claim (non-null,
 * `expiresAt` in the future) — the hero's "N agents working" line. Not
 * `statusCounts.in_progress`: a task can sit `in_progress` with an expired or
 * missing claim (the "Stalled" case `InFlightSection` shows), and that is not
 * an agent doing anything right now. A human's claim doesn't count either —
 * the line is specifically about agents.
 */
export const countWorkingAgents = (tasks: readonly FloorTask[], now: Date = new Date()): number => {
  const actors = new Set<string>();
  for (const task of tasks) {
    const claim = task.claim;
    if (claim === null) continue;
    if (!claim.actor.startsWith("agent:")) continue;
    if (new Date(claim.expiresAt).getTime() <= now.getTime()) continue;
    actors.add(claim.actor);
  }
  return actors.size;
};

export const computeDefaultBeltsMode = (
  project: readonly string[],
  tasks: readonly FloorTask[],
): MapGroupBy => {
  if (project.length !== 1) return "project";
  return tasks.some((task) => task.parentId !== null || task.childCount > 0) ? "epic" : "none";
};

/* ------------------------------------------------------------------ *
 * Project colour assignment
 * ------------------------------------------------------------------ */

export const sortedProjectKeys = (tasks: readonly FloorTask[]): string[] => {
  const set = new Set<string>();
  for (const task of tasks) if (task.project !== null) set.add(task.project);
  return [...set].sort();
};

export const projectColorIndex = (
  project: string | null,
  allProjects: readonly string[],
): number | null => {
  if (project === null) return null;
  const index = allProjects.indexOf(project);
  return index === -1 ? allProjects.length : index;
};

/**
 * The colour index for a bead: sorted project order when grouping by project
 * (so a project keeps its colour whichever group-by the URL selects), or the
 * group's own sector index otherwise — a categorical palette per group value,
 * with the real project shown in the tip/Ledger instead.
 */
export const beadColorIndex = (
  task: FloorTask,
  _groupKey: string,
  groupIndex: number,
  mode: MapGroupBy,
  allProjects: readonly string[],
): number | null => (mode === "project" ? projectColorIndex(task.project, allProjects) : groupIndex);

/* ------------------------------------------------------------------ *
 * The build function
 * ------------------------------------------------------------------ */

export type BuildMapLayoutInput = {
  tasks: readonly FloorTask[];
  edges: readonly FloorEdge[];
  refs: readonly TaskRef[];
  group: MapGroupBy;
  match: FloorMatchMode;
  hasActiveFilters: boolean;
  selectedTaskId?: number | null;
  edgeNeighborIds?: ReadonlySet<number>;
  olderClosedCount: number;
  /** From `computeMaxPerCluster` — how many beads a station shows before shoaling the rest. */
  maxPerCluster: number;
};

const emptyPriorityMix = (): Record<TaskPriority, number> => ({ low: 0, medium: 0, high: 0, urgent: 0 });

export const buildMapLayout = (input: BuildMapLayoutInput): MapLayout => {
  const {
    tasks,
    edges,
    refs,
    group: groupMode,
    match,
    hasActiveFilters,
    selectedTaskId,
    edgeNeighborIds,
    olderClosedCount,
    maxPerCluster,
  } = input;

  const taskById = new Map(tasks.map((task) => [task.id, task] as const));
  const refIndex = new Map(refs.map((ref) => [ref.id, ref] as const));
  const mustShowCtx: MustShowContext = { hasActiveFilters, selectedTaskId, edgeNeighborIds };

  const traceClosure: ReadonlySet<number> | null =
    selectedTaskId === null || selectedTaskId === undefined ? null : dependencyClosureOf(selectedTaskId, edges);

  const assignment = groupAssignment(tasks, edges, groupMode);

  // Stable group order: first-seen, then largest-first (mirrors the belt order
  // the Foundry engine used — largest group first reads best in a legend too).
  const groupOrderKeys: string[] = [];
  const groupCounts = new Map<string, number>();
  for (const task of tasks) {
    const key = assignment.get(task.id) ?? ALL_GROUP_KEY;
    if (!groupCounts.has(key)) groupOrderKeys.push(key);
    groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
  }
  groupOrderKeys.sort((a, b) => (groupCounts.get(b) ?? 0) - (groupCounts.get(a) ?? 0));
  const groupIndexOf = new Map(groupOrderKeys.map((key, index) => [key, index]));

  const overallGroups: MapGroupInfo[] = groupOrderKeys.map((key) => ({
    key,
    label: groupLabelOf(key, groupMode, refIndex, taskById),
    index: groupIndexOf.get(key) ?? 0,
    count: groupCounts.get(key) ?? 0,
  }));

  const taskPosition = new Map<number, MapTaskPosition>();
  const clusters = {} as Record<TaskStatus, MapCluster>;

  for (const station of MAP_STATIONS) {
    const inStation = tasks.filter((task) => task.status === station);
    const totalCount = inStation.length;
    const matchCount = inStation.filter((task) => task.matches).length;

    const visible = match === "hide" ? inStation.filter((task) => task.matches) : inStation;
    const sorted = [...visible].sort((a, b) => {
      const groupDiff =
        (groupIndexOf.get(assignment.get(a.id) ?? ALL_GROUP_KEY) ?? 0) -
        (groupIndexOf.get(assignment.get(b.id) ?? ALL_GROUP_KEY) ?? 0);
      return groupDiff !== 0 ? groupDiff : compareFloorTasks(a, b);
    });

    const mustShow = sorted.filter((task) => isMustShowCrate(task, mustShowCtx));
    const rest = sorted.filter((task) => !isMustShowCrate(task, mustShowCtx));

    const capacity = Math.max(maxPerCluster, mustShow.length);
    const shownRest = rest.slice(0, Math.max(0, capacity - mustShow.length));
    const overflow = rest.slice(Math.max(0, capacity - mustShow.length));

    // Must-show first (so they always render), but keep the group-then-priority
    // order stable within each half for a coherent sector layout.
    const shown = [...mustShow, ...shownRest].sort((a, b) => {
      const groupDiff =
        (groupIndexOf.get(assignment.get(a.id) ?? ALL_GROUP_KEY) ?? 0) -
        (groupIndexOf.get(assignment.get(b.id) ?? ALL_GROUP_KEY) ?? 0);
      return groupDiff !== 0 ? groupDiff : compareFloorTasks(a, b);
    });

    const beads: MapBead[] = shown.map((task, order) => {
      const groupKey = assignment.get(task.id) ?? ALL_GROUP_KEY;
      const groupIndex = groupIndexOf.get(groupKey) ?? 0;
      return {
        task,
        dimmed: match === "dim" && !task.matches,
        mustShow: isMustShowCrate(task, mustShowCtx),
        traced: traceClosure === null || traceClosure.has(task.id),
        groupKey,
        groupIndex,
        order,
      };
    });

    beads.forEach((bead) => taskPosition.set(bead.task.id, { station, order: bead.order, inShoal: false }));

    const shoal: MapShoal | null =
      overflow.length === 0
        ? null
        : {
            count: overflow.length,
            matchCount: overflow.filter((task) => task.matches).length,
            priorityMix: overflow.reduce((mix, task) => {
              mix[task.priority] += 1;
              return mix;
            }, emptyPriorityMix()),
            taskIds: overflow.map((task) => task.id),
          };
    if (shoal !== null) {
      overflow.forEach((task) => taskPosition.set(task.id, { station, order: beads.length, inShoal: true }));
    }

    const stationGroupCounts = new Map<string, number>();
    for (const task of inStation) {
      const key = assignment.get(task.id) ?? ALL_GROUP_KEY;
      stationGroupCounts.set(key, (stationGroupCounts.get(key) ?? 0) + 1);
    }
    const groups: MapGroupInfo[] = [...stationGroupCounts.entries()]
      .map(([key, count]) => ({
        key,
        label: groupLabelOf(key, groupMode, refIndex, taskById),
        index: groupIndexOf.get(key) ?? 0,
        count,
      }))
      .sort((a, b) => a.index - b.index);

    clusters[station] = { station, beads, shoal, groups, totalCount, matchCount };
  }

  // Off-scope ghost beads: any ref touched by an edge whose other end is in
  // scope. Flat and deduplicated — Estuary has one "tributary" at the map's
  // edge, not one per belt.
  const ghostBeads: MapGhostBead[] = [];
  const seenRefs = new Set<number>();
  for (const edge of edges) {
    const blockerInScope = taskById.has(edge.blockerId);
    const dependentInScope = taskById.has(edge.dependentId);
    if (blockerInScope && !dependentInScope && !seenRefs.has(edge.dependentId)) {
      const ref = refIndex.get(edge.dependentId);
      if (ref !== undefined) {
        ghostBeads.push({ ref, direction: "dependent" });
        seenRefs.add(edge.dependentId);
      }
    }
    if (dependentInScope && !blockerInScope && !seenRefs.has(edge.blockerId)) {
      const ref = refIndex.get(edge.blockerId);
      if (ref !== undefined) {
        ghostBeads.push({ ref, direction: "blocker" });
        seenRefs.add(edge.blockerId);
      }
    }
  }

  return {
    clusters,
    edges,
    taskPosition,
    refIndex,
    ghostBeads,
    olderClosedPile: olderClosedCount > 0 ? { count: olderClosedCount } : null,
    groups: overallGroups,
  };
};
