import { type TicketListQueryInput } from "@helpdesk/contracts";

/**
 * Every TanStack Query key in the app.
 *
 * **No inline key arrays, ever.** An invalidation written as
 * `["tickets"]` at one call site and `["tickets", "list"]` at another does not
 * fail loudly — it just quietly stops refreshing one of them, and the bug
 * surfaces as "the list is stale after I edit a ticket" days later. Centralising
 * them makes the hierarchy a fact of the module rather than a convention.
 *
 * The hierarchy is prefix-based, which is what makes partial invalidation work:
 *
 * ```
 * ["tickets"]                          ← tickets.all      invalidates everything below
 *   ["tickets","list"]                 ← tickets.lists()  every list, any filter
 *     ["tickets","list",{…params}]     ← tickets.list()   one filtered page
 *   ["tickets","detail"]               ← tickets.details()
 *     ["tickets","detail",42]          ← tickets.detail()
 *   ["tickets","facets"]               ← tickets.facets()
 * ```
 *
 * Which prefix to invalidate is a real decision, not a formality: a comment
 * write touches `detail(id)` only — comments do not change `Ticket.updatedAt`,
 * so no list row moved — while any ticket write goes through `all`, because a
 * status change can reorder, re-filter, or re-page the list and can also add or
 * remove an assignee from `facets`.
 */
export const queryKeys = {
  tickets: {
    all: ["tickets"] as const,
    lists: () => [...queryKeys.tickets.all, "list"] as const,
    /**
     * The params object is part of the key, so two different filter sets are two
     * different cache entries. TanStack Query hashes it with stable key ordering,
     * so `{page:1,status:"open"}` and `{status:"open",page:1}` are one entry.
     */
    list: (params: TicketListQueryInput) => [...queryKeys.tickets.lists(), params] as const,
    details: () => [...queryKeys.tickets.all, "detail"] as const,
    detail: (ticketId: number) => [...queryKeys.tickets.details(), ticketId] as const,
    facets: () => [...queryKeys.tickets.all, "facets"] as const,
  },
} as const;

export type QueryKeys = typeof queryKeys;
