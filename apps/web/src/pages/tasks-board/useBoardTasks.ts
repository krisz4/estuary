import { useCallback, useMemo, useState } from "react";
import { keepPreviousData, useQueries } from "@tanstack/react-query";
import {
  MAX_PAGE_SIZE,
  TICKET_STATUSES,
  type TicketStatus,
  type TicketSummary,
} from "@helpdesk/contracts";
import { listTickets, toTicketListQuery } from "@/api/tickets";
import { queryKeys } from "@/api/queryKeys";
import { type TicketListParams } from "@/pages/tickets-list/useTicketListParams";

/**
 * The board's data layer: four status-filtered list queries, the per-column
 * "load more" depth, and the in-flight moves that make a drop feel instant.
 *
 * ## Why four queries instead of one
 *
 * A board is four independently-sized queues. One `GET /tickets` big enough to
 * fill every column would have to be sorted globally and then split client-side,
 * so a board with 400 closed tickets and 3 open ones would either fetch all 403
 * rows or show an empty "Open" column — the paging would be spent on the column
 * nobody is looking at. Four queries let each column page on its own and give
 * each one an honest `meta.total` for its header count, which is the number
 * people actually read off a board.
 *
 * They go through `toTicketListQuery` and `queryKeys.tickets.list()` like every
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
 * A rejected move (the server owns the transition table — see
 * `lib/statusTransition.ts`) is a single `delete` from that map, and the card is
 * back where it came from with no rollback bookkeeping at all.
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
  status: TicketStatus;
  /** Cards in render order, moved-in cards first. */
  tickets: TicketSummary[];
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

export type BoardTickets = {
  columns: BoardColumn[];
  /** Every fetched ticket by id — the drag overlay's lookup. */
  byId: Map<number, TicketSummary>;
  /** Where a card is *shown*, which during a move is not where it is stored. */
  effectiveStatus: (ticket: TicketSummary) => TicketStatus;
  isPending: boolean;
  /** True while any column is refetching with rows already on screen. */
  isRefreshing: boolean;
  beginMove: (ticketId: number, status: TicketStatus) => void;
  endMove: (ticketId: number) => void;
  pendingMoves: ReadonlyMap<number, TicketStatus>;
};

type Limits = Record<TicketStatus, number>;

const INITIAL_LIMITS: Limits = {
  open: BOARD_COLUMN_PAGE_SIZE,
  in_progress: BOARD_COLUMN_PAGE_SIZE,
  resolved: BOARD_COLUMN_PAGE_SIZE,
  closed: BOARD_COLUMN_PAGE_SIZE,
};

export const useBoardTickets = (params: TicketListParams): BoardTickets => {
  const [limits, setLimits] = useState<Limits>(INITIAL_LIMITS);

  /**
   * `ticketId → the status it was dropped on`, for moves the server has not
   * confirmed yet. Held as a `Map` in state rather than a ref: the board has to
   * re-render when it changes, which is the entire point of it.
   */
  const [pendingMoves, setPendingMoves] = useState<ReadonlyMap<number, TicketStatus>>(new Map());

  const beginMove = useCallback((ticketId: number, status: TicketStatus) => {
    setPendingMoves((current) => new Map(current).set(ticketId, status));
  }, []);

  const endMove = useCallback((ticketId: number) => {
    setPendingMoves((current) => {
      if (!current.has(ticketId)) return current;
      const next = new Map(current);
      next.delete(ticketId);
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
    queries: TICKET_STATUSES.map((status) => {
      const query = toTicketListQuery({
        ...params,
        status: [status],
        page: 1,
        pageSize: limits[status],
      });

      return {
        queryKey: queryKeys.tickets.list(query),
        queryFn: ({ signal }: { signal: AbortSignal }) => listTickets(query, signal),
        placeholderData: keepPreviousData,
      };
    }),
  });

  const byId = useMemo(() => {
    const map = new Map<number, TicketSummary>();
    for (const query of queries) {
      for (const ticket of query.data?.data ?? []) map.set(ticket.id, ticket);
    }
    return map;
  }, [queries]);

  const effectiveStatus = useCallback(
    (ticket: TicketSummary): TicketStatus => pendingMoves.get(ticket.id) ?? ticket.status,
    [pendingMoves],
  );

  const columns = useMemo<BoardColumn[]>(
    () =>
      TICKET_STATUSES.map((status, index) => {
        const query = queries[index]!;
        const fetched = query.data?.data ?? [];

        const stayed = fetched.filter((ticket) => effectiveStatus(ticket) === status);

        /*
          Cards that are on their way here from another column. They go first: a
          dropped card has to be findable, and the sort position it will occupy
          once the server answers is not knowable from here (a `priority:desc`
          board cannot place it without re-sorting a page it only partly holds).
          Top is the one position that is always predictable.

          The test is **"not already in this column's fetched rows"**, not "its
          stored status is not this column's". Those coincide today, and the
          difference is the whole safety margin: the moment anything writes a
          moved ticket's new status into a cached list page — an optimistic write
          added later, a refetch landing between the drop and the cleanup — the
          status test stops matching, `stayed` does not have the row either
          (it is in the *source* column's page, not this one's), and the card
          vanishes from the board entirely. Identity is the thing actually being
          asked about here, so identity is what is compared.
        */
        const fetchedIds = new Set(fetched.map((ticket) => ticket.id));
        const movedIn = [...byId.values()].filter(
          (ticket) => !fetchedIds.has(ticket.id) && pendingMoves.get(ticket.id) === status,
        );

        /*
          The header count has to move with the card, or dragging one ticket out
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
          tickets: [...movedIn, ...stayed],
          total,
          isPending: query.isPending,
          isRefreshing: (query.isFetching && !query.isPending) || query.isPlaceholderData,
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
    isPending: queries.some((query) => query.isPending),
    isRefreshing: columns.some((column) => column.isRefreshing),
    beginMove,
    endMove,
    pendingMoves,
  };
};
