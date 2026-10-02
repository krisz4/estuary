---
type: Feature
title: Task cleanup
description: Bulk hard-delete of done tasks — the human-triggered POST /tasks/cleanup and the automatic DONE_RETENTION_DAYS sweep.
resource: apps/api/src/services/task-cleanup.service.ts
tags: [tasks, delete, retention]
status: canonical
---
# Task cleanup

Finished work piles up. Two ways to remove it, both deleting **only `done` tasks** — no other status is ever touched, `deferred` included.

| Trigger | Who | What goes |
| ------- | --- | --------- |
| "Clean up done" on the Tasks list ([Tasks_List.md](../pages/Tasks_List.md)) → `POST /api/v1/tasks/cleanup` | a human | every done task in the list's project scope (all projects when the list is unscoped) |
| Retention sweep in the API process | `system:taskmanager` | done tasks completed more than `DONE_RETENTION_DAYS` ago (default **90**) |

## `POST /api/v1/tasks/cleanup`

Body (all optional; an empty or missing body deletes every done task):

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `project` | `string[]` | Only these projects. Lowercased like everywhere else |
| `olderThanDays` | int 0–3650 | Only tasks completed more than this many days ago. `0` or absent = no age limit |
| `dryRun` | boolean | Return what would be deleted without deleting it |

Response `200`: `{ deleted, taskIds, dryRun }` — `taskIds` ascending. Schemas: `cleanupDoneTasksInputSchema` / `cleanupDoneTasksResponseSchema` in `packages/contracts/src/task-workflow.ts`.

Errors: `ACTOR_NOT_PERMITTED` (403) for any `agent:` actor, dry run included; `VALIDATION_ERROR` (422) for an unknown field or an out-of-range `olderThanDays`. There is deliberately **no MCP tool** for it: deleting finished work in bulk is a human's call, like closing a task.

## What a cleanup does

The same as a single `DELETE /tasks/:id` ([Tasks.md](./Tasks.md)), for each task, in one write transaction:

- Comments, decisions, labels, and dependency rows cascade.
- Subtasks of a deleted parent **survive** as top-level tasks (`parentId` → `null`).
- A `task.deleted` event is recorded per task with `payload: { title, reason: "cleanup" }`, stamped with the task's project. Earlier events stay, so the Logbook and `GET /stats/history` (both event-based) are unaffected.
- Dependents are re-checked for auto-unblock. A `done` dependency never blocked anyone, so in practice nothing moves.
- The selection is made inside the transaction, so a task reopened after the UI read its count is not deleted.

"Completed" means `completedAt`, set on every move to `done`. A done row without it (hand-edited, or older than the column) falls back to `updatedAt`, so a missing stamp never keeps a task forever.

## Retention sweep

Started by `src/server.ts` (never by `createApp()`, so tests and the seed never run it): once at boot, then every six hours. The timer is `unref()`ed and stopped on shutdown; a failed pass is logged and retried at the next tick. `DONE_RETENTION_DAYS=0` turns it off — the manual endpoint still works. The E2E API process runs with `0`, so no spec races a background delete.

The seed's oldest task is 58 days old, so a freshly seeded database loses nothing to the default.
