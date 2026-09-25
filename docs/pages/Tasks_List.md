---
type: Page
title: Tasks list
description: Landing screen — all tasks with filtering, sorting, and paging bound to the URL.
resource: apps/web/src/pages/tasks-list/
tags: [tasks, list, filtering, sorting, pagination]
status: canonical
---
# Page Review: Tasks List

The landing screen and the most feature-dense page in the app.

## Route

- Path: `/tasks` — `/` redirects here
- File: `src/pages/tasks-list/TasksListPage.tsx`
- Type: Client component, data via TanStack Query

## Dependencies

### Components used

| Component | Role on this page |
| --------- | ----------------- |
| `TaskFilterBar` (`src/features/tasks/`) | Debounced search input, status/priority/project chip multiselects, assignee select, "created by" actor select, created-from/created-to date inputs (UTC), removable active-filter chips, clear-all. Two one-click **status presets** sit beside the Status legend: **"Open work"** selects every status except the closed lane (`OPEN_STATUSES`), **"Needs you"** selects `HUMAN_ATTENTION_STATUSES` — the same three statuses the inbox shows. Assignee, project, and creator options all come from `GET /tasks/facets` |
| `ViewSwitch` (`src/features/tasks/`) | List ⇄ Board, carrying the current search string so switching view preserves every filter. The board reads the same URL state — [Tasks_Board.md](./Tasks_Board.md) |
| `TaskTable` | Desktop `<table>` — sortable column headers, per-row meta line (claim, open dependencies, open decision, comment count), two real links per row |
| `TaskCardList` | Mobile stacked cards (same data, different presentation), each the whole card as one link |
| `SortSelect` | Mobile-only sort control, offering named orderings ("Priority: high to low") rather than a field picker plus a direction toggle |
| `Pagination` (`src/components/`) | Page buttons with ellipsis, prev/next, "Showing X–Y of Z", page-size select |
| `StatusBadge`, `PriorityBadge`, `ActorBadge`, `ClaimIndicator` | Per-row indicators — ten status tones, four priority tones (plus the card's left-border stripe), agent/human/system actor badge, "who holds the claim" |
| `EmptyState` (`src/components/`) | Three variants: no tasks at all, no matches for the current filters, and a page past the end of a non-empty result |
| `ErrorPanel` (`src/components/`) | Copy from `errorCopy(code)` + Retry (`refetch()`) |
| `TaskTableSkeleton` / `TaskCardListSkeleton` | Loading placeholders that render the real chrome, so the layout does not jump |

**There is no "New task" button on this page.** `AppHeader` renders one on every screen.

### Hooks

| Hook | Role |
| ---- | ---- |
| `useTaskListParams()` | Reads/validates/writes the URL search params — the single source of list state |
| `useTasksQuery(params)` | `GET /api/v1/tasks`; key `queryKeys.tasks.list(query)`; `placeholderData: keepPreviousData` so the table does not blank out while paging; polls every 15s (`api/polling.ts`) |
| `useTaskFacetsQuery()` | `GET /api/v1/tasks/facets`; key `queryKeys.tasks.facets()`; 5-minute `staleTime` — the option lists change rarely |

### API calls

| Call | Method | Endpoint |
| ---- | ------ | -------- |
| `listTasks(query)` | `GET` | `/api/v1/tasks?page=&pageSize=&sort=&status=&priority=&project=&assignee=&assigneeIsNull=&createdBy=&q=&createdFrom=&createdTo=` |
| `getTaskFacets()` | `GET` | `/api/v1/tasks/facets` — assignees, projects, creators for the filter selects |

Read-only page — no mutations. Full parameter semantics: [../features/Task_Query_Filter_Sort_Page.md](../features/Task_Query_Filter_Sort_Page.md).

## Behavior / UI flow

1. Land on `/tasks` with defaults: page 1, 20 per page, `createdAt:desc`, no filters. **There is no default status filter** — a bare `/tasks` shows all ten statuses, so "nothing exists" and "nothing matches" stay distinguishable. The "Open work" preset is the one-click way to hide the closed lane.
2. **Search** — typing in `q` is debounced 300ms, then written to the URL with `replace: true` so typing does not fill the history stack. Filter changes use `push` so back undoes them.
3. **Filters** — status, priority, and project are multiselects (checkbox chips) that OR within themselves; assignee is one control (Anyone / Unassigned / Assigned to anyone / each name from facets) because `assignee` and `assigneeIsNull` are mutually exclusive on the wire; "Created by" is a single-select over facets' `creators`. Active filters render as removable chips above the table with a "Clear all" when any is set. The date bounds **clamp** rather than reject: moving one past the other moves the other with it.
4. **Sorting** — desktop: click a column header to sort, click again to flip direction. Mobile: `SortSelect` dropdown. Sortable columns and the API field they send: Reference → `id`, Title → `title`, Status → `status`, Priority → `priority`, Created → `createdAt`. (`updatedAt` is sortable via `SortSelect`'s "Recently updated" option but has no column of its own.)
5. **Any filter or sort change resets `page` to 1.** Page changes do not touch filters.
6. **The `md` swap is a JS media query (`MD_BREAKPOINT_QUERY`), not `hidden md:block`.** Exactly one of the table and the card list is in the DOM at any width.
7. **Navigation is a real `<a>` in the reference cell** — `TASK-000042` is the link, and the title cell repeats it as a second link. The row itself is **not** clickable. On mobile the whole card is one `<a>`.
8. **Paging** — prev/next plus numbered buttons with ellipsis; page size options 10/20/50. During a page fetch or a poll's refetch that lands mid-request the previous rows stay visible at reduced opacity with `aria-busy` set — but only when `isPlaceholderData` is true (a page or filter change), never on the routine 15s poll, which usually changes nothing and would otherwise dim the table on a timer.

## States

| State | Behavior |
| ----- | -------- |
| Loading (first) | `TaskTableSkeleton` (8 rows) / `TaskCardListSkeleton` on mobile |
| Loading (paging or filtering) | Previous data retained, dimmed, `aria-busy="true"` |
| Empty — no tasks exist | "No tasks yet" + "Create the first task" CTA → `/tasks/new` |
| Empty — filters match nothing | "No tasks match these filters" + "Clear filters" button |
| Error | `ErrorPanel` with the mapped message and Retry, keeping the filter bar interactive |
| Page beyond the end | "Nothing on this page" + "Back to page 1" — *not* the no-match state, because clearing filters would throw away a query that is working |

## Responsive

| Breakpoint | Layout |
| ---------- | ------ |
| < `md` | `TaskCardList`. Each card: reference + relative time on line 1, title (2-line clamp) on line 2, status/priority badges + project + creator on line 3, then the claim/dependency/decision/comment meta line when any applies. Priority renders as a colored left border stripe. Filters collapse into a "Filters" button opening a dialog, with a count badge when filters are active; the search box takes its own row below `sm`, and `SortSelect` sits beside the Filters button. The whole card is one `<a>` |
| ≥ `md` | `TaskTable`: reference, title, status, priority, created by, created. Filter bar inline. `table-fixed` column widths are tuned at 768px |
| ≥ `lg` | Adds the project column |

The table is never horizontally scrolled on mobile — the card list exists precisely so it does not have to be.

## Accessibility

- `<table>` with `<caption class="sr-only">`, `<th scope="col">`, and `aria-sort` on the active header.
- Sortable headers are `<button>`s inside the `<th>`, keyboard-operable, with labels like "Sort by priority, descending".
- Filter chips are buttons labelled "Remove filter: status: to do".
- Pagination is a `<nav aria-label="Pagination">`; the current page has `aria-current="page"`.
- Result count is announced via a polite live region so screen-reader users hear "X tasks found" after a filter change.
- Status / priority / project filters are real `<input type="checkbox">` elements inside a `<fieldset>` with a `<legend>`, visually hidden and styled through `peer-checked`.
- The page renders no "New task" button of its own — `AppHeader` provides it on every screen.

## Related

- [../features/Task_Query_Filter_Sort_Page.md](../features/Task_Query_Filter_Sort_Page.md) — parameters and envelope
- [../features/Task_Priority.md](../features/Task_Priority.md), [../features/Task_Status_Lifecycle.md](../features/Task_Status_Lifecycle.md) — badge semantics
- [Inbox.md](./Inbox.md) — the "Needs you" preset's own dedicated screen
- [Task_Detail.md](./Task_Detail.md), [Task_Create.md](./Task_Create.md), [Tasks_Board.md](./Tasks_Board.md)
