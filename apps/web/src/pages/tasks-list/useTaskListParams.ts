import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  DEFAULT_TICKET_SORT_DIRECTION,
  DEFAULT_TICKET_SORT_FIELD,
  MAX_PAGE,
  MAX_PAGE_SIZE,
  MIN_PAGE_SIZE,
  SORT_DIRECTIONS,
  TICKET_ASSIGNEE_MAX,
  TICKET_CATEGORIES,
  TICKET_EMAIL_MAX,
  TICKET_PRIORITIES,
  TICKET_Q_MAX,
  TICKET_SORT_FIELDS,
  TICKET_STATUSES,
  formatTicketSort,
  type SortDirection,
  type TicketCategory,
  type TicketPriority,
  type TicketSort,
  type TicketSortField,
  type TicketStatus,
} from "@helpdesk/contracts";

/**
 * The list screen's state, which **is** the URL.
 *
 * Two rules govern this module, and both are bugs the moment they are relaxed:
 *
 * 1. **It picks the keys it knows and validates them one at a time.** It does
 *    *not* feed `useSearchParams()` into `ticketListQuerySchema`, which is
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
export const TICKET_LIST_PARAM_KEYS = [
  "page",
  "pageSize",
  "sort",
  "status",
  "priority",
  "category",
  "assignee",
  "assigneeIsNull",
  "requesterEmail",
  "q",
  "createdFrom",
  "createdTo",
] as const;

export type TicketListParamKey = (typeof TICKET_LIST_PARAM_KEYS)[number];

export type TicketListParams = {
  page: number;
  pageSize: number;
  sort: TicketSort;
  status: TicketStatus[];
  priority: TicketPriority[];
  category: TicketCategory[];
  assignee: string | undefined;
  assigneeIsNull: boolean | undefined;
  requesterEmail: string | undefined;
  q: string | undefined;
  createdFrom: string | undefined;
  createdTo: string | undefined;
};

/** The filter subset — everything a change to which resets `page`. */
export type TicketListFilters = Omit<TicketListParams, "page" | "pageSize" | "sort">;

export const DEFAULT_SORT: TicketSort = {
  field: DEFAULT_TICKET_SORT_FIELD,
  direction: DEFAULT_TICKET_SORT_DIRECTION,
};

