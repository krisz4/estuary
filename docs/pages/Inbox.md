---
type: Page
title: Inbox
description: Everything waiting on a human at /inbox — the whole attention queue, grouped by kind, clearable without opening the task.
resource: apps/web/src/pages/inbox/
tags: [tasks, inbox, decisions, qa, attention, needsTriage, projects, focus]
status: canonical
---
# Page Review: Inbox

The queue for everything the [attention queue](../features/Attention_Queue.md) puts in front of a person: the three ways an agent explicitly stops (a question, a manual step, finished work awaiting QA), plus the three ways work sits unseen without anyone asking (`needs_refinement`, an un-triaged agent suggestion, a task blocked for an outside reason). Every item can be cleared **without opening the task**.

## Route

- Path: `/inbox`
- File: `src/pages/inbox/InboxPage.tsx`
- Type: Client component, data via TanStack Query, polling
- Linked from `AppHeader`'s "Inbox" nav item on every screen, with a live count badge

## Dependencies

### Components used

| Component | Role on this page |
| --------- | ----------------- |
| `InboxItem` (`src/pages/inbox/InboxItem.tsx`) | One task, switched on its [attention kind](../features/Attention_Queue.md#the-six-kinds) into a decision/action/QA/refine/suggested/blocked layout — see [Behavior](#behavior--ui-flow). **Has other consumers:** `/tasks/map`'s hero rail and its `#needs-you` section ([Tasks_Map.md](./Tasks_Map.md)) and [`/inbox/focus`](./Inbox_Focus.md) render this same component against their own `useInboxQuery` calls, rather than a lookalike copy of the controls — a change here (a new field, a new action, a copy edit) shows up in both places automatically. |
| `groupByAttentionKind` (`src/pages/inbox/attentionGroups.ts`) | Partitions the loaded tasks by `attentionKindOf`, in `ATTENTION_KINDS` order, empty groups omitted — the one grouping both this page and the map's "Needs you" section use, so neither can drift from the other or from the server's own `?attention=true` filter |
| `DecisionAnswer` (`src/features/tasks/`) | The question, context, options (with the recommended one starred), and a free-text answer — shared verbatim with [Task_Detail.md](./Task_Detail.md) |
| `StatusNotePanel` | Renders the task's `statusNote` (instructions, or the QA summary) when present; a fallback line links to the task when it is not |
| `TaskLinks`, `PriorityBadge`, `ActorBadge` | Per-item metadata |
| `TransitionDialog` | Opens for a "Done — hand back" move, since `todo` needs acceptance criteria the task may not have yet |
| `EmptyState`, `ErrorPanel` (`src/components/`) | Async states |
| `ReachEyebrow` (`src/components/`) | "THE POOLS *where work waits on you*" above the heading, in the Map's region voice |
| `Button`, `Dialog`, `FormErrorSummary` (`src/components/ui`, `src/components/`) | The "Send back" and refine-criteria dialogs' fields |

### Hooks

| Hook | Role |
| ---- | ---- |
| `useInboxQuery(projects)` | `GET /api/v1/tasks` with `attention: true`, `pageSize: 100`, `sort: "priority:desc"`, plus `project` when the URL names any (`toInboxQuery`) — one request, grouped client-side by attention kind in `ATTENTION_KINDS` order. Polls every 15s |
| `useRememberProjectScope(projects)` | Records the URL's project as the header's scope — see [App_Shell.md](./App_Shell.md) |
| `useTransitionTaskMutation()` | Answering an action, approving/rejecting QA, refining into `todo`, unblocking, dismissing, and parking are all transitions |
| `useAnswerDecisionMutation()` | Via `DecisionAnswer` |
| `useSendBackMutation()` | The QA "Send back" action — see below |
| `useUpdateTaskMutation()` | The Suggested group's "Accept" (`PATCH { needsTriage: false }`) |

### API calls

| Call | Method | Endpoint |
| ---- | ------ | -------- |
| `listTasks(toInboxQuery(projects))` | `GET` | `/api/v1/tasks?attention=true&pageSize=100&sort=priority:desc[&project=…]` |
| `transitionTask(id, input)` | `POST` | `/api/v1/tasks/:taskId/transition` |
| `updateTask(id, { needsTriage: false })` | `PATCH` | `/api/v1/tasks/:taskId` |
| `answerDecision(id, input)` | `POST` | `/api/v1/tasks/:taskId/decision/answer` |
| `createComment(id, input)` | `POST` | `/api/v1/tasks/:taskId/comments` — the `qa_feedback` comment a send-back also writes |

`INBOX_QUERY` is fixed apart from `project` — the inbox's one URL param, `?project=<slug>` (repeatable, validated like the list's) — and it goes through `queryKeys.tasks.list()` like every other list, so a transition or PATCH made anywhere in the app refreshes it through the same `lists()` invalidation prefix.

