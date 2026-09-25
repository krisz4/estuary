---
type: Page
title: Inbox
description: Everything waiting on a human at /inbox — decisions, manual actions, and QA — clearable without opening the task.
resource: apps/web/src/pages/inbox/
tags: [tasks, inbox, decisions, qa, human-attention]
status: canonical
---
# Page Review: Inbox

The queue for the three ways an agent stops and hands work to a person (`HUMAN_ATTENTION_STATUSES`): it asked a question (`needs_user_decision`), it needs a manual step (`needs_user_action`), or it finished and wants verification (`needs_qa`). Every item can be cleared **without opening the task**.

## Route

- Path: `/inbox`
- File: `src/pages/inbox/InboxPage.tsx`
- Type: Client component, data via TanStack Query, polling
- Linked from `AppHeader`'s "Inbox" nav item on every screen, with a live count badge

## Dependencies

### Components used

| Component | Role on this page |
| --------- | ----------------- |
| `InboxItem` (`src/pages/inbox/InboxItem.tsx`) | One task, switched on its status into `DecisionAnswer`, an "Actions" layout, or a "QA" layout — see [Behavior](#behavior--ui-flow) |
| `DecisionAnswer` (`src/features/tasks/`) | The question, context, options (with the recommended one starred), and a free-text answer — shared verbatim with [Task_Detail.md](./Task_Detail.md) |
| `StatusNotePanel` | Renders the task's `statusNote` (instructions, or the QA summary) when present; a fallback line links to the task when it is not |
| `TaskLinks`, `PriorityBadge`, `ActorBadge` | Per-item metadata |
| `TransitionDialog` | Opens for a "Done — hand back" move, since `todo` needs acceptance criteria the task may not have yet |
| `EmptyState`, `ErrorPanel` (`src/components/`) | Async states |
| `Button`, `Dialog`, `FormErrorSummary` (`src/components/ui`, `src/components/`) | The "Send back" dialog's one field |

### Hooks

| Hook | Role |
| ---- | ---- |
| `useInboxQuery()` | `GET /api/v1/tasks` with `status` set to all three `HUMAN_ATTENTION_STATUSES`, `pageSize: MAX_PAGE_SIZE`, `sort: "priority:desc"` — one request, grouped client-side by status in lifecycle order. Polls every 15s |
| `useTransitionTaskMutation()` | Answering an action or approving/rejecting QA is a transition |
| `useAnswerDecisionMutation()` | Via `DecisionAnswer` |
| `useSendBackMutation()` | The QA "Send back" action — see below |

### API calls

| Call | Method | Endpoint |
| ---- | ------ | -------- |
| `listTasks(INBOX_QUERY)` | `GET` | `/api/v1/tasks?status=needs_user_decision&status=needs_user_action&status=needs_qa&pageSize=100&sort=priority:desc` |
| `transitionTask(id, input)` | `POST` | `/api/v1/tasks/:taskId/transition` |
| `answerDecision(id, input)` | `POST` | `/api/v1/tasks/:taskId/decision/answer` |
| `createComment(id, input)` | `POST` | `/api/v1/tasks/:taskId/comments` — the `qa_feedback` comment a send-back also writes |

`INBOX_QUERY` is a fixed request (no URL state — the inbox has no filters), but it goes through `queryKeys.tasks.list()` like every other list, so a transition made anywhere in the app refreshes it through the same `lists()` invalidation prefix.

## Behavior / UI flow

1. One request returns every task in the three attention statuses, capped at `MAX_PAGE_SIZE` (100) and sorted by priority. The page groups them client-side into three sections in lifecycle order — **Decisions**, **Actions**, **Ready for QA** — each with a short explanation of what to do, and omits any section with nothing in it. If the total exceeds what was returned, a line says "Showing the N most urgent of total. Clear some to see the rest." — there is no pager here; the answer is to clear items, not to page through them.
2. **Decisions** (`needs_user_decision`) render `DecisionAnswer` directly: pick an option (posts `{ choice }`, moving the task to `todo`) or answer in free text alone. A decision item with no `openDecision` present (a poll racing a transition) falls back to a note-or-link line rather than rendering nothing.
3. **Actions** (`needs_user_action`) show the instructions (`statusNote`, via `StatusNotePanel`, or a fallback when none was given) and two buttons: **Done — hand back** (→ `todo`, with a fixed note `"A human did the manual step. Carry on."` — this goes through the same `transitionNeedsInput` check as anywhere else, so a task with no acceptance criteria opens `TransitionDialog` to collect them instead of failing the request) and **Mark done** (→ `done` directly).
4. **Ready for QA** (`needs_qa`) show the summary (`statusNote`), any links, and acceptance criteria behind a `<details>` disclosure. Two buttons: **Approve** (→ `done`) and **Send back**, which opens a dialog asking "What needs fixing?" and, on submit, performs **two writes in order** via `useSendBackMutation`: a transition to `todo` with the typed text as the transition's `reason` (what the next agent reads first), then a `qa_feedback` comment with the same text (which survives the next transition, unlike `statusNote`). If the transition fails, nothing was written and the dialog shows the error. If the transition succeeds but the comment fails, the send-back is reported as done with a toast noting the feedback comment failed separately — the status change already happened and is not rolled back for a second write's failure.
5. Every clearing action removes the item from the inbox via the same `invalidateAfterWorkflowWrite` prefix every other workflow write uses — the item disappears once the poll or immediate invalidation refetches.
6. There is no per-item navigation requirement: the reference and title are links to the full task, for anyone who wants more context than the inbox card gives, but every action here can be completed without following them.

## States

| State | Behavior |
| ----- | -------- |
| Loading | Skeleton mirroring two card-shaped groups |
| Empty | "Nothing needs you" + "Go to the board" CTA (→ `/tasks/board`) — distinct from "no tasks exist"; the inbox being empty is a normal, good state |
| Error | `ErrorPanel` + Retry. A failed background poll keeps the existing items on screen and shows the panel above them rather than blanking the page |
| Item action pending | That item's button shows a spinner; the rest of the page stays interactive |
| Capped result | "Showing the N most urgent of total" line beneath the groups |

## Responsive

Single column at every width — the inbox is a list of self-contained cards, not a table, so there is no `md` breakpoint to speak of. Each card's action buttons stack full-width below `sm` and sit side by side above it, matching the pattern used for dialog footers elsewhere in the app.

## Accessibility

- Each status group is a labelled `<section>` ("Decisions (2)"); each item is an `<article aria-labelledby>` naming its own reference and title.
- `DecisionAnswer`'s heading level is set to `4` here (the item's own title is an `h3`), so the DOM outline stays correct.
- The result count is announced via a polite live region ("N tasks waiting on you") after the initial load and after any change.
- Buttons are named for the action, not just an icon ("Done — hand back", "Approve", "Send back").

## Related

- [../features/Task_Status_Lifecycle.md](../features/Task_Status_Lifecycle.md) — the ten statuses, `HUMAN_ATTENTION_STATUSES`, and what each transition requires
- [../features/Comments.md](../features/Comments.md) — the `qa_feedback` comment kind a send-back writes
- [Task_Detail.md](./Task_Detail.md) — the same `DecisionAnswer` control, and the full record once an item is cleared
- [Tasks_Board.md](./Tasks_Board.md) — the "Needs you" status preset selects the same three columns
