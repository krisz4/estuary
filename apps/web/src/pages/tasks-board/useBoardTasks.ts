import { useCallback, useMemo, useState } from "react";
import { keepPreviousData, useQueries } from "@tanstack/react-query";
import {
  MAX_PAGE_SIZE,
  TASK_STATUS_LANES,
  TASK_STATUSES,
  type TaskStatus,
  type TaskSummary,
} from "@helpdesk/contracts";
import { POLL_INTERVAL_MS } from "@/api/polling";
import { listTasks, toTaskListQuery } from "@/api/tasks";
import { queryKeys } from "@/api/queryKeys";
import { type TaskListParams } from "@/pages/tasks-list/useTaskListParams";

/**
 * The board's data layer: one status-filtered list query per column, the
 * per-column "load more" depth, and the in-flight moves that make a drop feel
 * instant.
 *
 * ## Why one query per column instead of one
 *
 * A board is ten independently-sized queues. One `GET /tasks` big enough to
 * fill every column would have to be sorted globally and then split client-side,
 * so a board with 400 done tasks and 3 in the backlog would either fetch all 403
 * rows or show an empty "Backlog" column — the paging would be spent on the
 * column nobody is looking at. A query per column lets each one page on its own
 * and gives each an honest `meta.total` for its header count, which is the
 * number people actually read off a board.
 *
 * The closed lane's two queries run only while that lane is expanded
 * (`closedLaneOpen`): it is collapsed by default, and the done pile is the one
 * that grows without bound.
 *
 * Every column polls (`api/polling.ts`), so a card an agent moves shows up in
 * its new column without a reload.
 *
 * They go through `toTaskListQuery` and `queryKeys.tasks.list()` like every
 * other list request, so a board column and a list page under the same filters
 * are one cache entry rather than two views disagreeing about the same rows.
 *
 * ## Why the optimistic move lives here and not in the cache
 *
 * A move changes which *query* a row belongs to. Writing it optimistically means
 * splicing a row out of one cached page, into another, and adjusting both
 * `meta.total`s — for entries whose filters and page size the caller chose. The
 * board keeps the in-flight move in `pendingMoves` instead and derives the
 * columns through it, so the card is in its new column on the next frame and the
 * cache is never a place where a half-applied truth can be read.
 *
 * A rejected move — or a transition dialog the user cancels — is a single
 * `delete` from that map, and the card is back where it came from with no
 * rollback bookkeeping at all.
 */

/** Rows fetched per column on first load, and the step "Load more" adds. */
export const BOARD_COLUMN_PAGE_SIZE = 25;

/**
 * The ceiling on a column, imposed by `MAX_PAGE_SIZE` — the API rejects a larger
 * `pageSize` rather than clamping it. Past this, filtering is the answer, and
 * the column says so.
 */
export const BOARD_COLUMN_MAX = MAX_PAGE_SIZE;

export type BoardColumn = {
  status: TaskStatus;
  /** Cards in render order, moved-in cards first. */
  tasks: TaskSummary[];
  /** The header count: the server's total, corrected for in-flight moves. */
  total: number;
  isPending: boolean;
  isRefreshing: boolean;
  error: unknown;
  /** True when the server has rows this column has not fetched yet. */
  hasMore: boolean;
  /** False once the column is at `BOARD_COLUMN_MAX` — "Load more" cannot help. */
  canLoadMore: boolean;
  loadMore: () => void;
  refetch: () => void;
};

export type BoardTasks = {
  columns: BoardColumn[];
  /** Every fetched task by id — the drag overlay's lookup. */
  byId: Map<number, TaskSummary>;
  /** Where a card is *shown*, which during a move is not where it is stored. */
  effectiveStatus: (task: TaskSummary) => TaskStatus;
  isPending: boolean;
  /** True while any column is refetching with rows already on screen. */
  isRefreshing: boolean;
  beginMove: (taskId: number, status: TaskStatus) => void;
  endMove: (taskId: number) => void;
  pendingMoves: ReadonlyMap<number, TaskStatus>;
};

type Limits = Record<TaskStatus, number>;

const INITIAL_LIMITS = Object.fromEntries(
  TASK_STATUSES.map((status) => [status, BOARD_COLUMN_PAGE_SIZE]),
) as Limits;

const CLOSED_LANE: readonly TaskStatus[] = TASK_STATUS_LANES.closed;

