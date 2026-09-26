---
type: Page
title: Task detail
description: Full task view — status transitions, claims, decisions, dependencies, comments, activity timeline, edit and delete.
resource: apps/web/src/pages/task-detail/
tags: [tasks, detail, status, claims, decisions, dependencies, comments, activity]
status: canonical
---
# Page Review: Task Detail

A separate page, not a modal, so the URL is shareable — an agent can paste `/tasks/42` into a hand-off note.

## Route

- Path: `/tasks/:taskId` — `taskId` is the integer id, which **is** the task number (`/tasks/42` ↔ `TASK-000042`). See [../features/Task_Numbering.md](../features/Task_Numbering.md). A non-numeric segment renders the in-page not-found state, not a 404 route.
- File: `src/pages/task-detail/TaskDetailPage.tsx`
- Type: Client component, data via TanStack Query, polling

## Dependencies

### Components used

| Component | Role on this page |
| --------- | ----------------- |
| `PageHeader` (`src/components/`) | Back link to the remembered list/map view (preserving its query string), reference + title, Edit/Delete actions |
| `StatusSelect` (`src/features/tasks/`) | Inline status control — reports the pick; the page decides whether to post the transition immediately or open `TransitionDialog` |
| `StatusNotePanel` | The "why" of the current status — `statusNote` — framed by heading + icon specific to that status ("Blocked because…", "What you need to do", "QA summary", …) |
| `DecisionAnswer` | The open `needs_user_decision` question, its options, and the answer controls — shown above both columns when present |
| `ClaimIndicator`, the page's own `ClaimPanel` | Who holds the live claim and until when; **Release** (any human may release anyone's claim) or **Claim** (an `in_progress` task whose lease expired) |
| `PriorityBadge`, `ActorBadge`, `LabelChips` | Priority; who created the task; the task's labels, each linking to `?label=` on the list |
| `TaskLinks` | The task's PR/branch/doc links, each rendered as a link only when it is `http(s)`. When the GitHub integration is enabled (`useGithubIntegrationQuery`), a link that resolves to a PR or issue gets a live `GithubStatusBadge` (open/draft/merged/closed, plus a checks dot for a PR) from `GET /tasks/:taskId/github`; loading shows a small skeleton, a failed request shows a quiet inline "Retry GitHub status" button, and the integration being off renders nothing extra at all |
| `TaskRefList` / `DependencyEditor` (`DependencyList.tsx`) | Parent, subtasks, and "Needed by" as read-only linked lists; "Waits on" as an editable list (add by task number, remove — no confirm needed since it only removes a link). Each ref shows its own `project` next to it when that differs from the current task's — dependencies and subtasks can cross repositories. "Waits on" and "Needed by" each carry a "View all in list" link (`?dependencyOf=<id>` / `?dependsOn=<id>`) to the full set on the list page |
| `PastDecisions` | Answered/withdrawn decisions, newest first — the record of what a task's open question resolved to, since `statusNote` is replaced by the next transition |
| `CommentThread` (`src/features/comments/`) | Ordered list of comments + `CommentComposer` |
| `ActivityTimeline` | The task's event log (`GET /events`), newest first, infinite-scroll-back via cursor paging |
| `TransitionDialog` | The form for whichever status the pending move targets — opened by `StatusSelect` or reused directly when a status change is rejected mid-flight |
| `ConfirmDialog` (`src/components/`) | Destructive confirmation for task delete, comment delete, and claim release |
| `DetailSkeleton`, `ErrorPanel`, `NotFoundState` | Async states |

**There is no `StatusBadge` on this page.** `StatusSelect` shows the current status *and* is the control that changes it.

### Hooks / API calls

