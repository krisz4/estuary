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
| `TicketFilterBar` (`src/features/tickets/`) | Debounced search input, status + priority + category chip multiselects, assignee select, created-from / created-to date inputs (UTC), removable active-filter chips, clear-all. Assignee and category options come from `GET /tickets/facets` — there is no other source of the assignee list, and sending an exact stored value is what makes the case-sensitive match work. **Assignee is one control, not a select plus an "unassigned" toggle**: its options are Anyone / Unassigned / Assigned to anyone / each name, so the mutually-exclusive `assignee` + `assigneeIsNull` 422 is unrepresentable in the UI rather than merely avoided |
| `ViewSwitch` (`src/features/tickets/`) | List ⇄ Board, carrying the current search string so switching view preserves every filter. The board reads the same URL state — [Tickets_Board.md](./Tickets_Board.md) |
| `TicketTable` | Desktop `<table>` — sortable column headers, row click → detail |
| `TicketCardList` | Mobile stacked cards (same data, different presentation) |
| `SortSelect` | Mobile-only sort control, offering named orderings ("Priority: high to low") rather than a field picker plus a direction toggle |
| `Pagination` (`src/components/`) | Page buttons with ellipsis, prev/next, "Showing X–Y of Z", page-size select. Lives in `components/` rather than `features/tickets/` because it knows only `PaginationMeta` and two callbacks |
| `StatusBadge`, `PriorityBadge` | Per-row indicators. `PriorityBadge` also exports `PRIORITY_STRIPE`, the card's left-border colour |
| `EmptyState` (`src/components/`) | Three variants: no tickets at all, no matches for the current filters, and a page past the end of a non-empty result |
| `ErrorPanel` (`src/components/`) | Copy from `errorCopy(code)` + Retry (`refetch()`), shown only when the code is retryable |
| `TicketTableSkeleton` / `TicketCardListSkeleton` | Loading placeholders that render the real chrome, so the layout does not jump |

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
2. **Search** — typing in `q` is debounced 300ms, then written to the URL with `replace: true` so typing does not fill the history stack. Filter changes use `push` so back undoes them. The box tracks what it last committed **in the URL's own form** — trimmed — because comparing an untrimmed draft against a trimmed URL value makes the sync effect mistake its own write for an external navigation and rewrite the focused input mid-keystroke.
3. **Filters** — status, priority, and category are multiselects (checkbox chips) that OR within themselves. Active filters render as removable chips above the table with a "Clear all" when any is set. A chip reports **which value was toggled**, never the whole next array, and chip removal is a function of the current filters — anything derived from a previous value has to be computed when the write happens, or two changes inside one frame lose the first. The date bounds **clamp** rather than reject: moving one past the other moves the other with it.
4. **Sorting** — desktop: click a column header to sort, click again to flip direction; the active column shows a direction caret. Mobile: `SortSelect` dropdown. Sortable columns and the API field they send: Reference → `id`, Title → `title`, Status → `status`, Priority → `priority`, Created → `createdAt`, Updated → `updatedAt`.
5. **Any filter or sort change resets `page` to 1.** Page changes do not touch filters.
6. **The `md` swap is a JS media query (`MD_BREAKPOINT_QUERY`), not `hidden md:block`.** Exactly one of the table and the card list is in the DOM at any width. Rendering both and hiding one with CSS would put two links to every ticket in the document and make "which one is showing?" a question only the stylesheet could answer.
7. **Navigation is a real `<a>` in the reference cell** — `HD-000042` is the link, and the title cell repeats it as a second link. The row itself is **not** clickable: there is no `onClick` on the `<tr>`.

   Whole-row click and correct link semantics are not compatible without hacks (a stretched pseudo-element over the row breaks text selection, an `onClick` breaks middle-click, new-tab, and copy-link). Two explicit links keep middle-click, `Cmd`-click, "Open in new tab", and keyboard focus all working, at the cost of a slightly smaller hit area. On mobile the whole **card** is one `<a>`, where that tradeoff does not arise.
8. **Paging** — prev/next plus numbered buttons with ellipsis for long ranges; page size options 10/20/50. During a page fetch the previous rows stay visible at reduced opacity with `aria-busy` set.

## States

| State | Behavior |
| ----- | -------- |
| Loading (first) | `TableSkeleton` with 8 rows / card skeletons on mobile |
| Loading (paging or filtering) | Previous data retained, dimmed, `aria-busy="true"` |
| Empty — no tickets exist | "No tickets yet" + "Create the first ticket" CTA → `/tickets/new` |
| Empty — filters match nothing | "No tickets match these filters" + "Clear filters" button. **Distinct from the above** — offering "create a ticket" to someone whose filter is too narrow is the wrong answer |
| Error | `ErrorPanel` with the mapped message and Retry (`refetch()`), keeping the filter bar interactive |
| Page beyond the end | API returns an empty page with correct `meta`; UI shows a dedicated "Nothing on this page" state with a "Back to page 1" action — *not* the no-match state, because clearing filters would throw away a query that is working. The pager says "Page 9 is past the end — 63 tickets on 4 pages" rather than the backwards range the naive arithmetic produces |

## Responsive

| Breakpoint | Layout |
| ---------- | ------ |
| < `md` | `TicketCardList`. Each card: reference + relative time on line 1, title (2-line clamp) on line 2, status/priority badges + assignee on line 3. Priority renders as a colored left border stripe. Filters collapse into a "Filters" button opening a bottom sheet, with a count badge when filters are active; the search box takes its own row below `sm`, and `SortSelect` sits beside the Filters button. The whole card is one `<a>` |
| ≥ `md` | `TicketTable`: reference, title, status, priority, requester, created. Filter bar inline. Column widths are tuned at 768px, not at 1280 — `table-fixed` takes every fixed column out of the total before Title, and generous widths left Title unreadable exactly at the breakpoint |
| ≥ `lg` | Adds the assignee column |

The table is never horizontally scrolled on mobile — the card list exists precisely so it does not have to be. The brief calls out mobile explicitly, so this is a hard requirement.

## Accessibility

- `<table>` with `<caption class="sr-only">`, `<th scope="col">`, and `aria-sort` on the active header.
- Sortable headers are `<button>`s inside the `<th>`, keyboard-operable, with labels like "Sort by priority, descending".
- Filter chips are buttons labelled "Remove filter: status open".
- Pagination is a `<nav aria-label="Pagination">`; the current page has `aria-current="page"`.
- Result count is announced via a polite live region so screen-reader users hear "63 tickets found" after a filter change.
- Status / priority / category filters are real `<input type="checkbox">` elements inside a `<fieldset>` with a `<legend>`, visually hidden and styled through `peer-checked`, so the group is announced as a named group of checkboxes.
- The page renders no "New ticket" button of its own — `AppHeader` provides it on every screen, and the guidelines allow one primary action per view.

## Related

- [../features/Ticket_Query_Filter_Sort_Page.md](../features/Ticket_Query_Filter_Sort_Page.md) — parameters and envelope
- [../features/Ticket_Priority.md](../features/Ticket_Priority.md), [../features/Ticket_Status_Lifecycle.md](../features/Ticket_Status_Lifecycle.md) — badge semantics
- [Ticket_Detail.md](./Ticket_Detail.md), [Ticket_Create.md](./Ticket_Create.md)
