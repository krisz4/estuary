import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  DEFAULT_TASK_SORT_DIRECTION,
  DEFAULT_TASK_SORT_FIELD,
  MAX_PAGE,
  MAX_PAGE_SIZE,
  MIN_PAGE_SIZE,
  SORT_DIRECTIONS,
  TASK_ASSIGNEE_MAX,
  TASK_ID_MAX_DIGITS,
  TASK_LABEL_MAX,
  TASK_PRIORITIES,
  TASK_PROJECT_MAX,
  TASK_Q_MAX,
  TASK_SORT_FIELDS,
  TASK_STATUSES,
  formatTaskSort,
  type SortDirection,
  type TaskPriority,
  type TaskSort,
  type TaskSortField,
  type TaskStatus,
} from "@helpdesk/contracts";

/**
 * The list screen's state, which **is** the URL.
 *
 * Two rules govern this module, and both are bugs the moment they are relaxed:
 *
 * 1. **It picks the keys it knows and validates them one at a time.** It does
 *    *not* feed `useSearchParams()` into `taskListQuerySchema`, which is
 *    `.strict()` and server-side by design: a link shared through Slack arrives
 *    carrying `?utm_source=slack`, the whole parse fails, and every filter the
 *    sender meant the recipient to see is silently replaced by defaults. An
 *    individually invalid value (`?page=abc`) falls back to *that field's*
 *    default and leaves its neighbours alone.
 * 2. **Changing any filter resets `page` to 1; changing `page` touches nothing
 *    else.** Forgetting it lands the user on an empty page 5 of a 1-page result
 *    — the most common bug on this screen, per the implementation plan.
 *
 * Unknown keys are preserved in the URL when we write it (a shared link keeps
 * its campaign tag) but are never forwarded to the API, which stays strict.
 */

/* ------------------------------------------------------------------ *
 * Shape
 * ------------------------------------------------------------------ */

/** Every key this module owns. Anything else in the URL is left untouched. */
export const TASK_LIST_PARAM_KEYS = [
  "page",
  "pageSize",
  "sort",
  "status",
  "priority",
  "project",
  "label",
  "assignee",
  "assigneeIsNull",
  "createdBy",
  "q",
  "createdFrom",
  "createdTo",
  "parentId",
  "parentIsNull",
  "dependsOn",
  "dependencyOf",
] as const;

export type TaskListParamKey = (typeof TASK_LIST_PARAM_KEYS)[number];

export type TaskListParams = {
  page: number;
  pageSize: number;
  sort: TaskSort;
  status: TaskStatus[];
  priority: TaskPriority[];
  /** Project slugs, OR-ed together. Values come from `GET /tasks/facets`. */
  project: string[];
  /** Label slugs, OR-ed together. Values come from `GET /tasks/facets`. */
  label: string[];
  assignee: string | undefined;
  assigneeIsNull: boolean | undefined;
  /** One exact actor, e.g. `agent:claude-code`. Values come from facets `creators`. */
  createdBy: string | undefined;
  q: string | undefined;
  createdFrom: string | undefined;
  createdTo: string | undefined;
  /** Subtasks of this one task. Mutually exclusive with `parentIsNull`. */
  parentId: number | undefined;
  /** `true` = top-level tasks only. Mutually exclusive with `parentId`. */
  parentIsNull: boolean | undefined;
  /** Tasks that depend on this task id — its dependents. */
  dependsOn: number | undefined;
  /** Tasks this task id depends on — its dependencies. */
  dependencyOf: number | undefined;
};

/** The filter subset — everything a change to which resets `page`. */
export type TaskListFilters = Omit<TaskListParams, "page" | "pageSize" | "sort">;

export const DEFAULT_SORT: TaskSort = {
  field: DEFAULT_TASK_SORT_FIELD,
  direction: DEFAULT_TASK_SORT_DIRECTION,
};

export const DEFAULT_TASK_LIST_PARAMS: TaskListParams = {
  page: DEFAULT_PAGE,
  pageSize: DEFAULT_PAGE_SIZE,
  sort: DEFAULT_SORT,
  status: [],
  priority: [],
  project: [],
  label: [],
  assignee: undefined,
  assigneeIsNull: undefined,
  createdBy: undefined,
  q: undefined,
  createdFrom: undefined,
  createdTo: undefined,
  parentId: undefined,
  parentIsNull: undefined,
  dependsOn: undefined,
  dependencyOf: undefined,
};