export const DEFAULT_TICKET_LIST_PARAMS: TicketListParams = {
  page: DEFAULT_PAGE,
  pageSize: DEFAULT_PAGE_SIZE,
  sort: DEFAULT_SORT,
  status: [],
  priority: [],
  category: [],
  assignee: undefined,
  assigneeIsNull: undefined,
  requesterEmail: undefined,
  q: undefined,
  createdFrom: undefined,
  createdTo: undefined,
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
 * `?status=open&status=nonsense&status=open` → `["open"]`. Invalid entries are
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

const parseSort = (raw: string | null): TicketSort => {
  if (raw === null) return DEFAULT_SORT;
  const [field, direction, ...rest] = raw.trim().split(":");
  if (field === undefined || direction === undefined || rest.length > 0) return DEFAULT_SORT;

  const sortField: TicketSortField | undefined = oneOf(TICKET_SORT_FIELDS, field);
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

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const parseEmail = (raw: string | null): string | undefined => {
  const value = parseBoundedString(raw, TICKET_EMAIL_MAX)?.toLowerCase();
  if (value === undefined) return undefined;
  return EMAIL_PATTERN.test(value) ? value : undefined;
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
export const parseTicketListParams = (searchParams: URLSearchParams): TicketListParams => {
  const assignee = parseBoundedString(searchParams.get("assignee"), TICKET_ASSIGNEE_MAX);
  const assigneeIsNull = parseBoolean(searchParams.get("assigneeIsNull"));

  const createdFrom = parseDate(searchParams.get("createdFrom"));
  const createdTo = parseDate(searchParams.get("createdTo"));
  // An inverted range is a `VALIDATION_ERROR` on the server. Dropping the upper
  // bound keeps the rest of the link working instead of erroring the page.
  const rangeIsValid =
    createdFrom === undefined || createdTo === undefined || createdFrom <= createdTo;

  return {
    page: parseBoundedInt(searchParams.get("page"), 1, MAX_PAGE) ?? DEFAULT_PAGE,
    pageSize:
      parseBoundedInt(searchParams.get("pageSize"), MIN_PAGE_SIZE, MAX_PAGE_SIZE) ??
      DEFAULT_PAGE_SIZE,
    sort: parseSort(searchParams.get("sort")),
    status: parseEnumList(TICKET_STATUSES, searchParams.getAll("status")),
    priority: parseEnumList(TICKET_PRIORITIES, searchParams.getAll("priority")),
    category: parseEnumList(TICKET_CATEGORIES, searchParams.getAll("category")),
    assignee,
    // Mutually exclusive on the wire. `assignee` wins because it is the more
    // specific of the two; the UI models both as one control, so this only ever
    // fires for a hand-edited URL.
    assigneeIsNull: assignee === undefined ? assigneeIsNull : undefined,
    requesterEmail: parseEmail(searchParams.get("requesterEmail")),
    q: parseBoundedString(searchParams.get("q"), TICKET_Q_MAX),
    createdFrom,
    createdTo: rangeIsValid ? createdTo : undefined,
  };
};

/** True when any filter (not paging, not sorting) is set. */
export const hasActiveFilters = (params: TicketListParams): boolean =>
  params.status.length > 0 ||
  params.priority.length > 0 ||
  params.category.length > 0 ||
  params.assignee !== undefined ||
  params.assigneeIsNull !== undefined ||
  params.requesterEmail !== undefined ||
  params.q !== undefined ||
  params.createdFrom !== undefined ||
  params.createdTo !== undefined;

/** How many filter *controls* are active — the count on the mobile Filters button. */
export const activeFilterCount = (params: TicketListParams): number =>
  (params.status.length > 0 ? 1 : 0) +
  (params.priority.length > 0 ? 1 : 0) +
  (params.category.length > 0 ? 1 : 0) +
  (params.assignee !== undefined || params.assigneeIsNull !== undefined ? 1 : 0) +
  (params.requesterEmail !== undefined ? 1 : 0) +
  (params.q !== undefined ? 1 : 0) +
  (params.createdFrom !== undefined ? 1 : 0) +
  (params.createdTo !== undefined ? 1 : 0);

/* ------------------------------------------------------------------ *
 * Write
 * ------------------------------------------------------------------ */

/**
 * Validated state → `URLSearchParams`, preserving any key this module does not
 * own.
 *
 * Values equal to their default are omitted, so the landing URL is a bare
 * `/tickets` rather than `/tickets?page=1&pageSize=20&sort=createdAt%3Adesc`.
 */
export const serializeTicketListParams = (
  params: TicketListParams,
  previous?: URLSearchParams,
): URLSearchParams => {
  const next = new URLSearchParams();

  if (params.page !== DEFAULT_PAGE) next.set("page", String(params.page));
  if (params.pageSize !== DEFAULT_PAGE_SIZE) next.set("pageSize", String(params.pageSize));
  if (
    params.sort.field !== DEFAULT_SORT.field ||
    params.sort.direction !== DEFAULT_SORT.direction
  ) {
    next.set("sort", formatTicketSort(params.sort));
  }

  for (const value of params.status) next.append("status", value);
  for (const value of params.priority) next.append("priority", value);
  for (const value of params.category) next.append("category", value);

  if (params.assignee !== undefined) next.set("assignee", params.assignee);
  else if (params.assigneeIsNull !== undefined) {
    next.set("assigneeIsNull", String(params.assigneeIsNull));
  }

  if (params.requesterEmail !== undefined) next.set("requesterEmail", params.requesterEmail);
  if (params.q !== undefined) next.set("q", params.q);
  if (params.createdFrom !== undefined) next.set("createdFrom", params.createdFrom);
  if (params.createdTo !== undefined) next.set("createdTo", params.createdTo);

  // Anything we do not own rides along untouched — a campaign tag on a shared
  // link survives the recipient clicking "next page".
  if (previous !== undefined) {
    const owned = new Set<string>(TICKET_LIST_PARAM_KEYS);
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
export type TicketListFilterPatch =
  Partial<TicketListFilters> | ((current: TicketListParams) => Partial<TicketListFilters>);

export type TicketListParamsApi = {
  params: TicketListParams;
  /** Page only. Filters and sort are untouched — this is the other half of the rule. */
  setPage: (page: number) => void;
  /** Resets `page` to 1: a smaller page size can put the current page past the end. */
  setPageSize: (pageSize: number) => void;
  /** Resets `page` to 1. */
  setSort: (sort: TicketSort) => void;
  /**
   * Merges a filter patch and resets `page` to 1.
   *
   * `replace` is for the debounced search box: typing "printer" would otherwise
   * push seven history entries and the back button would walk them one keystroke
   * at a time.
   */
  setFilters: (patch: TicketListFilterPatch, options?: { replace?: boolean }) => void;
  /** Clears every filter. Keeps sort and page size — those are preferences, not filters. */
  clearFilters: () => void;
  hasActiveFilters: boolean;
  activeFilterCount: number;
};

export const useTicketListParams = (): TicketListParamsApi => {
  const [searchParams, setSearchParams] = useSearchParams();

  const params = useMemo(() => parseTicketListParams(searchParams), [searchParams]);

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
    (
      mutate: (current: TicketListParams) => TicketListParams,
      options: { replace?: boolean } = {},
    ) => {
      const base = baseRef.current;
      const next = serializeTicketListParams(mutate(parseTicketListParams(base)), base);

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
    (sort: TicketSort) => update((current) => ({ ...current, sort, page: DEFAULT_PAGE })),
    [update],
  );

  const setFilters = useCallback(
    (patch: TicketListFilterPatch, options?: { replace?: boolean }) =>
      update((current) => {
        // Resolved against the *current* state inside the update, which is the
        // whole point of allowing the function form.
        const resolved = typeof patch === "function" ? patch(current) : patch;
        const merged = { ...current, ...resolved, page: DEFAULT_PAGE };

        // Keep the exclusion invariant across a partial patch: setting one of
        // the pair must clear the other, or the next request is a 422.
        if (resolved.assignee !== undefined) return { ...merged, assigneeIsNull: undefined };
        if (resolved.assigneeIsNull !== undefined) return { ...merged, assignee: undefined };

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
        ...DEFAULT_TICKET_LIST_PARAMS,
        // Sort and page size survive: a user who chose 50-per-page and sorted by
        // priority did not ask for that to be undone by "clear filters".
        pageSize: current.pageSize,
        sort: current.sort,
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
