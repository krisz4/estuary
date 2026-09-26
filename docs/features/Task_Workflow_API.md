---
type: Feature
title: Task workflow API
description: Every endpoint of the AI task manager — transitions, claims, decisions, dependencies, events — with the rules behind each.
resource: apps/api/src/routes/tasks.route.ts
tags: [tasks, agents, workflow, api]
status: canonical
---
# Task workflow API

The reference for anything that drives tasks programmatically — the web app, the MCP server (`apps/mcp`), or a script. Shapes are the zod schemas in `packages/contracts`; this page states the behaviour those schemas cannot.

Base path `/api/v1`. Errors use the standard envelope ([../engineering/API_ERROR_CONTRACT.md](../engineering/API_ERROR_CONTRACT.md)).

## Request headers

| Header | Required | Meaning |
| ------ | -------- | ------- |
| `X-Actor` | No (defaults to `human:anonymous`) | Who is acting: `agent:<name>` or `human:<name>`, lowercase. Recorded on every write. Malformed → `VALIDATION_ERROR` with `details["X-Actor"]`. `system:` is reserved for the server. See [Actors.md](./Actors.md). |
| `Authorization: Bearer <token>` | Only when the server sets `API_TOKEN` | Shared-secret gate for self-hosted deployments. Missing or wrong → `UNAUTHORIZED` (401). `/health` and `/docs` stay open. |

## Endpoints

