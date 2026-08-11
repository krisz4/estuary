---
type: Page
title: Tickets list
description: Landing screen — all tickets with filtering, sorting, and paging bound to the URL.
resource: apps/web/src/pages/tickets-list/
tags: [tickets, list, filtering, sorting, pagination]
status: canonical
---
# Page Review: Tickets List

The landing screen and the most feature-dense page in the app. Task 4.1 of the brief.

## Route

- Path: `/tickets` — `/` redirects here
- File: `src/pages/tickets-list/TicketsListPage.tsx`
- Type: Client component, data via TanStack Query

## Dependencies

### Components used

| Component | Role on this page |
| --------- | ----------------- |
| `TicketFilterBar` (`src/features/tickets/`) | Search input, status + priority + category multiselects, assignee select, "Unassigned only" toggle, clear-all. Assignee and category options come from `GET /tickets/facets` — there is no other source of the assignee list, and sending an exact stored value is what makes the case-sensitive match work |
| `TicketTable` | Desktop `<table>` — sortable column headers, row click → detail |
| `TicketCardList` | Mobile stacked cards (same data, different presentation) |
| `SortSelect` | Mobile-only sort control (the table headers do this job on desktop) |
| `Pagination` | Page buttons, prev/next, "Showing X–Y of Z", page-size select |
| `StatusBadge`, `PriorityBadge` | Per-row indicators |
| `EmptyState` | Two variants: no tickets at all vs no matches for the current filters |
| `ErrorPanel` | Error message + Retry |
| `TableSkeleton` | Loading placeholder matching the real row height, so the layout does not jump |

### Hooks

| Hook | Role |
| ---- | ---- |
| `useTicketListParams()` | Reads/validates/writes the URL search params — the single source of list state |
| `useTicketsQuery(params)` | `GET /api/v1/tickets`; key `queryKeys.tickets.list(params)`; `placeholderData: keepPreviousData` so the table does not blank out while paging |
| `useTicketFacetsQuery()` | `GET /api/v1/tickets/facets`; key `queryKeys.tickets.facets()`; long `staleTime` (5 min) — the option lists change rarely |

### API calls

| Call | Method | Endpoint |
| ---- | ------ | -------- |
| `listTickets(params)` | `GET` | `/api/v1/tickets?page=&pageSize=&sort=&status=&priority=&category=&assignee=&assigneeIsNull=&q=&createdFrom=&createdTo=` |
| `getTicketFacets()` | `GET` | `/api/v1/tickets/facets` — populates the assignee and category selects |

Read-only page — no mutations. Full parameter semantics: [../features/Ticket_Query_Filter_Sort_Page.md](../features/Ticket_Query_Filter_Sort_Page.md).

## Behavior / UI flow

1. Land on `/tickets` with defaults: page 1, 20 per page, `createdAt:desc`, no filters.
2. **Search** — typing in `q` is debounced 300ms, then written to the URL with `replace: true` so typing does not fill the history stack. Filter changes use `push` so back undoes them.
3. **Filters** — status and priority are multiselects (checkbox chips) that OR within themselves. Active filters render as removable chips above the table with a "Clear all" when any is set.
4. **Sorting** — desktop: click a column header to sort, click again to flip direction; the active column shows a direction caret. Mobile: `SortSelect` dropdown. Sortable columns and the API field they send: Reference → `id`, Title → `title`, Status → `status`, Priority → `priority`, Created → `createdAt`, Updated → `updatedAt`.
5. **Any filter or sort change resets `page` to 1.** Page changes do not touch filters.
6. **Navigation is a real `<a>` in the reference cell** — `HD-000042` is the link, and the title cell repeats it as a second link. The row itself is **not** clickable: there is no `onClick` on the `<tr>`.

   Whole-row click and correct link semantics are not compatible without hacks (a stretched pseudo-element over the row breaks text selection, an `onClick` breaks middle-click, new-tab, and copy-link). Two explicit links keep middle-click, `Cmd`-click, "Open in new tab", and keyboard focus all working, at the cost of a slightly smaller hit area. On mobile the whole **card** is one `<a>`, where that tradeoff does not arise.
7. **Paging** — prev/next plus numbered buttons with ellipsis for long ranges; page size options 10/20/50. During a page fetch the previous rows stay visible at reduced opacity with `aria-busy` set.

## States

| State | Behavior |
| ----- | -------- |
| Loading (first) | `TableSkeleton` with 8 rows / card skeletons on mobile |
| Loading (paging or filtering) | Previous data retained, dimmed, `aria-busy="true"` |
| Empty — no tickets exist | "No tickets yet" + "Create the first ticket" CTA → `/tickets/new` |
| Empty — filters match nothing | "No tickets match these filters" + "Clear filters" button. **Distinct from the above** — offering "create a ticket" to someone whose filter is too narrow is the wrong answer |
| Error | `ErrorPanel` with the mapped message and Retry (`refetch()`), keeping the filter bar interactive |
| Page beyond the end | API returns an empty page; UI shows the no-match empty state with a "Back to page 1" action |

## Responsive

| Breakpoint | Layout |
| ---------- | ------ |
| < `md` | `TicketCardList`. Each card: reference + relative time on line 1, title (2-line clamp) on line 2, status/priority badges + assignee on line 3. Priority renders as a colored left border stripe. Filters collapse into a "Filters" button opening a bottom sheet, with a count badge when filters are active |
| ≥ `md` | `TicketTable`: reference, title, status, priority, requester, created. Filter bar inline |
| ≥ `lg` | Adds the assignee column |

The table is never horizontally scrolled on mobile — the card list exists precisely so it does not have to be. The brief calls out mobile explicitly, so this is a hard requirement.

## Accessibility

- `<table>` with `<caption class="sr-only">`, `<th scope="col">`, and `aria-sort` on the active header.
- Sortable headers are `<button>`s inside the `<th>`, keyboard-operable, with labels like "Sort by priority, descending".
- Filter chips are buttons labelled "Remove filter: status open".
- Pagination is a `<nav aria-label="Pagination">`; the current page has `aria-current="page"`.
- Result count is announced via a polite live region so screen-reader users hear "63 tickets" after a filter change.

## Related

- [../features/Ticket_Query_Filter_Sort_Page.md](../features/Ticket_Query_Filter_Sort_Page.md) — parameters and envelope
- [../features/Ticket_Priority.md](../features/Ticket_Priority.md), [../features/Ticket_Status_Lifecycle.md](../features/Ticket_Status_Lifecycle.md) — badge semantics
- [Ticket_Detail.md](./Ticket_Detail.md), [Ticket_Create.md](./Ticket_Create.md)
