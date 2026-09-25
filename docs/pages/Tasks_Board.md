---
type: Page
title: Tasks board
description: Kanban view at /tasks/board — ten status columns in four lanes, drag and drop to change status.
resource: apps/web/src/pages/tasks-board/
tags: [tasks, board, kanban, drag-and-drop, status, lanes]
status: canonical
---
# Page Review: Tasks Board

The second view of the same data as [Tasks_List.md](./Tasks_List.md): all ten statuses, arranged as columns grouped into four lanes, moved between columns by dragging.

## Route

- Path: `/tasks/board`
- File: `src/pages/tasks-board/TasksBoardPage.tsx`
- Type: Client component, data via TanStack Query
- **Declared before `/tasks/:taskId`** in `router.tsx`, for the same reason as `/tasks/new`

## Dependencies

### Components used

| Component | Role on this page |
| --------- | ----------------- |
| `ViewSwitch` (`src/features/tasks/`) | List ⇄ Board, as two `<a>`s carrying the current search string |
| `TaskFilterBar` | The same bar as the list page. Its **status** chips select which columns render (see below), including the "Open work" / "Needs you" presets |
| `SortSelect` | Sorts *within* every column. Rendered here at `md` and up only — below `md` the filter bar already renders it |
| `BoardLane` (`src/features/tasks/`) | One lane — Plan, Doing, Waiting, Closed (`TASK_STATUS_LANES`) — a labelled `<section>` holding its columns side by side, collapsible for Closed |
| `BoardColumn` | One status column: heading, live count, cards, its own loading/error/empty states, and the drop target |
| `BoardCard` | One task: reference and title links, priority badge and stripe, project, comment count, claim indicator, open-question and open-dependency signals, and the "move to" select. Exports `BoardCardOverlay` (the card that follows the cursor) and `BoardCardSkeleton` |
| `TransitionDialog` | Opens when a drop (or the card's select) targets a status whose transition payload needs input — see below |
| `ErrorPanel`, `Skeleton` (`src/components/`) | Per column, never for the whole board |

### Hooks

| Hook | Role |
| ---- | ---- |
| `useTaskListParams()` | The same URL state as the list page — filters, search, and sort are shared between the two views |
| `useBoardTasks(params, { closedLaneOpen })` | One `GET /api/v1/tasks` query per status (ten), the per-column "load more" depth, and the in-flight moves |
| `useTaskFacetsQuery()` | Assignee, project, and creator options for the filter bar |
| `useTaskStatsQuery()` | Feeds the collapsed Closed lane's summary text ("41 done, 6 deferred") when no filter is active |
| `useTransitionTaskMutation()` | `POST /api/v1/tasks/:taskId/transition`, not bound to a single task id |

### API calls

| Call | Method | Endpoint |
| ---- | ------ | -------- |
| `listTasks(query)` ×10 | `GET` | `/api/v1/tasks?status=<column>&page=1&pageSize=25&…` — one request per status, `page` pinned to 1 |
| `getTaskFacets()` | `GET` | `/api/v1/tasks/facets` |
| `getTaskStats()` | `GET` | `/api/v1/tasks/stats` — the collapsed-lane summary |
| `transitionTask(id, input)` | `POST` | `/api/v1/tasks/:taskId/transition` |

No new endpoint: the board is ten readings of `GET /tasks`, one per status, plus the transition endpoint the detail page and inbox already use.

## Behavior / UI flow

1. **Ten queries, not one.** A board is ten independently-sized queues; one request big enough to fill every column would spend its paging on whichever status happens to be largest. Each column pages on its own and reports its own `meta.total` as the count in its heading.
2. **Lanes.** The ten columns are grouped by `TASK_STATUS_LANES` into four labelled lanes — **Plan** (backlog, needs refinement, to do), **Doing** (in progress, needs QA), **Waiting** (blocked, needs decision, needs action), **Closed** (done, deferred). Lanes stack vertically; from `lg` a lane's own columns share its width, below `lg` a lane scrolls sideways on its own.
3. **The Closed lane starts collapsed**, and its two columns' queries are not even fetched until it opens (`enabled: closedLaneOpen`) — finished work is the pile that only grows, and it is the one lane nobody works *in*. Collapsed, it shows a summary line built from `GET /tasks/stats` (only when no filter is active — the stats endpoint isn't filtered). A status filter naming a closed status opens the lane automatically, because a filter that selects a hidden column would look like it did nothing.
4. **Load more is per column**, +25 rows at a time up to `MAX_PAGE_SIZE` (100). Past that the column says "Showing the first 100 of N. Narrow the filters to see the rest." rather than offering a button that would 422.
5. **Dragging** is `@dnd-kit/core`: mouse drags activate after 6px of movement, touch drags after a 250ms press-and-hold. The dragged card is drawn in a `DragOverlay` portal.
6. **Dropping** posts a transition and shows the card in its new column immediately. The optimistic move is held in `useBoardTasks`'s `pendingMoves`, not written into the *list* cache — a move changes which query a row belongs to. The detail cache entry **is** written optimistically (and rolled back on failure): a card dragged to a new status and clicked straight into must not show the stale one.

   `onSettled` invalidates `lists()`, `details()`, `stats()`, and the events feed — see `invalidateAfterWorkflowWrite` in `api/tasks.ts` — **not `facets`**, which a status change cannot move.
