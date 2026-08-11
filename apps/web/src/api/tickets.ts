import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  formatTicketSort,
  type CreateTicketInput,
  type PaginatedTickets,
  type Ticket,
  type TicketFacets,
  type TicketStatus,
  type UpdateTicketInput,
} from "@helpdesk/contracts";
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

export const getTicket = (ticketId: number, signal?: AbortSignal): Promise<Ticket> =>
  api.get<Ticket>(`/tickets/${ticketId}`, { signal });

export const createTicket = (input: CreateTicketInput): Promise<Ticket> =>
  api.post<Ticket>("/tickets", input);

export const updateTicket = (ticketId: number, input: UpdateTicketInput): Promise<Ticket> =>
  api.patch<Ticket>(`/tickets/${ticketId}`, input);

export const deleteTicket = (ticketId: number): Promise<void> =>
  api.delete<void>(`/tickets/${ticketId}`);

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

/** One ticket with its comment thread — the detail and edit pages' only read. */
export const useTicketQuery = (ticketId: number): UseQueryResult<Ticket> =>
  useQuery({
    queryKey: queryKeys.tickets.detail(ticketId),
    queryFn: ({ signal }) => getTicket(ticketId, signal),
  });

/* ------------------------------------------------------------------ *
 * Mutations
 *
 * Every invalidation below goes through `queryKeys`. The choice of prefix is
 * the decision, not a formality:
 *
 * - A ticket write uses `tickets.all`, because a status, priority, or assignee
 *   change can reorder the list, move the row out of the active filter, change
 *   `meta.total`, and add or drop a name from `facets`. Invalidating only
 *   `detail(id)` leaves a stale row behind on the screen the user goes back to.
 * - A comment write uses `detail(id)` only — comments do not touch
 *   `Ticket.updatedAt` (`docs/features/Comments.md`), so no list row moved and
 *   `commentCount` on the list is refreshed on its own schedule.
 * ------------------------------------------------------------------ */

export const useCreateTicketMutation = (): UseMutationResult<Ticket, Error, CreateTicketInput> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateTicketInput) => createTicket(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tickets.all });
    },
  });
};

export const useUpdateTicketMutation = (
  ticketId: number,
): UseMutationResult<Ticket, Error, UpdateTicketInput> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateTicketInput) => updateTicket(ticketId, input),
    onSuccess: (ticket) => {
      // Seed the detail cache from the response so the page the user lands on
      // renders the saved values immediately, then let the invalidation refresh
      // everything that could have moved.
      queryClient.setQueryData(queryKeys.tickets.detail(ticketId), ticket);
      void queryClient.invalidateQueries({ queryKey: queryKeys.tickets.all });
    },
  });
};

/**
 * The detail page's inline status change — optimistic, per
 * `docs/pages/Ticket_Detail.md` § 5.
 *
 * Separate from `useUpdateTicketMutation` rather than a flag on it: the rollback
 * only makes sense when there is a cached detail row to roll back *to*, which is
 * true on the detail page and not on the edit form (which navigates away).
 */
export const useTicketStatusMutation = (
  ticketId: number,
): UseMutationResult<Ticket, Error, TicketStatus, { previous: Ticket | undefined }> => {
  const queryClient = useQueryClient();
  const detailKey = queryKeys.tickets.detail(ticketId);

  return useMutation({
    mutationFn: (status: TicketStatus) => updateTicket(ticketId, { status }),
    onMutate: async (status) => {
      // Without this, an in-flight GET can resolve after the optimistic write
      // and overwrite it with the pre-change row.
      await queryClient.cancelQueries({ queryKey: detailKey });

      const previous = queryClient.getQueryData<Ticket>(detailKey);
      if (previous !== undefined) {
        queryClient.setQueryData<Ticket>(detailKey, { ...previous, status });
      }
      return { previous };
    },
    onError: (_error, _status, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(detailKey, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tickets.all });
    },
  });
};

export const useDeleteTicketMutation = (): UseMutationResult<void, Error, number> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (ticketId: number) => deleteTicket(ticketId),
    /**
     * The one write that does **not** invalidate `tickets.all`, and the reason
     * is measured rather than stylistic.
     *
     * A mutation's own `onSuccess` runs before the per-call one, so at this
     * moment the detail page is still mounted and still observing
     * `detail(ticketId)`. Invalidating the whole tree therefore refetches the
     * ticket that was just deleted — a guaranteed 404, issued between the
     * DELETE and the navigation away. Confirmed in a production build: the
     * delete flow issued `DELETE /tickets/65` followed by `GET /tickets/65`.
     *
     * `removeQueries` is not the fix either, and for the same reason: removing
     * a query that still has an observer makes that observer create a fresh one
     * and fetch it.
     *
     * So the detail entry is marked stale with `refetchType: "none"` — no
     * request now, and a guaranteed refetch if the user ever navigates back to
     * that URL, which is what turns a cached deleted ticket into the documented
     * not-found state. The two prefixes a deletion actually changes are
     * invalidated normally. Still through `queryKeys`: the rule is "no inline
     * key arrays", not "always the root".
     */
    onSuccess: (_data, ticketId) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.tickets.detail(ticketId),
        refetchType: "none",
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tickets.lists() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tickets.facets() });
    },
  });
};