export const useBoardTasks = (
  params: TaskListParams,
  { closedLaneOpen }: { closedLaneOpen: boolean },
): BoardTasks => {
  const [limits, setLimits] = useState<Limits>(INITIAL_LIMITS);

  /**
   * `taskId → the status it was dropped on`, for moves the server has not
   * confirmed yet. Held as a `Map` in state rather than a ref: the board has to
   * re-render when it changes, which is the entire point of it.
   */
  const [pendingMoves, setPendingMoves] = useState<ReadonlyMap<number, TaskStatus>>(new Map());

  const beginMove = useCallback((taskId: number, status: TaskStatus) => {
    setPendingMoves((current) => new Map(current).set(taskId, status));
  }, []);

  const endMove = useCallback((taskId: number) => {
    setPendingMoves((current) => {
      if (!current.has(taskId)) return current;
      const next = new Map(current);
      next.delete(taskId);
      return next;
    });
  }, []);

  /**
   * One query per status. `page` is pinned to 1 and `status` is replaced by the
   * column's own value — the board has no pager, and the list page's status
   * filter is meaningless here because the columns *are* the status filter.
   *
   * `placeholderData: keepPreviousData` for the same reason the list page uses
   * it: changing a filter must dim the board, not tear all four columns down to
   * skeletons.
   */
  const queries = useQueries({
    queries: TASK_STATUSES.map((status) => {
      const query = toTaskListQuery({
        ...params,
        status: [status],
        page: 1,
        pageSize: limits[status],
      });

      return {
        queryKey: queryKeys.tasks.list(query),
        queryFn: ({ signal }: { signal: AbortSignal }) => listTasks(query, signal),
        placeholderData: keepPreviousData,
        refetchInterval: POLL_INTERVAL_MS,
        enabled: closedLaneOpen || !CLOSED_LANE.includes(status),
      };
    }),
  });

  const byId = useMemo(() => {
    const map = new Map<number, TaskSummary>();
    for (const query of queries) {
      for (const task of query.data?.data ?? []) map.set(task.id, task);
    }
    return map;
  }, [queries]);

  const effectiveStatus = useCallback(
    (task: TaskSummary): TaskStatus => pendingMoves.get(task.id) ?? task.status,
    [pendingMoves],
  );

  const columns = useMemo<BoardColumn[]>(
    () =>
      TASK_STATUSES.map((status, index) => {
        const query = queries[index]!;
        const fetched = query.data?.data ?? [];

        const stayed = fetched.filter((task) => effectiveStatus(task) === status);

        /*
          Cards that are on their way here from another column. They go first: a
          dropped card has to be findable, and the sort position it will occupy
          once the server answers is not knowable from here (a `priority:desc`
          board cannot place it without re-sorting a page it only partly holds).
          Top is the one position that is always predictable.

          The test is **"not already in this column's fetched rows"**, not "its
          stored status is not this column's". Those coincide today, and the
          difference is the whole safety margin: the moment anything writes a
          moved task's new status into a cached list page — an optimistic write
          added later, a refetch landing between the drop and the cleanup — the
          status test stops matching, `stayed` does not have the row either
          (it is in the *source* column's page, not this one's), and the card
          vanishes from the board entirely. Identity is the thing actually being
          asked about here, so identity is what is compared.
        */
        const fetchedIds = new Set(fetched.map((task) => task.id));
        const movedIn = [...byId.values()].filter(
          (task) => !fetchedIds.has(task.id) && pendingMoves.get(task.id) === status,
        );

        /*
          The header count has to move with the card, or dragging one task out
          of "Open" leaves the column reading "12" over eleven cards until the
          refetch lands. `total` is the server's, so both sides of the move are
          corrected against it rather than recomputed from what is on screen —
          the column may be showing 25 of 300.
        */
        const movedOut = fetched.length - stayed.length;
        const total = (query.data?.meta.total ?? 0) - movedOut + movedIn.length;

        const loaded = fetched.length;
        const limit = limits[status];

        return {
          status,
          tasks: [...movedIn, ...stayed],
          total,
          isPending: query.isPending,
          // Placeholder data only — not every poll. A column that dims itself
          // every fifteen seconds for a refresh that usually changes nothing
          // reads as broken.
          isRefreshing: query.isPlaceholderData,
          error: query.error,
          hasMore: loaded < (query.data?.meta.total ?? 0),
          canLoadMore: limit < BOARD_COLUMN_MAX,
          loadMore: () =>
            setLimits((current) => ({
              ...current,
              [status]: Math.min(current[status] + BOARD_COLUMN_PAGE_SIZE, BOARD_COLUMN_MAX),
            })),
          refetch: () => void query.refetch(),
        };
      }),
    [queries, byId, pendingMoves, effectiveStatus, limits],
  );

  return {
    columns,
    byId,
    effectiveStatus,
    // A disabled (collapsed) query is `pending` forever; it is not loading.
    isPending: queries.some((query) => query.isPending && query.fetchStatus !== "idle"),
    isRefreshing: columns.some((column) => column.isRefreshing),
    beginMove,
    endMove,
    pendingMoves,
  };
};
