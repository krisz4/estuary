import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import {
  DEFAULT_FLOOR_SHIPPED_WINDOW,
  FLOOR_SHIPPED_WINDOWS,
  type FloorShippedWindow,
  TASK_ID_MAX_DIGITS,
  TASK_STATUSES,
  type TaskStatus,
} from "@estuary/contracts";
import {
  DEFAULT_TASK_LIST_PARAMS,
  parseTaskListParams,
  serializeTaskListParams,
  TASK_LIST_PARAM_KEYS,
  type TaskListFilterPatch,
  type TaskListParams,
} from "@/pages/tasks-list/useTaskListParams";

/**
 * The Map's state, which — like the list's — **is** the URL. Built on top of
 * `useTaskListParams`'s pure `parseTaskListParams` / `serializeTaskListParams`
 * rather than the hook itself, so the whole URL (shared filters + map-only
 * keys) is one read and one write. Two independent `useSearchParams()`-backed
 * hooks writing in the same event handler would each build on their own stale
 * base (see the long comment on `useTaskListParams`'s `baseRef`) and the second
 * write would silently clobber the first.
 *
 * Map-only keys, per `docs/pages/Tasks_Floor.md`:
 *
 * - `group` — `project | none | epic | chain | agent | label`. **`belts` is a
 *   deprecated alias**, read the same way, for any link written before the
 *   Foundry→Estuary rename; new writes always use `group`.
 * - `links` — `focus | blocking | all | off` (the dependency arcs).
 * - `match` — `dim | hide`.
 * - `shipped` — `24h | 7d`, the mouth's window.
 * - `fold` — folded group keys (repeatable), shareable because it changes what
 *   a link shows.
 * - `task` — the task open in `TaskWorkspaceDialog`, so it is shareable.
 * - `list` — statuses (repeatable) whose full task list is open in
 *   `TaskWorkspaceDialog`, from a station or a briefing tile. It opens a list *over*
 *   the map rather than filtering it, so it never touches `status`.
 * - `stale` / `working` — client-computed presets.
 * - `at` — replay: the map as it stood at this instant (phase 6, the tide
 *   scrubber).
 */

export const MAP_GROUP_BY_VALUES = ["project", "none", "epic", "chain", "agent", "label"] as const;
export type MapGroupBy = (typeof MAP_GROUP_BY_VALUES)[number];
/** @deprecated Use `MapGroupBy` — kept as an alias so existing imports compile through the rename. */
export type FloorBeltsMode = MapGroupBy;

export const FLOOR_MATCH_MODES = ["dim", "hide"] as const;
export type FloorMatchMode = (typeof FLOOR_MATCH_MODES)[number];

export const FLOOR_LINKS_MODES = ["focus", "blocking", "all", "off"] as const;
export type FloorLinksMode = (typeof FLOOR_LINKS_MODES)[number];
export const DEFAULT_FLOOR_LINKS_MODE: FloorLinksMode = "blocking";

export const FLOOR_PARAM_KEYS = [
  "group",
  "belts",
  "links",
  "match",
  "shipped",
  "fold",
  "task",
  "list",
  "at",
  "stale",
  "working",
] as const;

export type FloorOnlyParams = {
  /** `undefined` reads as the computed default — see `layout.ts`'s `computeDefaultBeltsMode`. */
  group: MapGroupBy | undefined;
  links: FloorLinksMode;
  match: FloorMatchMode;
  shipped: FloorShippedWindow;
  fold: string[];
  task: number | undefined;
  /** Non-empty = the station/tile list dialog is open for these statuses. */
  list: TaskStatus[];
  at: string | undefined;
  stale: boolean;
  working: boolean;
};

export type FloorParams = TaskListParams & FloorOnlyParams;