## Route params

| Param | Effect |
| ----- | ------ |
| `project` | Repeatable. Narrows the inbox to those projects. Set by the header's project switcher ([App_Shell.md](./App_Shell.md)) or a breakdown link; invalid slugs are dropped |

## Behavior / UI flow

1. One request returns the whole attention queue, capped at 100 and sorted by priority. The page groups the result client-side with `groupByAttentionKind`, in this order — **Decide, Act, Review, Refine, Suggested, Blocked outside** — each with a short explanation of what to do, and omits any group with nothing in it. If the total exceeds what was returned, a line says "Showing the N most urgent of total. Clear some to see the rest." — there is no pager here; the answer is to clear items, not to page through them.
2. **Decide** (`needs_user_decision`) render `DecisionAnswer` directly: pick an option (posts `{ choice }`, moving the task to `todo`) or answer in free text alone. A decision item with no `openDecision` present (a poll racing a transition) falls back to a note-or-link line rather than rendering nothing.
3. **Act** (`needs_user_action`) show the instructions (`statusNote`, via `StatusNotePanel`, or a fallback when none was given) and two buttons: **Done — hand back** (→ `todo`, with a fixed note `"A human did the manual step. Carry on."` — this goes through the same `transitionNeedsInput` check as anywhere else, so a task with no acceptance criteria opens `TransitionDialog` to collect them instead of failing the request) and **Mark done** (→ `done` directly).
4. **Review** (`needs_qa`) show the summary (`statusNote`), any links, and acceptance criteria behind a `<details>` disclosure. An item carrying `concerns` renders them prominently, right under the summary, and is never offered for batch approval — it is asking for a close look, not a rubber stamp. A **routine** item (no `concerns`) renders compactly instead, and the group header offers **"Approve all routine (N)"**, batching every routine item in the group to `done` after one confirm dialog that lists them (a bulk move to `done`, and "routine" only means no concerns were raised — hand-offs from before `concerns` existed count as routine too). Every Review item still has its own **Approve** (→ `done`) and **Send back**, which opens a dialog asking "What needs fixing?" and, on submit, performs **two writes in order** via `useSendBackMutation`: a transition to `todo` with the typed text as the transition's `reason` (what the next agent reads first), then a `qa_feedback` comment with the same text (which survives the next transition, unlike `statusNote`). If the transition fails, nothing was written and the dialog shows the error. If the transition succeeds but the comment fails, the send-back is reported as done with a toast noting the feedback comment failed separately — the status change already happened and is not rolled back for a second write's failure.
5. **Refine** (`needs_refinement`) show what is missing (`statusNote`, the `reason` the refinement transition required) and an inline form — acceptance criteria plus optional notes — that transitions the task to `todo` carrying those criteria in the same call. **Dismiss** transitions it to `deferred` with reason `"Dismissed from the inbox"` instead.
6. **Suggested** (`backlog`/`todo` with `needsTriage`) show the task as filed, with two actions: **Accept** (`PATCH { needsTriage: false }` — the task stays in its current status, just no longer flagged as unreviewed) and **Dismiss** (→ `deferred`, same reason as Refine's dismiss).
7. **Blocked outside** (`blocked` with no unfinished dependency) show the blocking reason (`statusNote`) and two actions: **Unblock** (→ `todo` — opens `TransitionDialog` first if the task has no acceptance criteria yet, same rule as every other move into `todo`) and **Park** (→ `deferred` with reason `"Parked from the inbox"`).
8. **Context on every card**, regardless of group: "Follow-up of TASK-…" (linked) when the task has a `parentId`, a subtask count when it has children, "waits on N" when `openDependencyCount > 0`, and how long it has been waiting (`waiting since {relative}`, from `updatedAt`) — the same facts a person needs to decide whether to deal with this now or let it sit.
9. Every clearing action removes the item from the inbox via the same `invalidateAfterWorkflowWrite` prefix every other workflow write uses — the item disappears once the poll or immediate invalidation refetches. The Accept action (a plain PATCH) invalidates through `tasks.all` like any other edit.
10. There is no per-item navigation requirement: the reference and title are links to the full task, for anyone who wants more context than the inbox card gives, but every action here can be completed without following them.
11. **Focus mode.** The header's **Focus mode** button (shown when anything is waiting) opens [`/inbox/focus`](./Inbox_Focus.md) in the same project scope; each group with two or more items has a **Focus** link ("Focus on Act (2)") to `/inbox/focus?kind=<kind>`.
12. **Projects.** Unscoped, when the loaded items span two or more projects, a line under the heading reads "From billing-service (5), estuary (4), mobile-app (3)" — most items first — each linking to `/inbox?project=<slug>`. Counts are of the loaded items (so under the 100-item cap they describe what is shown). Scoped, the line reads "Showing estuary only. Show all projects" instead; it is omitted when the scoped inbox is empty, since the empty state says the same with the same link.

## States

| State | Behavior |
| ----- | -------- |
| Loading | Skeleton mirroring the group layout |
| Empty | `EmptyState art="still-water"` (a bead on still water), "Nothing needs you", a "Slack water: …" description, and a "Go to the map" CTA (→ `/tasks/map`) — distinct from "no tasks exist"; the inbox being empty is a normal, good state. Scoped: "Nothing in estuary needs you" + "Show all projects" (→ `/inbox`) |
| Error | `ErrorPanel` + Retry. A failed background poll keeps the existing items on screen and shows the panel above them rather than blanking the page |
| Item action pending | That item's button shows a spinner; the rest of the page stays interactive |
| Capped result | "Showing the N most urgent of total" line beneath the groups |

## Responsive

Single column at every width — the inbox is a list of self-contained cards, not a table, so there is no `md` breakpoint to speak of. Each card's action buttons stack full-width below `sm` and sit side by side above it, matching the pattern used for dialog footers elsewhere in the app.

## Accessibility

- Each attention group is a labelled `<section>` ("Review (2)"); each item is an `<article aria-labelledby>` naming its own reference and title.
- `DecisionAnswer`'s heading level is set to `4` here (the item's own title is an `h3`), so the DOM outline stays correct.
- The result count is announced via a polite live region ("N tasks waiting on you") after the initial load and after any change.
- Buttons are named for the action, not just an icon ("Done — hand back", "Approve", "Send back", "Approve all routine (N)", "Unblock", "Park", "Accept", "Dismiss").

## Related

- [../features/Attention_Queue.md](../features/Attention_Queue.md) — the six attention kinds, `needsTriage`, `concerns`, follow-ups
- [../features/Task_Status_Lifecycle.md](../features/Task_Status_Lifecycle.md) — the ten statuses and what each transition requires
- [../features/Comments.md](../features/Comments.md) — the `qa_feedback` comment kind a send-back writes
- [Task_Detail.md](./Task_Detail.md) — the same `DecisionAnswer` control, and the full record once an item is cleared
- [Inbox_Focus.md](./Inbox_Focus.md) — the same queue one item at a time
- [Tasks_Map.md](./Tasks_Map.md) — the "Needs you" section uses the same `attention=true` query and `groupByAttentionKind`