| Method | Path | Body | Success | Notes |
| ------ | ---- | ---- | ------- | ----- |
| GET | `/tasks` | query: `taskListQuerySchema` | 200 `PaginatedTasks` | Filters: `status`, `priority`, `project`, `label` (repeatable), `assignee` / `assigneeIsNull`, `createdBy`, `claimedBy`, `parentId` / `parentIsNull`, `dependsOn`, `dependencyOf`, `q`, `createdFrom/To`. Full reference: [Task_Query_Filter_Sort_Page.md](./Task_Query_Filter_Sort_Page.md). |
| GET | `/tasks/facets` | — | 200 `TaskFacets` | Distinct `assignees`, `projects`, `labels`, `creators`. |
| GET | `/tasks/stats` | query: `project` (repeatable, optional) | 200 `TaskStats` | Count per status (all ten keys present) + `needsAttention`. |
| POST | `/tasks` | `CreateTaskInput` | 201 `Task`; **200** on idempotent replay | `status` ∈ backlog / needs_refinement / todo. Replay = same `idempotencyKey` on a still-open task — see [Idempotent create](#idempotent-create). |
| POST | `/tasks/next` | `NextTaskInput` | 200 `{ task: Task \| null }` | Atomically claims the best available task → `in_progress`. `project` / `label` (repeatable) / `minPriority` narrow the candidates. |
| GET | `/tasks/:taskId` | — | 200 `Task` | Includes comments, parent, children, dependencies, dependents, open decision. |
| PATCH | `/tasks/:taskId` | `UpdateTaskInput` | 200 `Task` | **No `status`** — use `/transition`. `{}` → `AT_LEAST_ONE_FIELD`. |
| DELETE | `/tasks/:taskId` | — | 204 | Dependents it was blocking are re-checked for auto-unblock. |
| POST | `/tasks/:taskId/transition` | `TransitionInput` | 200 `Task` | See [Task_Status_Lifecycle.md](./Task_Status_Lifecycle.md). |
| POST | `/tasks/:taskId/claim` | `{ expectedVersion? }` | 200 `Task` | Same as transitioning to `in_progress`. |
| POST | `/tasks/:taskId/heartbeat` | — | 200 `Task` | Extends the caller's lease. Does **not** bump `version` (it does move `updatedAt`, which Prisma manages — an actively worked task floats up an `updatedAt` sort, which is accurate). |
| POST | `/tasks/:taskId/release` | `ReleaseTaskInput` | 200 `Task` | Holder gives the task up → `todo`. |
| POST | `/tasks/:taskId/decision/answer` | `AnswerDecisionInput` | 200 `Task` | Answers the open decision → task goes to `todo`. |
| POST | `/tasks/:taskId/dependencies` | `AddDependencyInput` | 200 `Task` | This task depends on `dependsOnId`. |
| DELETE | `/tasks/:taskId/dependencies/:dependsOnId` | — | 200 `Task` | Removing the last open blocker of a `blocked` task auto-unblocks it. |
| POST | `/tasks/:taskId/comments` | `CreateCommentInput` | 201 `Comment` | `author` = `X-Actor`. |
| DELETE | `/tasks/:taskId/comments/:commentId` | — | 204 | |
| GET | `/events` | query: `eventsQuerySchema` | 200 `EventsResponse` | Cursor feed, oldest first by default. Poll with `after=<meta.nextAfter>`; page newest-first with `order=desc` and `before=<meta.nextBefore>`; narrow to an instant range with `from`/`to`. |
| GET | `/floor` | query: `floorQuerySchema` | 200 `FloorSnapshot` | The floor view's snapshot — see [Floor_Snapshot.md](./Floor_Snapshot.md). |
| GET | `/stats/history` | query: `historyQuerySchema` | 200 `HistoryResponse` | The Logbook's charts — see [History_Stats.md](./History_Stats.md). |

## Rules that cut across endpoints

### Versions (optimistic concurrency)

Every task has an integer `version`, starting at 1, incremented by every write to the task row (PATCH, transition, claim, release, dependency change, decision answer). Comments and heartbeats do not bump it. Any body that accepts `expectedVersion` fails with `VERSION_CONFLICT` (409, `details: { expected, current }`) when it does not match. Re-read and retry.

### Claims (leases)

- A claim is `claimedBy` + `claimExpiresAt`. It exists only while the task is `in_progress`; leaving `in_progress` for any status clears it.
- Lease length: `CLAIM_LEASE_MINUTES` (default 30). `heartbeat`, and any write by the holder, extends it.
- An expired lease serializes as `claim: null` and the task becomes claimable by anyone — that is how a crashed agent's work is recovered.
- **While anyone holds a live claim, *agents* other than the holder cannot write the task** (PATCH, transition, claim, dependencies, delete) → `TASK_ALREADY_CLAIMED` (409, `details: { claimedBy, expiresAt }`). Humans can always override; a human transition away from `in_progress` drops the agent's claim. Comments are open to everyone.
- `heartbeat` / `release` by someone who is not the holder → `NOT_CLAIM_HOLDER` (409). A human may `release` anyone's claim.

### `POST /tasks/next`

Candidates, in one ordering (`priorityRank` desc, then `createdAt` asc):

1. `todo` tasks whose dependencies are all `done`, and
2. `in_progress` tasks with no live claim (expired lease).

Filtered by `project` and `minPriority` when given. The claim is taken with a conditional update, so two agents calling `next` at once never receive the same task. Nothing available → `{ task: null }`.

### Dependencies

- `A depends on B` means A cannot start until B is `done`. `deferred` does **not** satisfy a dependency.
- A `→ blocked` transition whose `blockedBy` tasks are **all already `done`** and that has no `reason` is rejected (`VALIDATION_ERROR` on `blockedBy`): nothing would ever unblock it.
- Self-dependency → `VALIDATION_ERROR`; a dependency that would close a loop → `DEPENDENCY_CYCLE` (409, `details.path`); unknown `dependsOnId` → `VALIDATION_ERROR` on `dependsOnId`. Adding one that already exists is a no-op success.
- `openDependencyCount` on every task counts dependencies not yet `done`.
- **Auto-unblock:** when a task becomes `done`, is deleted, or a dependency is removed, every `blocked` dependent whose open-dependency count reaches 0 moves to `todo`, written by `system:taskmanager`.

### Decisions

- `→ needs_user_decision` creates a `Decision` from the transition's `decision` payload (withdrawing any older open one).
- `POST /tasks/:taskId/decision/answer` requires the task to be in `needs_user_decision` with an open decision, else `NO_OPEN_DECISION` (409). `choice`, when given, must be one of the option labels (`VALIDATION_ERROR` on `choice`). The task moves to `todo` (the acceptance-criteria gate is skipped — the task was already in flight) and `statusNote` records the answer.
- Leaving `needs_user_decision` any other way withdraws the open decision.
- **Any actor may answer**, agents included, and `answeredBy` records who did. That is deliberate: a human often answers by telling their agent in chat ("go with B"), and the MCP server then answers as that agent. The agent skill forbids answering a decision nobody told it the answer to; the server cannot tell those apart, so it does not try.

### Idempotent create

A `POST /tasks` with an `idempotencyKey` that already exists **on an open task** returns that task with **200** and changes nothing — even if the rest of the body differs. Agents should derive the key from what the task is about (e.g. `claude-code:<repo>:<slug>`) so a retried or repeated run cannot file duplicates.

**A key only dedupes against an open task.** Once the task holding a key is `done` or `deferred`, the key no longer identifies live intent — a follow-up filed months later under a recycled title must not come back as the closed original. The key is retired from the closed task (set to `null`, no version bump, no event — bookkeeping, not a content change) and the new `POST /tasks` creates a fresh task under the same key (**201**), atomically in the same write so a crash between the two never leaves the key on two rows or on none.

## Events

Every write appends a `TaskEvent`. Types and payloads:

| Type | Payload |
| ---- | ------- |
| `task.created` | `{ status, title }` |
| `task.updated` | `{ fields: string[] }` |
| `task.deleted` | `{ title }` |
| `task.status_changed` | `{ from, to, note }` |
| `task.claimed` | `{ expiresAt, via? }` (`via: "next"` when taken by `POST /tasks/next`) |
| `task.released` | `{ reason, claimedBy }` |
| `comment.created` / `comment.deleted` | `{ commentId, kind }` |
| `decision.requested` / `decision.answered` / `decision.withdrawn` | `{ decisionId, … }` (`requested` adds `question`; `answered` adds `choice`, `note`) |
| `dependency.added` / `dependency.removed` | `{ dependsOnId }` |
| `github.pull_request` | `{ action, repo, number, url, title, merged, deliveryId }` — written by `system:github` when a PR referencing the task is opened/reopened/closed/etc.; see [GitHub_Integration.md](./GitHub_Integration.md) |

Events are never deleted, and `taskId` is not a foreign key, so the feed still describes deleted tasks. Each event also carries `project` — the task's project **at the moment the event was recorded**, not joined live — so `GET /events?project=` still returns history for a task that was later deleted or moved to another project.

Each event also carries `taskTitle` — unlike `project` this is **joined at read time** from the task's current row, in one query per page (not per event), so it always reflects the latest title rather than the title at the time of the event. It is `null` once the task has been deleted.

`GET /events` also filters by `actor` and repeatable `type`, on top of `taskId` and `project` (`eventsQuerySchema`).

### Paging the feed backwards, and by date (the Logbook's event log)

`order` defaults to `asc` — the poller's order, oldest first, paged with `after=<meta.nextAfter>`. `order=desc` pages newest first instead, for the Logbook's event log: page with `before=<meta.nextBefore>`, which is the smallest id on the current page (`null` once the page comes back empty — there is nothing older). `meta.nextAfter` is still present on a `desc` page (the largest id seen), for a caller that wants to switch to live polling from where it is looking.

`from` (inclusive) and `to` (exclusive) narrow to an instant range, independent of `order`.

`order=asc` with none of `before`/`order`/`from`/`to` sent is byte-identical to the feed's original behaviour — nothing about the poller path changed.

## Related

- [Task_Status_Lifecycle.md](./Task_Status_Lifecycle.md) — statuses and what each transition requires
- [Actors.md](./Actors.md) — the `X-Actor` model
- [Agent_Integration.md](./Agent_Integration.md) — the MCP server and Claude Code setup
- [Labels.md](./Labels.md) — `label` filter and `task_next` narrowing
- [GitHub_Integration.md](./GitHub_Integration.md) — the `github.pull_request` event and the optional webhook
