---
type: Page
title: Tickets board
description: Kanban view at /tickets/board — one column per status, drag and drop to change it.
resource: apps/web/src/pages/tickets-board/
tags: [tickets, board, kanban, drag-and-drop, status]
status: canonical
---
# Page Review: Tickets Board

The second view of the same data as [Tickets_List.md](./Tickets_List.md): tickets grouped into one column per status, moved between columns by dragging. Everything a ticket *is* still lives on the list and detail pages — this screen exists to change one field quickly, across many tickets.

## Route

- Path: `/tickets/board`
- File: `src/pages/tickets-board/TicketsBoardPage.tsx`
- Type: Client component, data via TanStack Query
- **Declared before `/tickets/:ticketId`** in `router.tsx`, for the same reason as `/tickets/new`

## Dependencies

### Components used

| Component | Role on this page |
| --------- | ----------------- |
| `ViewSwitch` (`src/features/tickets/`) | List ⇄ Board, as two `<a>`s carrying the current search string. Also rendered on the list page |
| `TicketFilterBar` | The same bar as the list page — search, priority, category, assignee, dates. Its **status** chips select which columns render (see below) |
| `SortSelect` | Sorts *within* every column. Rendered here at `md` and up, because a board has no sortable column headers for it to duplicate; below `md` the filter bar already renders it |
| `BoardColumn` (`src/features/tickets/`) | One status column: heading, live count, cards, its own loading / error / empty states, and the drop target |
| `BoardCard` | One ticket: reference and title links, priority badge and stripe, comment count, assignee, and the "move to" select. Exports `BoardCardOverlay` (the card that follows the cursor) and `BoardCardSkeleton` |
| `ErrorPanel`, `Skeleton` (`src/components/`) | Per column, never for the whole board |

### Hooks

| Hook | Role |
| ---- | ---- |
| `useTicketListParams()` | The same URL state as the list page — filters, search, and sort are shared between the two views |
| `useBoardTickets(params)` | Four `GET /api/v1/tickets` queries (one per status), the per-column "load more" depth, and the in-flight moves |
| `useTicketFacetsQuery()` | Assignee and category options for the filter bar |
| `useMoveTicketStatusMutation()` | `PATCH /api/v1/tickets/:id { status }`, not bound to a single ticket id |

### API calls

| Call | Method | Endpoint |
| ---- | ------ | -------- |
| `listTickets(query)` ×4 | `GET` | `/api/v1/tickets?status=<column>&page=1&pageSize=25&…` |
| `getTicketFacets()` | `GET` | `/api/v1/tickets/facets` |
| `updateTicket(id, { status })` | `PATCH` | `/api/v1/tickets/:ticketId` |

No new endpoint, no contract change, no migration: the board is a second reading of `GET /tickets` plus the status PATCH the detail page already uses.

## Behavior / UI flow