7. **Every column accepts every drop**, because there is no from→to table ([../features/Task_Status_Lifecycle.md](../features/Task_Status_Lifecycle.md)): any status may move to any other. What differs is the *payload* a target needs. Dropping on `needs_refinement`, `blocked`, `needs_user_decision`, `needs_user_action`, `needs_qa`, or `deferred` opens `TransitionDialog` asking for that payload (a reason, the tasks it waits on, a question and options, instructions, a summary and links); dropping on `todo` opens it only when the task has no acceptance criteria yet. Cancelling the dialog reverts the optimistic move; a server rejection (an agent trying to move to `done` without `AGENTS_MAY_COMPLETE`, a stale precondition) reopens the dialog with the server's fields filled in, or toasts the failure when there is nothing to put on a field.
8. **Dropping a card on the column it came from does nothing** — no request. The API treats a same-status transition as a valid write-free-looking call in principle, but the round trip would still flash the card's busy state for nothing, so the client short-circuits it.
9. **The status filter picks columns**, rather than filtering rows inside them. `?status=todo&status=in_progress` means "show me these two columns"; applying the filter again inside each column would leave columns that are empty for a reason nothing on screen explains. Columns always render in lifecycle order, never in click order.
10. **`page` is ignored** — the board pages per column. The key is left in the URL untouched, so switching back to the list returns to the page you were on.
11. Cards link to the detail page from the reference and the title, carrying `{ from: search }` so "Back to tasks" returns to this board with its filters intact. The **filters** ride in that state; the **board itself** is remembered in `stores/taskView`, written on mount (`useRememberTaskView("board")`).

## States

| State | Rendering |
| ----- | --------- |
| Loading | Three `BoardCardSkeleton`s per column, and `—` in place of the count |
| Refetching (placeholder data) | The column dims to 60% and sets `aria-busy` — rows are kept, never torn down |
| Error | `ErrorPanel` **inside the failing column only**, with Retry. The other columns that loaded stay usable |
| Empty column | "…Nothing here — drop a task to move it." — the empty column is still a drop target |
| Move needs input | `TransitionDialog` opens with the card already shown in the new column; cancel reverts it |
| Move rejected | Card returns to its column (or the dialog reopens with the server's fields); error toast |
| Move succeeded | Success toast: "TASK-000042 moved to In progress" |

## Responsive

| Width | Layout |
| ----- | ------ |
| `< lg` | Each lane's columns are `85vw` (`sm:19rem`), in a horizontally scrolling, scroll-snapping row. The next column peeks in at the edge |
| `≥ lg` | A lane's columns share its width equally, no horizontal scroll |

Horizontal scrolling is per-lane and deliberate: a kanban column is a queue, and a queue that reflows into a stack is the list page again. The document itself never scrolls sideways — verified at 360px in `e2e/board.spec.ts` — via `min-w-0` (a flex item will not shrink below its content without it) and `relative` (the cards' `sr-only` spans are `position: absolute`, clipped only by a positioned ancestor).

**Vertically, the board grows with its content and the *page* scrolls it.** Columns are `items-start`, so each is as tall as its own queue. Column headings are `sticky top-14` from `lg` only — below it the board is a horizontal scroll container and `position: sticky` sticks to its nearest scrollport, not the window, so pinning it there would drift the heading over the first card.

## Accessibility

- **The "move to" select on each card is the keyboard and screen-reader path, and it is not a fallback.** `@dnd-kit`'s `KeyboardSensor` without `@dnd-kit/sortable`'s coordinate getter would move a floating card 25px per arrow press across a horizontally scrolling board. A real select announces all ten targets, commits in two keystrokes, and calls the same `move()` a drop does — including opening `TransitionDialog` when the target needs it.
- `useDraggable`'s `attributes` are deliberately **not** spread onto the card — applied anyway they would stop the `<li>` being a list item and add a focusable "button" that does nothing.
- Each column is a labelled `<section>`: "To do — 12 tasks". Each lane is a labelled `<section>` too: "Plan". The count badge is `aria-hidden`.
- A `sr-only` live region summarises every visible column's count, so a filter change is not silent for someone who cannot see the board.
- The Closed lane's collapse toggle is a real button with `aria-expanded` and `aria-controls`.
- Drag announcements are customised on `DndContext` — "Picked up task TASK-000042", "Over In progress" — instead of dnd-kit's defaults, which narrate library ids.
- Status is never carried by colour alone: the column heading names it, and the card's select shows it.

## Related

- [Tasks_List.md](./Tasks_List.md) — the other view of the same URL state
- [Inbox.md](./Inbox.md) — the same three "needs you" statuses, one item at a time instead of by column
- [../features/Task_Status_Lifecycle.md](../features/Task_Status_Lifecycle.md) — statuses, lanes, and transition payloads
- [../features/Task_Query_Filter_Sort_Page.md](../features/Task_Query_Filter_Sort_Page.md) — the query parameters both views read
- [../engineering/TESTING.md](../engineering/TESTING.md) — why the drag is covered end-to-end and not in jsdom