| Call | Method | Endpoint |
| ---- | ------ | -------- |
| `getTask(taskId)` | `GET` | `/api/v1/tasks/:taskId` — includes comments, parent, children, dependencies, dependents, decisions, open decision |
| `transitionTask(taskId, input)` | `POST` | `/api/v1/tasks/:taskId/transition` — every status change |
| `claimTask(taskId, {})` | `POST` | `/api/v1/tasks/:taskId/claim` — take an unclaimed `in_progress` task |
| `releaseTask(taskId, {})` | `POST` | `/api/v1/tasks/:taskId/release` — give up a claim; task returns to `todo` |
| `deleteTask(taskId)` | `DELETE` | `/api/v1/tasks/:taskId` |
| `answerDecision(taskId, input)` | `POST` | `/api/v1/tasks/:taskId/decision/answer` — via `DecisionAnswer` |
| `addDependency` / `removeDependency` | `POST` / `DELETE` | `/api/v1/tasks/:taskId/dependencies[/:dependsOnId]` |
| `createComment` / `deleteComment` | `POST` / `DELETE` | `/api/v1/tasks/:taskId/comments[/:commentId]` |
| `listEvents({ taskId, limit, after })` | `GET` | `/api/v1/events` — the activity timeline |
| `getGithubIntegrationStatus()` | `GET` | `/api/v1/integrations/github` — gates the badges below |
| `getTaskGithubStatus(taskId)` | `GET` | `/api/v1/tasks/:taskId/github` — only fetched once the integration is known to be enabled |

Query key: `queryKeys.tasks.detail(taskId)`, polled every 15s. Workflow writes (transition, claim, release, decision answer, dependency add/remove) invalidate every list, every mounted detail, stats, and the events feed (`invalidateAfterWorkflowWrite` in `api/tasks.ts`) — not facets, which none of them can move. Comment writes invalidate only this task's detail and events keys.

## Behavior / UI flow