1. **Four queries, not one.** A board is four independently-sized queues. One list request big enough to fill every column would spend its paging on whichever status happens to be largest — 400 closed tickets would push the three open ones off the board. Each column pages on its own and reports its own `meta.total` as the count in its heading.
2. **Load more is per column**, +25 rows at a time up to `MAX_PAGE_SIZE` (100). Past that the column says "Showing the first 100 of N. Narrow the filters to see the rest." rather than offering a button that would 422 — the API rejects an over-large `pageSize`, it does not clamp it.
3. **Dragging** is `@dnd-kit/core`: mouse drags activate after 6px of movement (so a click on a card's link is still a click), touch drags after a 250ms press-and-hold (so scrolling a column is still scrolling). The dragged card is drawn in a `DragOverlay` portal, because a card transformed in place is clipped by the board's `overflow-x: auto` the moment it leaves its column.
4. **Dropping** PATCHes the status and shows the card in its new column immediately. The optimistic move is held in `useBoardTickets`'s `pendingMoves`, not written into the *list* cache: a move changes which query a row belongs to, so a cache-level version would have to splice rows between entries and fix up two `meta.total`s. The card and both column counts move together; the entry is dropped once the invalidation triggered by `onSettled` has refetched.

   The **detail entry is** written optimistically (and rolled back on failure), because a card is a link: drag `HD-000042` to Resolved, click straight into it, and without that write the ticket page renders the cached "In progress" while the board behind it says Resolved.

   `onSettled` invalidates `lists()` and `detail(id)` — **not `tickets.all`**. A status-only PATCH cannot change `facets` (it reports the assignees and categories *present* in the table), and unlike the detail page, this screen keeps a facets observer mounted, so `all` would fire a `GET /tickets/facets` on every drag that can never return anything new. The full prefix table is in `api/queryKeys.ts`.
5. **Every column accepts every card**, including `closed → resolved`, which the server rejects with `INVALID_STATUS_TRANSITION` (409). The client deliberately holds no copy of the transition table — see [../features/Ticket_Status_Lifecycle.md](../features/Ticket_Status_Lifecycle.md) and `lib/statusTransition.ts`. A rejection returns the card to its column and toasts the server's own `details.allowed`: *"Not allowed from here. You can move it to Open or In progress instead."*
6. **Dropping a card on the column it came from does nothing** — no PATCH. The API treats `X → X` as a write-free success, but the round trip would still flash the card's busy state.
7. **The status filter picks columns**, rather than filtering rows inside them. On a board the columns *are* the status filter; applying it twice would leave columns that are empty for a reason nothing on screen explains. `?status=open&status=in_progress` means "show me the active half of the board". Columns always render in lifecycle order, never in the order the chips were clicked.
8. **`page` is ignored** — the board pages per column. The key is left in the URL untouched, so switching back to the list returns to the page you were on.
9. Cards link to the detail page from the reference and the title, and carry `{ from: search }` so "Back to tickets" returns to this board with its filters intact. The **filters** ride in that state; the **board itself** is remembered in the `stores/ticketView` zustand store, which this page writes on mount (`useRememberTicketView("board")`). Router state alone cannot do it — it is gone on a pasted link or a reload — so without the store the back link took board users to the list. The store follows the URL and never drives it: `ViewSwitch` only navigates.

## States

| State | Rendering |
| ----- | --------- |
| Loading | Three `BoardCardSkeleton`s per column, and `—` in place of the count |
| Refetching | The column dims to 60% and sets `aria-busy` — rows are kept, never torn down (`keepPreviousData`) |
| Error | `ErrorPanel` **inside the failing column only**, with Retry. Three columns that loaded stay usable |
| Empty column | "Nothing resolved. Drop a ticket here to move it." — the empty column is still a drop target |
| Move rejected | Card returns to its column; error toast carries the server's allowed targets |
| Move succeeded | Success toast: `HD-000042 moved to In progress` |

## Responsive

| Width | Layout |
| ----- | ------ |
| `< lg` | Columns are `85vw`, in a horizontally scrolling, scroll-snapping row. The next column peeks in at the edge, which is what says "there is more this way" |
| `≥ lg` | Four equal columns, no horizontal scroll |

Horizontal scrolling is deliberate here and nowhere else in the app: a kanban column is a queue, and a queue that reflows into a stack is the list page again. **The document itself never scrolls sideways** — the columns scroll inside their own container, which `e2e/board.spec.ts` asserts at 375px. Two classes make that true and both are commented in the page: `min-w-0` (a flex item will not shrink below its content without it) and `relative` (the cards' `sr-only` spans are `position: absolute`, and an absolutely positioned element is only clipped by an ancestor in its containing-block chain — without it those 1px spans stretched the document to 1115px).

**Vertically, the board grows with its content and the *page* scrolls it.** Columns are `items-start`, so each one is as tall as its own queue rather than as tall as the fullest.

This replaced a `max-h: calc(100vh - 19rem)` on each column's card area. That cap made the board exactly one window tall whatever it held — so arriving from a long list left a screenful of dead space between the board and the footer, and the magic number had to be re-tuned every time the chrome above the board changed height (a wrapping filter bar was enough). Growing with the content means the document height *is* the board's height, and there is nothing underneath it to explain.

The column headings keep their old job — telling you which column you are in — by being `sticky top-14`, pinned directly under the app header rather than under a per-column scrollbar.

## Accessibility

- **The "move to" select on each card is the keyboard and screen-reader path, and it is not a fallback.** `@dnd-kit` ships a `KeyboardSensor`, but without `@dnd-kit/sortable`'s coordinate getter it moves a floating card 25px per arrow press across a horizontally scrolling board — operable by keyboard in the sense that it responds, unusable in every other sense. A real select announces the four targets, commits in two keystrokes, and calls the *same* `move()` a drop does.
- `useDraggable`'s `attributes` are deliberately **not** spread onto the card. They set `role="button"`, `tabIndex={0}`, and `aria-roledescription="draggable"` for that unused `KeyboardSensor` — applied anyway they stop the `<li>` being a list item (it was announced as a button containing two links and a combobox) and add a focusable control that does nothing when activated.
- Each column is a labelled `<section>`: "Open — 12 tickets". The count badge is `aria-hidden`, so the number is announced once with its noun instead of twice without one.
- A `sr-only` live region summarises all four counts, so a filter change is not silent for someone who cannot see the board.
- Drag announcements are customised on `DndContext` — "Picked up ticket HD-000042", "Over In progress" — instead of dnd-kit's defaults, which narrate library ids (`droppable area column:resolved`).
- Status is never carried by colour alone: the column heading names it, and the card's select shows it.

## Related

- [Tickets_List.md](./Tickets_List.md) — the other view of the same URL state
- [../features/Ticket_Status_Lifecycle.md](../features/Ticket_Status_Lifecycle.md) — legal transitions and their timestamp side effects
- [../features/Ticket_Query_Filter_Sort_Page.md](../features/Ticket_Query_Filter_Sort_Page.md) — the query parameters both views read
- [../engineering/TESTING.md](../engineering/TESTING.md) — why the drag is covered end-to-end and not in jsdom
