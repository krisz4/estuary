---
type: Feature
title: Floor snapshot
description: GET /floor — the compact, graph-aware snapshot behind /tasks/floor. Scope vs filters, the shipped window, the cap, the dependency graph, and replay.
resource: apps/api/src/services/floor.service.ts
tags: [tasks, floor, dependencies, api]
status: canonical
---
# Floor snapshot

`GET /api/v1/floor` — everything the floor view (`docs/pages/Floor_And_Logbook_Plan.md`) needs in one call. The list endpoint (`GET /tasks`) is the wrong shape for it: it pages at 100 rows and carries no dependency edges, while the floor lays out every open task at once and draws what blocks what.

## Overview

| Concern | Location |
| ------- | -------- |
| Query + response schemas | `packages/contracts/src/floor.ts` |
| Service | `apps/api/src/services/floor.service.ts` |
| Route | `GET /api/v1/floor` in `apps/api/src/routes/floor.route.ts` |

## Scope vs filters

`project` is **scope**: rows outside it are not returned at all, and it is the header project switcher's job — the floor has no project chips (`docs/pages/Floor_And_Logbook_Plan.md`).

Every other filter param (`status`, `priority`, `label`, `assignee`/`assigneeIsNull`, `createdBy`, `claimedBy`, `parentId`/`parentIsNull`, `dependsOn`, `dependencyOf`, `q`, `createdFrom`/`createdTo` — the same set `GET /tasks` accepts, listed as `FLOOR_FILTER_KEYS`) does not remove a row. It sets `matches` on it instead, computed with the same `buildWhere()` the list query uses. The floor dims non-matching crates in place rather than moving anything; `meta.matchCount` counts the returned rows with `matches: true`. `matches` is `true` on every row when no filter is active.

## What is returned

Every **non-closed** task in scope is returned. A **closed** task (`done` or `deferred`) is returned only if it closed within the `shipped` window (`24h` default, or `7d`) — otherwise it is only counted in `meta.olderClosedCount`, the "+N in the Logbook" crate. `meta.total` counts everything in scope before either the window or the cap; `meta.statusCounts` (all ten keys) counts everything in scope too, regardless of the window or the cap.

**"Closed at" for the window**, live floor: `completedAt ?? updatedAt`. Under replay (`at`), see below.

## The cap

Capped at `FLOOR_TASK_CAP` (2000) rows; `meta.truncated` says so. Rows are chosen **must-show first**, then by priority, then recency:

1. **Must-show**: a human-attention status (`needs_user_decision`, `needs_user_action`, `needs_qa`), `in_progress`, `blocked`, or `urgent` priority.
2. Everything else, ordered by `priority` (severity) descending, then `updatedAt` descending.

## The dependency graph

`edges` and `refs`, plus two derived numbers per task:

- **`openBlockerCount`**: this task's unfinished dependencies. Only a `done` blocker satisfies one — a `deferred` blocker still counts as open, matching the workflow rule.
- **`unblocksCount`**: the number of distinct **non-closed** tasks transitively downstream of this one — the bottleneck score. Computed in memory from every `TaskDependency` row (not scoped to the floor's project — a cross-project dependent still counts), memoized per node so the whole graph is walked once. A cycle (prevented at write time by `assertDependencyAllowed`) is guarded against defensively: a node revisited mid-walk contributes nothing further rather than recursing forever.
- **`edges`**: every dependency edge touching a *returned* (post-cap) task. `satisfied` is `true` once the blocker is `done`.
- **`refs`**: a `TaskRef` for any edge endpoint, or `parentId`, that points outside the returned task set — a cross-project blocker, a closed task past the shipped window, or a task the cap left out.

## Other derived fields

- **`claim`**: `null` once the lease has expired, same rule as everywhere else in the API. Always `null` under replay.
- **`pullRequestUrl`**: the first link whose URL parses as a GitHub pull request (`parseGithubUrl(url).kind === "pull"`), or `null`.
- **`childCount`**: every subtask, regardless of scope — same as `TaskSummary`.
- **`meta.lastEventId`**: the highest `TaskEvent` id at snapshot time — the web client's live-motion polling (`docs/pages/Tasks_Map.md` § Live motion) starts `GET /events?after=` from here rather than re-diffing the whole snapshot. `meta.generatedAt` is when the snapshot was built.

## Replay (`?at=`)

`at` (an instant, ISO 8601 with an offset) puts the floor into a read-only view of an earlier moment. **Only status and existence are replayed** — titles, priority, labels, and every other field are today's values, and claims are always `null`.

**The rule**, computed once per task from its `task.status_changed` and `task.created` events (`createdAt <= at`):

1. If the task has a `task.status_changed` event at or before `at`, its status at `at` is the `to` of the *last* such event.
2. Otherwise, if it has a `task.created` event at or before `at`, its status is `payload.status` from that event.
3. Otherwise (no qualifying event at all — a row written outside the normal write path, e.g. a hand-seeded fixture with no event trail) it falls back to the task's *current* status. This is a best effort, not a guarantee: every task created through the API has a `task.created` event, so this fallback is not expected to fire in practice.

**A task created after `at` is excluded entirely** — it did not exist yet. A **deleted task is simply absent**: there is no "undelete" in a replay, since the row itself is gone and only its events survive (`taskId` is not a foreign key). This is an accepted limitation, not a bug: a replay of "everything that existed at T" cannot resurrect a row the database no longer has, and the events feed itself remains the accurate record of the deletion.

The **shipped window is relative to `at`**, not to now: `shippedSince = at - window`. The **"closed at" timestamp for the window**, under replay, is the `createdAt` of the `task.status_changed` (or `task.created`) event that put the task into its replayed closed status — not the real `completedAt` column, which can be `null` or wrong if the task was later reopened after `at` and is not `done`/`deferred` today.

`openBlockerCount`, `unblocksCount`, and edge `satisfied` also use replayed statuses under `at`, for consistency with the replayed crate statuses — showing "unblocks 3" against today's graph while the crates show yesterday's statuses would be misleading. This extends the replay computation to every node touched by a dependency edge (not just the floor's scope), so a cross-project blocker's replayed status is available too; a graph-only node created after `at` is a known, accepted edge case (see the service's doc comment).

`meta.at` echoes the instant back; `null` on the live floor.

## Performance

Bounded to a handful of queries regardless of scope size (tasks in scope, the whole `TaskDependency` table, one event query for replay, one ref lookup) — no N+1 per row. See the service's doc comments for the exact query list.

## Related

- [../pages/Floor_And_Logbook_Plan.md](../pages/Floor_And_Logbook_Plan.md) — the design this endpoint implements phase 1 of
- [Task_Query_Filter_Sort_Page.md](./Task_Query_Filter_Sort_Page.md) — the filter fields this endpoint shares
- [Task_Workflow_API.md](./Task_Workflow_API.md) — the events this endpoint replays