1. **Header** — `TASK-000042` as small muted text above the title; title as `<h1>`. Right side: "Edit" (→ `/tasks/:id/edit`) and "Delete" (destructive variant).
2. **Back link** returns to the view the user came from (list or map), carrying its previous search params. The path comes from `stores/taskView` (whichever view screen the user last had open); the query string comes from `location.state.from`, which the row/card the user clicked attaches. `useBackToListPath()` combines the two; the delete redirect uses the same value.
3. **Status note and open decision** sit above both columns — on mobile, above everything else, since that's what someone opening a task from the inbox came for. `StatusNotePanel` renders whenever `statusNote` is set (every status has one once a transition has set it); `DecisionAnswer` renders additionally when the status is `needs_user_decision` and an open decision exists.
4. **Inline status change** — picking a new value in `StatusSelect` either transitions immediately (`backlog`, `in_progress`, `done`, and `todo` when the task already has acceptance criteria — all of whose payload is an optional reason) or opens `TransitionDialog` for a target whose payload needs something from the user (`needs_refinement`, `blocked`, `needs_user_decision`, `needs_user_action`, `needs_qa`, `deferred`, or `todo` without criteria yet). See [../features/Task_Status_Lifecycle.md](../features/Task_Status_Lifecycle.md) for exactly what each target requires. A direct transition is optimistic on the detail cache and rolls back on failure; the failure (e.g. `TASK_ALREADY_CLAIMED` naming the claim holder) renders inline next to the control via `statusChangeErrorMessage`, and a `VALIDATION_ERROR` (the task's acceptance criteria were cleared by someone else a moment ago) reopens the dialog instead of just refusing.
5. **Claim panel.** While the task holds a live claim, the panel names the holder (agent icon for `agent:…`, lock for `human:…`) and its lease expiry, with a **Release** button (any human may release anyone's claim — the common case is an agent that went quiet). When the task is `in_progress` with no live claim (a crashed agent's lease ran out), the panel offers **Claim it** instead. Otherwise the panel renders nothing.
6. **Summary aside** — priority, project (or "No project"), assignee (or "Unassigned"), labels (`LabelChips`, when any), created by (`ActorBadge`), parent link when set — with its own project noted in parens when it differs from this task's — created/updated/started/completed timestamps (the last two only when set). Status is above it, on `StatusSelect` — there is no separate status row.
7. **Description** and **acceptance criteria** render as plain text with `whitespace-pre-wrap`; acceptance criteria shows "None yet. A task needs them before it can move to To do." when unset. Never `dangerouslySetInnerHTML`.
8. **Links, subtasks, dependencies, dependents, past decisions** each render as their own section, only when there is something to show (links, children, dependents, past decisions are omitted entirely when empty; "Waits on" always renders, since it is also where a dependency is added).
9. **Dependencies** ("Waits on") is editable: add a task by number in any spelling `parseReference` accepts (`12`, `#12`, `TASK-000012`), remove one with no confirm dialog (it deletes a link, not data — and removing the last open blocker of a `blocked` task auto-unblocks it server-side, which the next refetch shows).
10. **Comments** — oldest first, in the server's order, never re-sorted client-side. Each shows an `ActorBadge`, a kind tag when the kind is not `note` (`progress`, `qa_feedback`), relative timestamp, body, and a delete button revealed on hover/focus only under `@media (hover: hover)` (always visible on touch). The composer posts as the session actor (`useSessionActor()` — see [App_Shell.md](./App_Shell.md)) with a kind selector; it clears only on success and the new comment gets focus.
11. **Activity timeline** — the event log from `GET /events?taskId=`, newest first on screen (the feed itself pages oldest-first, so "Load newer activity" sits above the list). Every event type renders a human phrase from `describeEvent()` — status changes, claims, comments, decisions, dependency changes — reading payload values defensively so a malformed payload still produces a generic line rather than a crash.
12. **Delete** — opens `ConfirmDialog` naming the task and its comment count. On confirm: `DELETE`, invalidate the list-shaped keys (not the detail cache itself, which is marked stale with `refetchType: "none"` so the page mid-navigation does not refetch a task it just deleted), toast, navigate to the remembered list/map.

## States

| State | Behavior |
| ----- | -------- |
| Loading | `DetailSkeleton` mirroring the real layout |
| Error (network/5xx) | `ErrorPanel` + Retry |
| `TASK_NOT_FOUND` (a malformed id, or a deleted/never-existed task) | `NotFoundState`: "This task doesn't exist or was deleted" + "Back to tasks". Not a toast, not a blank page |
| Deleted in another tab | The next poll or refetch 404s and lands in the same not-found state |
| Empty comments | "No comments yet." above the composer |
| No activity yet | "No activity recorded yet." |
| Status change pending | `StatusSelect` disabled; the rest of the page stays interactive |
| Status change needs input | `TransitionDialog` opens over the page |

## Responsive

| Breakpoint | Layout |
| ---------- | ------ |
| < `md` | Single column; the **summary aside comes first** (`order-1`), then description/comments/activity (`order-2`) — otherwise a phone user scrolls past the whole thread to find the status they opened the task for. Edit/Delete wrap under the title |
| ≥ `md` | Two columns: main content (`order-1`), summary aside (`order-2`, `w-72`, `shrink-0`) |

## Accessibility

- `<h1>` is the task title; section headings (Description, Activity, Comments, …) are `<h2>`; comment authors and decision questions inside the aside/inbox reuse the appropriate heading level via a `headingLevel` prop.
- Status changes announce through a polite live region ("Status changed to In progress").
- `ConfirmDialog` traps focus, closes on `Escape`, restores focus, and is labelled by its heading.
- Delete-comment and remove-dependency buttons carry per-row labels naming the comment's author or the dependency's reference.
- The comment list is a `<ul aria-label="Comment thread">`; timestamps use `<time datetime>`.

## Related

- [../features/Tasks.md](../features/Tasks.md), [../features/Comments.md](../features/Comments.md)
- [../features/Task_Status_Lifecycle.md](../features/Task_Status_Lifecycle.md), [../features/Task_Workflow_API.md](../features/Task_Workflow_API.md) — claims, decisions, dependencies, events
- [Task_Edit.md](./Task_Edit.md), [Tasks_List.md](./Tasks_List.md), [Inbox.md](./Inbox.md)