/* ------------------------------------------------------------------ *
 * Per-field validation
 *
 * Hand-written rather than reaching for the contract schemas: those are wrapped
 * in the `.strict()` object plus a `preprocess`, and the whole point here is to
 * validate each field in isolation so one bad value cannot take the others with
 * it. The bounds themselves still come from the contract's exported constants,
 * so there is no second copy of "page size max is 100" to drift.
 * ------------------------------------------------------------------ */

const parseBoundedInt = (raw: string | null, min: number, max: number): number | undefined => {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  // `Number()` accepts "0x2a", " 12 ", "1e3", and "" — all of which would turn a
  // typo into a plausible-looking page number. Decimal digits only.
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) return undefined;
  return value;
};

const oneOf = <T extends string>(allowed: readonly T[], raw: string): T | undefined =>
  (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined;

/**
 * `?status=todo&status=nonsense&status=todo` → `["todo"]`. Invalid entries are
 * dropped individually and duplicates collapse, so the value we send is always
 * one the server accepts.
 */
const parseEnumList = <T extends string>(allowed: readonly T[], raw: string[]): T[] => {
  const seen = new Set<T>();
  for (const entry of raw) {
    const value = oneOf(allowed, entry.trim());
    if (value !== undefined) seen.add(value);
  }
  return [...seen];
};

const parseSort = (raw: string | null): TaskSort => {
  if (raw === null) return DEFAULT_SORT;
  const [field, direction, ...rest] = raw.trim().split(":");
  if (field === undefined || direction === undefined || rest.length > 0) return DEFAULT_SORT;

  const sortField: TaskSortField | undefined = oneOf(TASK_SORT_FIELDS, field);
  const sortDirection: SortDirection | undefined = oneOf(SORT_DIRECTIONS, direction);
  if (sortField === undefined || sortDirection === undefined) return DEFAULT_SORT;

  return { field: sortField, direction: sortDirection };
};

const parseBoolean = (raw: string | null): boolean | undefined => {
  if (raw === null) return undefined;
  const value = raw.trim();
  // Matches the contract's `queryBoolean` exactly. `Boolean("false")` is `true`,
  // which would invert the filter rather than reject it.
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
};

const parseBoundedString = (raw: string | null, max: number): string | undefined => {
  if (raw === null) return undefined;
  const value = raw.trim();
  if (value.length === 0 || value.length > max) return undefined;
  return value;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD`, and a real calendar day — `2026-02-31` is rejected. */
const parseDate = (raw: string | null): string | undefined => {
  if (raw === null) return undefined;
  const value = raw.trim();
  if (!DATE_PATTERN.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().startsWith(value) ? value : undefined;
};

/**
 * The contract's project slug rule, lowercased the way `projectSchema` stores
 * it. Written out rather than calling `projectSchema.safeParse` per entry only
 * because the pattern is the whole of it; the bound is the contract's constant.
 */
const PROJECT_PATTERN = new RegExp(`^[a-z0-9][a-z0-9._-]{0,${TASK_PROJECT_MAX - 1}}$`);

export const parseProjects = (raw: string[]): string[] => {
  const seen = new Set<string>();
  for (const entry of raw) {
    const value = entry.trim().toLowerCase();
    if (PROJECT_PATTERN.test(value)) seen.add(value);
  }
  return [...seen];
};

/** The contract's label slug rule — a `/` is allowed, unlike a project slug. */
const LABEL_PATTERN = new RegExp(`^[a-z0-9][a-z0-9._/-]{0,${TASK_LABEL_MAX - 1}}$`);

const parseLabels = (raw: string[]): string[] => {
  const seen = new Set<string>();
  for (const entry of raw) {
    const value = entry.trim().toLowerCase();
    if (LABEL_PATTERN.test(value)) seen.add(value);
  }
  return [...seen];
};

/** A task id in a query param: decimal digits only, like `:taskId` itself. */
const TASK_ID_QUERY_PATTERN = new RegExp(`^\\d{1,${TASK_ID_MAX_DIGITS}}$`);

const parseTaskId = (raw: string | null): number | undefined => {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (!TASK_ID_QUERY_PATTERN.test(trimmed)) return undefined;
  const value = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
};

/**
 * `createdBy` — any stored actor (`human:`, `agent:`, `system:`), lowercased
 * like the server's filter. The 80-character bound is the list query's own.
 */
const ACTOR_FILTER_MAX = 80;
const ACTOR_FILTER_PATTERN = /^(human|agent|system):\S+$/;

const parseActor = (raw: string | null): string | undefined => {
  const value = parseBoundedString(raw, ACTOR_FILTER_MAX)?.toLowerCase();
  if (value === undefined) return undefined;
  return ACTOR_FILTER_PATTERN.test(value) ? value : undefined;
};

/* ------------------------------------------------------------------ *
 * Read
 * ------------------------------------------------------------------ */

/**
 * `URLSearchParams` → validated list state. Pure, and exported without the hook
 * so it can be tested against a literal query string.
 *
 * Never throws and never returns a value the API would 422 on: the two pairs the
 * server refuses together (`assignee` + `assigneeIsNull`, and an inverted date
 * range) are resolved here rather than sent and rejected.
 */
export const parseTaskListParams = (searchParams: URLSearchParams): TaskListParams => {
  const assignee = parseBoundedString(searchParams.get("assignee"), TASK_ASSIGNEE_MAX);
  const assigneeIsNull = parseBoolean(searchParams.get("assigneeIsNull"));

  const createdFrom = parseDate(searchParams.get("createdFrom"));
  const createdTo = parseDate(searchParams.get("createdTo"));
  // An inverted range is a `VALIDATION_ERROR` on the server. Dropping the upper
  // bound keeps the rest of the link working instead of erroring the page.
  const rangeIsValid =
    createdFrom === undefined || createdTo === undefined || createdFrom <= createdTo;

  const parentId = parseTaskId(searchParams.get("parentId"));
  const parentIsNull = parseBoolean(searchParams.get("parentIsNull"));

  return {
    page: parseBoundedInt(searchParams.get("page"), 1, MAX_PAGE) ?? DEFAULT_PAGE,
    pageSize:
      parseBoundedInt(searchParams.get("pageSize"), MIN_PAGE_SIZE, MAX_PAGE_SIZE) ??
      DEFAULT_PAGE_SIZE,
    sort: parseSort(searchParams.get("sort")),
    status: parseEnumList(TASK_STATUSES, searchParams.getAll("status")),
    priority: parseEnumList(TASK_PRIORITIES, searchParams.getAll("priority")),
    project: parseProjects(searchParams.getAll("project")),
    label: parseLabels(searchParams.getAll("label")),
    assignee,
    // Mutually exclusive on the wire. `assignee` wins because it is the more
    // specific of the two; the UI models both as one control, so this only ever
    // fires for a hand-edited URL.
    assigneeIsNull: assignee === undefined ? assigneeIsNull : undefined,
    createdBy: parseActor(searchParams.get("createdBy")),
    q: parseBoundedString(searchParams.get("q"), TASK_Q_MAX),
    createdFrom,
    createdTo: rangeIsValid ? createdTo : undefined,
    parentId,
    // Mutually exclusive on the wire, same reasoning as assignee/assigneeIsNull.
    parentIsNull: parentId === undefined ? parentIsNull : undefined,
    dependsOn: parseTaskId(searchParams.get("dependsOn")),
    dependencyOf: parseTaskId(searchParams.get("dependencyOf")),
  };
};

/**
 * True when any filter (not paging, not sorting, not `project`) is set.
 *
 * `project` is the header's scope (`ProjectSwitcher`), not one of the filter
 * bar's filters, so it is neither counted here nor cleared by "Clear all": a
 * user looking at one repository's list who clears the status filter is
 * still looking at that repository.
 */
export const hasActiveFilters = (params: TaskListParams): boolean =>
  params.status.length > 0 ||
  params.priority.length > 0 ||
  params.label.length > 0 ||
  params.assignee !== undefined ||
  params.assigneeIsNull !== undefined ||
  params.createdBy !== undefined ||
  params.q !== undefined ||
  params.createdFrom !== undefined ||
  params.createdTo !== undefined ||
  params.parentId !== undefined ||
  params.parentIsNull !== undefined ||
  params.dependsOn !== undefined ||
  params.dependencyOf !== undefined;

/** How many filter *controls* are active — the count on the mobile Filters button. */
export const activeFilterCount = (params: TaskListParams): number =>
  (params.status.length > 0 ? 1 : 0) +
  (params.priority.length > 0 ? 1 : 0) +
  (params.label.length > 0 ? 1 : 0) +
  (params.assignee !== undefined || params.assigneeIsNull !== undefined ? 1 : 0) +
  (params.createdBy !== undefined ? 1 : 0) +
  (params.q !== undefined ? 1 : 0) +
  (params.createdFrom !== undefined ? 1 : 0) +
  (params.createdTo !== undefined ? 1 : 0) +
  (params.parentId !== undefined || params.parentIsNull !== undefined ? 1 : 0) +
  (params.dependsOn !== undefined ? 1 : 0) +
  (params.dependencyOf !== undefined ? 1 : 0);

/* ------------------------------------------------------------------ *
 * Write
 * ------------------------------------------------------------------ */

/**
 * Validated state → `URLSearchParams`, preserving any key this module does not
 * own.
 *
 * Values equal to their default are omitted, so the landing URL is a bare
 * `/tasks` rather than `/tasks?page=1&pageSize=20&sort=createdAt%3Adesc`.
 */
export const serializeTaskListParams = (
  params: TaskListParams,
  previous?: URLSearchParams,
): URLSearchParams => {
  const next = new URLSearchParams();

  if (params.page !== DEFAULT_PAGE) next.set("page", String(params.page));
  if (params.pageSize !== DEFAULT_PAGE_SIZE) next.set("pageSize", String(params.pageSize));
  if (
    params.sort.field !== DEFAULT_SORT.field ||
    params.sort.direction !== DEFAULT_SORT.direction
  ) {
    next.set("sort", formatTaskSort(params.sort));
  }

  for (const value of params.status) next.append("status", value);
  for (const value of params.priority) next.append("priority", value);
  for (const value of params.project) next.append("project", value);
  for (const value of params.label) next.append("label", value);

  if (params.assignee !== undefined) next.set("assignee", params.assignee);
  else if (params.assigneeIsNull !== undefined) {
    next.set("assigneeIsNull", String(params.assigneeIsNull));
  }

  if (params.createdBy !== undefined) next.set("createdBy", params.createdBy);
  if (params.q !== undefined) next.set("q", params.q);
  if (params.createdFrom !== undefined) next.set("createdFrom", params.createdFrom);
  if (params.createdTo !== undefined) next.set("createdTo", params.createdTo);

  if (params.parentId !== undefined) next.set("parentId", String(params.parentId));
  else if (params.parentIsNull !== undefined) {
    next.set("parentIsNull", String(params.parentIsNull));
  }
  if (params.dependsOn !== undefined) next.set("dependsOn", String(params.dependsOn));
  if (params.dependencyOf !== undefined) next.set("dependencyOf", String(params.dependencyOf));

  // Anything we do not own rides along untouched — a campaign tag on a shared
  // link survives the recipient clicking "next page".
  if (previous !== undefined) {
    const owned = new Set<string>(TASK_LIST_PARAM_KEYS);
    for (const [key, value] of previous.entries()) {
      if (!owned.has(key)) next.append(key, value);
    }
  }

  return next;
};

/* ------------------------------------------------------------------ *
 * The hook
 * ------------------------------------------------------------------ */

/**
 * A filter change, either as a patch or as a function of the current state.
 *
 * The function form is not sugar. Anything derived from the *previous* value of
 * a filter — toggling one status out of the four, removing one chip — must be
 * computed when the write happens, not when the control rendered. A control that
 * closes over its render-time array and hands back a whole new array silently
 * discards any change that landed in between.
 */
export type TaskListFilterPatch =
  Partial<TaskListFilters> | ((current: TaskListParams) => Partial<TaskListFilters>);

export type TaskListParamsApi = {
  params: TaskListParams;
  /** Page only. Filters and sort are untouched — this is the other half of the rule. */
  setPage: (page: number) => void;
  /** Resets `page` to 1: a smaller page size can put the current page past the end. */
  setPageSize: (pageSize: number) => void;
  /** Resets `page` to 1. */
  setSort: (sort: TaskSort) => void;
  /**
   * Merges a filter patch and resets `page` to 1.
   *
   * `replace` is for the debounced search box: typing "printer" would otherwise
   * push seven history entries and the back button would walk them one keystroke
   * at a time.
   */
  setFilters: (patch: TaskListFilterPatch, options?: { replace?: boolean }) => void;
  /** Clears every filter. Keeps sort and page size — those are preferences, not filters. */
  clearFilters: () => void;
  hasActiveFilters: boolean;
  activeFilterCount: number;
};

export const useTaskListParams = (): TaskListParamsApi => {
  const [searchParams, setSearchParams] = useSearchParams();

  const params = useMemo(() => parseTaskListParams(searchParams), [searchParams]);

  /**
   * The base every mutation builds on, and the last committed URL we have seen.
   *
   * **`setSearchParams`'s functional form does not do what its name suggests.**
   * In `react-router@7.18.2` it is
   * `useCallback((nextInit) => …nextInit(new URLSearchParams(searchParams))…, [navigate, searchParams])`
   * — the updater is handed the `searchParams` captured in the render that
   * created the callback, not the URL as it stands when the update runs. It is
   * `useState`'s signature without `useState`'s guarantee, which is worse than
   * no functional form at all, because it reads as protection.
   *
   * Navigation also runs inside a transition, so the gap between "we wrote" and
   * "the location re-rendered" spans frames, not microtasks. Two writes inside
   * it (a debounced `q` landing as a status chip is clicked) would both build on
   * the same stale base and the second would drop the first.
   *
   * So the base is kept here and advanced **synchronously on write**, and
   * resynced whenever the committed URL differs from what we last saw — which is
   * how a Back press or any other external navigation takes over again.
   */
  const baseRef = useRef(searchParams);

  /**
   * The resync, in an effect rather than during render — refs are not read or
   * written while rendering (`react-hooks/refs`), and an effect is the correct
   * ordering anyway: every write below happens in an event handler, which cannot
   * run before the effects of the render that drew the control being clicked.
   *
   * `searchParams` is a `useMemo` on `location.search`, so this fires when the
   * URL actually moves rather than on every render.
   */
  useEffect(() => {
    baseRef.current = searchParams;
  }, [searchParams]);

  /**
   * `setSearchParams` changes identity on every location change, so calling it
   * through a ref is what keeps `update` — and therefore every setter below —
   * referentially stable for the life of the component. The search box's
   * debounce effect lists its commit callback in its dependencies; an unstable
   * one tears the timer down and rebuilds it on every URL change, so a 300ms
   * debounce would never fire while anything else was writing.
   */
  const setSearchParamsRef = useRef(setSearchParams);

  useEffect(() => {
    setSearchParamsRef.current = setSearchParams;
  }, [setSearchParams]);

  const update = useCallback(
    (mutate: (current: TaskListParams) => TaskListParams, options: { replace?: boolean } = {}) => {
      const base = baseRef.current;
      const next = serializeTaskListParams(mutate(parseTaskListParams(base)), base);

      // Advance the base before navigating, so a second write in the same frame
      // sees this one.
      baseRef.current = next;
      setSearchParamsRef.current(next, { replace: options.replace ?? false });
    },
    [],
  );

  const setPage = useCallback(
    (page: number) => update((current) => ({ ...current, page })),
    [update],
  );

  const setPageSize = useCallback(
    (pageSize: number) => update((current) => ({ ...current, pageSize, page: DEFAULT_PAGE })),
    [update],
  );

  const setSort = useCallback(
    (sort: TaskSort) => update((current) => ({ ...current, sort, page: DEFAULT_PAGE })),
    [update],
  );

  const setFilters = useCallback(
    (patch: TaskListFilterPatch, options?: { replace?: boolean }) =>
      update((current) => {
        // Resolved against the *current* state inside the update, which is the
        // whole point of allowing the function form.
        const resolved = typeof patch === "function" ? patch(current) : patch;
        const merged = { ...current, ...resolved, page: DEFAULT_PAGE };

        // Keep the exclusion invariant across a partial patch: setting one of
        // the pair must clear the other, or the next request is a 422.
        if (resolved.assignee !== undefined) return { ...merged, assigneeIsNull: undefined };
        if (resolved.assigneeIsNull !== undefined) return { ...merged, assignee: undefined };

        // Same invariant for the other mutually-exclusive pair.
        if (resolved.parentId !== undefined) return { ...merged, parentIsNull: undefined };
        if (resolved.parentIsNull !== undefined) return { ...merged, parentId: undefined };

        /*
          Keep the date range ordered by *moving* the other bound rather than
          letting the parse drop it.

          `min`/`max` on `<input type="date">` only mark a value invalid — a
          typed one still commits — so "Created to = Aug 1" followed by a typed
          "Created from = Sep 1" is reachable by clicking. Dropping `createdTo`
          at parse time then empties a field and its chip with no explanation,
          while the discarded value is still sitting in the address bar. Dragging
          the far bound along says what happened. The parse-time drop stays as
          the backstop for a hand-typed URL, where there is no interaction to
          attribute an intent to.
        */
        if (resolved.createdFrom !== undefined && merged.createdTo !== undefined) {
          if (merged.createdFrom !== undefined && merged.createdFrom > merged.createdTo) {
            return { ...merged, createdTo: merged.createdFrom };
          }
        }
        if (resolved.createdTo !== undefined && merged.createdFrom !== undefined) {
          if (merged.createdTo !== undefined && merged.createdTo < merged.createdFrom) {
            return { ...merged, createdFrom: merged.createdTo };
          }
        }

        return merged;
      }, options),
    [update],
  );

  const clearFilters = useCallback(
    () =>
      update((current) => ({
        ...DEFAULT_TASK_LIST_PARAMS,
        // Sort and page size survive: a user who chose 50-per-page and sorted by
        // priority did not ask for that to be undone by "clear filters".
        pageSize: current.pageSize,
        sort: current.sort,
        // The header's scope, not a filter — see `hasActiveFilters`.
        project: current.project,
      })),
    [update],
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
  };
};