const oneOf = <T extends string>(allowed: readonly T[], raw: string): T | undefined =>
  (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined;

const TASK_ID_QUERY_PATTERN = new RegExp(`^\\d{1,${TASK_ID_MAX_DIGITS}}$`);

const parseTaskId = (raw: string | null): number | undefined => {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (!TASK_ID_QUERY_PATTERN.test(trimmed)) return undefined;
  const value = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
};

const parseAt = (raw: string | null): string | undefined => {
  if (raw === null) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : raw;
};

const parseFlag = (raw: string | null): boolean => raw === "1" || raw === "true";

/** `?list=backlog&list=nonsense&list=backlog` → `["backlog"]`. */
const parseStatusList = (raw: string[]): TaskStatus[] => [
  ...new Set(raw.map((value) => oneOf(TASK_STATUSES, value.trim())).filter((v) => v !== undefined)),
];

const parseFloorOnly = (searchParams: URLSearchParams): FloorOnlyParams => ({
  group: (() => {
    // `group` wins when both are present (a hand-edited URL); `belts` is the
    // pre-rename spelling, read the same way so an old shared link still works.
    const raw = searchParams.get("group") ?? searchParams.get("belts");
    return raw === null ? undefined : oneOf(MAP_GROUP_BY_VALUES, raw);
  })(),
  links: oneOf(FLOOR_LINKS_MODES, searchParams.get("links") ?? "") ?? DEFAULT_FLOOR_LINKS_MODE,
  match: oneOf(FLOOR_MATCH_MODES, searchParams.get("match") ?? "") ?? "dim",
  shipped:
    oneOf(FLOOR_SHIPPED_WINDOWS, searchParams.get("shipped") ?? "") ?? DEFAULT_FLOOR_SHIPPED_WINDOW,
  fold: [
    ...new Set(
      searchParams
        .getAll("fold")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ],
  task: parseTaskId(searchParams.get("task")),
  list: parseStatusList(searchParams.getAll("list")),
  at: parseAt(searchParams.get("at")),
  stale: parseFlag(searchParams.get("stale")),
  working: parseFlag(searchParams.get("working")),
});

export const parseFloorParams = (searchParams: URLSearchParams): FloorParams => ({
  ...parseTaskListParams(searchParams),
  ...parseFloorOnly(searchParams),
});

const serializeFloorOnly = (params: FloorOnlyParams, next: URLSearchParams): void => {
  next.delete("group");
  next.delete("belts");
  next.delete("links");
  next.delete("match");
  next.delete("shipped");
  next.delete("fold");
  next.delete("task");
  next.delete("list");
  next.delete("at");
  next.delete("stale");
  next.delete("working");

  // Always written as `group` — `belts` is read-only compatibility, never emitted again.
  if (params.group !== undefined) next.set("group", params.group);
  if (params.links !== DEFAULT_FLOOR_LINKS_MODE) next.set("links", params.links);
  if (params.match !== "dim") next.set("match", params.match);
  if (params.shipped !== DEFAULT_FLOOR_SHIPPED_WINDOW) next.set("shipped", params.shipped);
  for (const key of params.fold) next.append("fold", key);
  if (params.task !== undefined) next.set("task", String(params.task));
  for (const status of params.list) next.append("list", status);
  if (params.at !== undefined) next.set("at", params.at);
  if (params.stale) next.set("stale", "1");
  if (params.working) next.set("working", "1");
};

export const hasActiveFloorFilters = (params: FloorParams): boolean =>
  params.status.length > 0 ||
  params.priority.length > 0 ||
  params.label.length > 0 ||
  params.assignee !== undefined ||
  params.assigneeIsNull !== undefined ||
  params.createdBy !== undefined ||
  params.q !== undefined ||
  params.createdFrom !== undefined ||
  params.createdTo !== undefined ||
  params.stale ||
  params.working;

export const floorActiveFilterCount = (params: FloorParams): number =>
  (params.status.length > 0 ? 1 : 0) +
  (params.priority.length > 0 ? 1 : 0) +
  (params.label.length > 0 ? 1 : 0) +
  (params.assignee !== undefined || params.assigneeIsNull !== undefined ? 1 : 0) +
  (params.createdBy !== undefined ? 1 : 0) +
  (params.q !== undefined ? 1 : 0) +
  (params.createdFrom !== undefined ? 1 : 0) +
  (params.createdTo !== undefined ? 1 : 0) +
  (params.stale ? 1 : 0) +
  (params.working ? 1 : 0);

export type FloorParamsApi = {
  params: FloorParams;
  setFilters: (patch: TaskListFilterPatch, options?: { replace?: boolean }) => void;
  setSort: (sort: FloorParams["sort"]) => void;
  clearFilters: () => void;
  setGroup: (group: MapGroupBy | undefined) => void;
  setLinks: (links: FloorLinksMode) => void;
  setMatch: (match: FloorMatchMode) => void;
  setShipped: (shipped: FloorShippedWindow) => void;
  toggleFold: (groupKey: string) => void;
  setSelectedTask: (taskId: number | undefined, options?: { replace?: boolean }) => void;
  /** Opens (non-empty) or closes (`[]`) the task-list dialog. Pushes a history entry, so Back closes it. */
  setStatusList: (statuses: TaskStatus[]) => void;
  setAt: (at: string | undefined, options?: { replace?: boolean }) => void;
  /** Applies a whole preset patch in one URL write — "Chains" sets both `group` and `links`. */
  applyPreset: (patch: Partial<FloorOnlyParams>) => void;
  hasActiveFilters: boolean;
  activeFilterCount: number;
};

export const useFloorParams = (): FloorParamsApi => {
  const [searchParams, setSearchParams] = useSearchParams();

  const params = useMemo(() => parseFloorParams(searchParams), [searchParams]);

  const baseRef = useRef(searchParams);
  useEffect(() => {
    baseRef.current = searchParams;
  }, [searchParams]);

  const setSearchParamsRef = useRef(setSearchParams);
  useEffect(() => {
    setSearchParamsRef.current = setSearchParams;
  }, [setSearchParams]);

  const update = useCallback(
    (mutate: (current: FloorParams) => FloorParams, options: { replace?: boolean } = {}) => {
      const base = baseRef.current;
      const current = parseFloorParams(base);
      const next = mutate(current);

      const serialized = serializeTaskListParams(next, base);
      serializeFloorOnly(next, serialized);

      baseRef.current = serialized;
      setSearchParamsRef.current(serialized, { replace: options.replace ?? false });
    },
    [],
  );

  const setFilters = useCallback(
    (patch: TaskListFilterPatch, options?: { replace?: boolean }) =>
      update((current) => {
        const resolved = typeof patch === "function" ? patch(current) : patch;
        const merged: FloorParams = { ...current, ...resolved };
        if (resolved.assignee !== undefined) merged.assigneeIsNull = undefined;
        if (resolved.assigneeIsNull !== undefined) merged.assignee = undefined;
        return merged;
      }, options),
    [update],
  );

  const setSort = useCallback(
    (sort: FloorParams["sort"]) => update((current) => ({ ...current, sort })),
    [update],
  );

  const clearFilters = useCallback(
    () =>
      update((current) => ({
        ...DEFAULT_TASK_LIST_PARAMS,
        pageSize: current.pageSize,
        sort: current.sort,
        project: current.project,
        group: current.group,
        links: current.links,
        match: current.match,
        shipped: current.shipped,
        fold: current.fold,
        task: current.task,
        list: current.list,
        at: current.at,
        stale: false,
        working: false,
      })),
    [update],
  );

  const setGroup = useCallback(
    (group: MapGroupBy | undefined) => update((current) => ({ ...current, group })),
    [update],
  );

  const setLinks = useCallback(
    (links: FloorLinksMode) => update((current) => ({ ...current, links })),
    [update],
  );

  const setMatch = useCallback(
    (match: FloorMatchMode) => update((current) => ({ ...current, match })),
    [update],
  );

  const setShipped = useCallback(
    (shipped: FloorShippedWindow) => update((current) => ({ ...current, shipped })),
    [update],
  );

  const toggleFold = useCallback(
    (groupKey: string) =>
      update((current) => ({
        ...current,
        fold: current.fold.includes(groupKey)
          ? current.fold.filter((entry) => entry !== groupKey)
          : [...current.fold, groupKey],
      })),
    [update],
  );

  const setSelectedTask = useCallback(
    (taskId: number | undefined, options?: { replace?: boolean }) =>
      update((current) => ({ ...current, task: taskId }), options),
    [update],
  );

  const setStatusList = useCallback(
    (statuses: TaskStatus[]) => update((current) => ({ ...current, list: statuses })),
    [update],
  );

  const setAt = useCallback(
    (at: string | undefined, options?: { replace?: boolean }) =>
      update((current) => ({ ...current, at }), options),
    [update],
  );

  const applyPreset = useCallback(
    (patch: Partial<FloorOnlyParams>) => update((current) => ({ ...current, ...patch })),
    [update],
  );

  return {
    params,
    setFilters,
    setSort,
    clearFilters,
    setGroup,
    setLinks,
    setMatch,
    setShipped,
    toggleFold,
    setSelectedTask,
    setStatusList,
    setAt,
    applyPreset,
    hasActiveFilters: hasActiveFloorFilters(params),
    activeFilterCount: floorActiveFilterCount(params),
  };
};

/** For anything that needs to know the Map owns these keys (tests, links). */
export const ALL_FLOOR_PARAM_KEYS = [...TASK_LIST_PARAM_KEYS, ...FLOOR_PARAM_KEYS] as const;
