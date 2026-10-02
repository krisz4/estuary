import { useCallback, useState } from "react";
import {
  activeFilterCount,
  DEFAULT_TASK_LIST_PARAMS,
  hasActiveFilters,
  type TaskListFilterPatch,
  type TaskListParams,
  type TaskListParamsApi,
} from "@/pages/tasks-list/useTaskListParams";

/**
 * `useTaskListParams`'s API, held in component state instead of the URL.
 *
 * For a list that lives *inside* another page — the map's `TaskWorkspaceDialog` —
 * where the URL's list keys (`status`, `q`, `priority`, …) already belong to
 * the page underneath. Writing them would filter the map behind the dialog,
 * which is exactly what opening the dialog must not do. The dialog itself is
 * still in the URL (`?list=`), so Back closes it and a link reopens it; only
 * the refinements made inside it are ephemeral.
 *
 * Same rules as the URL version: a filter or sort change resets `page` to 1,
 * the assignee pair stays mutually exclusive, and "Clear all" keeps `project`
 * (the header's scope), sort, and page size.
 */
export const applyFilterPatch = (
  current: TaskListParams,
  patch: TaskListFilterPatch,
): TaskListParams => {
  const resolved = typeof patch === "function" ? patch(current) : patch;
  const merged: TaskListParams = { ...current, ...resolved, page: 1 };
  if (resolved.assignee !== undefined) merged.assigneeIsNull = undefined;
  if (resolved.assigneeIsNull !== undefined) merged.assignee = undefined;
  if (resolved.parentId !== undefined) merged.parentIsNull = undefined;
  if (resolved.parentIsNull !== undefined) merged.parentId = undefined;
  return merged;
};

/** The filter subset only — paging and sorting aren't "what the list is of". */
const sameFilters = (a: TaskListParams, b: TaskListParams): boolean => {
  const strip = ({ page: _p, pageSize: _s, sort: _o, ...filters }: TaskListParams) => filters;
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
};

export type LocalTaskListParamsApi = TaskListParamsApi & {
  /** Back to the filters it opened with (keeping sort and page size). */
  resetFilters: () => void;
  /** Whether the filters are still the ones it opened with. */
  isInitialFilters: boolean;
};

export const useLocalTaskListParams = (initial: TaskListParams): LocalTaskListParamsApi => {
  const [params, setParams] = useState(initial);
  // The first render's value — a new `initial` object each parent render must not reset anything.
  const [initialParams] = useState(initial);

  const setPage = useCallback((page: number) => setParams((current) => ({ ...current, page })), []);
  const setPageSize = useCallback(
    (pageSize: number) => setParams((current) => ({ ...current, pageSize, page: 1 })),
    [],
  );
  const setSort = useCallback(
    (sort: TaskListParams["sort"]) => setParams((current) => ({ ...current, sort, page: 1 })),
    [],
  );
  // `replace` is meaningless without history; accepted so the signature matches.
  const setFilters = useCallback(
    (patch: TaskListFilterPatch) => setParams((current) => applyFilterPatch(current, patch)),
    [],
  );
  const clearFilters = useCallback(
    () =>
      setParams((current) => ({
        ...DEFAULT_TASK_LIST_PARAMS,
        pageSize: current.pageSize,
        sort: current.sort,
        project: current.project,
      })),
    [],
  );

  const resetFilters = useCallback(
    () =>
      setParams((current) => ({
        ...initialParams,
        pageSize: current.pageSize,
        sort: current.sort,
        page: 1,
      })),
    [initialParams],
  );

  return {
    params,
    setPage,
    setPageSize,
    setSort,
    setFilters,
    clearFilters,
    hasActiveFilters: hasActiveFilters(params),
    activeFilterCount: activeFilterCount(params),
    resetFilters,
    isInitialFilters: sameFilters(params, initialParams),
  };
};
