import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { formatTicketSort, type PaginatedTickets, type TicketFacets } from "@helpdesk/contracts";
import { api, type QueryInput } from "@/api/http";
import { queryKeys } from "@/api/queryKeys";
import { type TicketListParams } from "@/pages/tickets-list/useTicketListParams";

/**
 * Ticket read endpoints and their query hooks.
 *
 * Response types come from `@helpdesk/contracts` — never a hand-written
 * interface mirroring the API. The client does not re-`parse()` the body: the
 * server already validated it on the way out, and a `.parse()` here would turn a
 * new optional field on a healthy response into a blank screen.
 */

/* ------------------------------------------------------------------ *
 * Request shaping
 * ------------------------------------------------------------------ */

/**
 * Validated URL state → the wire query.
 *
 * This is the boundary where "the URL may contain anything" becomes "the request
 * contains only what `ticketListQuerySchema` accepts". Unknown keys picked up
 * from a shared link never reach it, which is what lets the server stay
 * `.strict()`.
 *
 * Absent filters are omitted rather than sent empty: `?status=` is dropped by
 * the server's preprocessor anyway, but an omitted key keeps the query key —
 * and therefore the cache entry — free of noise.
 */
export const toTicketListQuery = (params: TicketListParams): QueryInput => ({
  page: params.page,
  pageSize: params.pageSize,
  sort: formatTicketSort(params.sort),
  ...(params.status.length > 0 ? { status: params.status } : {}),
  ...(params.priority.length > 0 ? { priority: params.priority } : {}),
  ...(params.category.length > 0 ? { category: params.category } : {}),
  ...(params.assignee === undefined ? {} : { assignee: params.assignee }),
  ...(params.assigneeIsNull === undefined ? {} : { assigneeIsNull: params.assigneeIsNull }),
  ...(params.requesterEmail === undefined ? {} : { requesterEmail: params.requesterEmail }),
  ...(params.q === undefined ? {} : { q: params.q }),
  ...(params.createdFrom === undefined ? {} : { createdFrom: params.createdFrom }),
  ...(params.createdTo === undefined ? {} : { createdTo: params.createdTo }),
});

/* ------------------------------------------------------------------ *
 * Fetchers
 * ------------------------------------------------------------------ */

export const listTickets = (query: QueryInput, signal?: AbortSignal): Promise<PaginatedTickets> =>
  api.get<PaginatedTickets>("/tickets", { query, signal });

export const getTicketFacets = (signal?: AbortSignal): Promise<TicketFacets> =>
  api.get<TicketFacets>("/tickets/facets", { signal });

/* ------------------------------------------------------------------ *
 * Hooks
 * ------------------------------------------------------------------ */

/**
 * One page of tickets for the current URL state.
 *
 * `placeholderData: keepPreviousData` is what makes the "dim, don't blank" rule
 * possible: on a page or filter change the previous rows stay mounted while the
 * next ones load, and `isPlaceholderData` tells the page to dim them and set
 * `aria-busy`. Without it the table unmounts to a skeleton on every click, which
 * reads as a page reload.
 */
export const useTicketsQuery = (params: TicketListParams): UseQueryResult<PaginatedTickets> => {
  const query = toTicketListQuery(params);

  return useQuery({
    // The key is the *request*, not the URL: two URLs differing only in an
    // unknown key are one cache entry, which is correct — they are one request.
    queryKey: queryKeys.tickets.list(query),
    queryFn: ({ signal }) => listTickets(query, signal),
    placeholderData: keepPreviousData,
  });
};

/**
 * The assignee and category option lists.
 *
 * The **only** source of assignee options. `assignee` is matched exactly and
 * case-sensitively (SQLite has no `mode: "insensitive"`), so the client has to
 * send a string the database actually stores — a free-text box would turn
 * "alice patel" into a silently empty result set.
 *
 * Five-minute `staleTime`: the set of people with a ticket assigned changes on
 * the order of days, and this fires on every list-page mount.
 */
export const useTicketFacetsQuery = (): UseQueryResult<TicketFacets> =>
  useQuery({
    queryKey: queryKeys.tickets.facets(),
    queryFn: ({ signal }) => getTicketFacets(signal),
    staleTime: 5 * 60_000,
  });
