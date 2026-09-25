---
type: Feature
title: Comments
description: Task comment thread — model, endpoints, ordering, kinds, and cascade behavior.
resource: apps/api/src/services/comment.service.ts
tags: [tasks, comments, api]
status: canonical
---
# Comments

The thread mixes human discussion with an agent's own working notes. They are modelled as a child table rather than a text blob so each entry keeps its own author, kind, and timestamp.

## Overview

| Concern | Location |
| ------- | -------- |
| Prisma model | `Comment` in `apps/api/prisma/schema.prisma` |
| Shapes | `packages/contracts/src/comment.ts` |
| Service | `apps/api/src/services/comment.service.ts` |
| Route | `apps/api/src/routes/comments.route.ts` (mounted under `/tasks/:taskId/comments`) |
| MCP tool | `task_comment` in [Agent_Integration.md](./Agent_Integration.md) |

## Data model

| Field | Type | Notes |
| ----- | ---- | ----- |
| `id` | `Int` | Autoincrement. Monotonic, which is what makes the ordering tiebreaker correct |
| `taskId` | `Int` | FK → `Task.id`, `onDelete: Cascade` |
| `author` | `String` | The actor that posted it (`X-Actor`) — `agent:claude-code`, `human:dana`, not a free-text name. See [Actors.md](./Actors.md) |
| `kind` | `String` | `note` (default, ordinary discussion) \| `progress` (an agent's working log while it holds the task) \| `qa_feedback` (why a `needs_qa` hand-off was sent back) |
| `body` | `String` | 1–5000 chars, trimmed. Plain text, rendered escaped |
| `createdAt` | `DateTime` | |

No `updatedAt`: comments are append-only. There is no edit endpoint, because an editable audit trail that nobody audits is just a mutable field with extra steps.

## Rules

- **Ordering is `createdAt` ascending, then `id` ascending** (oldest first) everywhere — the thread reads top to bottom. The `id` tiebreaker is reliable *because* ids are sequential integers; the seed creates several comments inside the same millisecond, so without a monotonic tiebreaker their order would be arbitrary and would differ between runs.
- **Comments load with the task.** `GET /tasks/:taskId` includes the full `comments` array. There is no separate list endpoint and no comment pagination.
- **List responses never include comments**, only `commentCount`. Including them would turn the list query into an N+1.
- **Deleting a task deletes its comments** via FK cascade, enforced at the database level rather than in application code, so it holds even for direct SQL.
- **Comment writes do not touch `Task.version`, and mostly do not touch `Task.updatedAt`.** `version` bumping on a comment would turn every agent progress note into a `VERSION_CONFLICT` for whoever else is editing the task. The one exception: **a comment from the claim holder renews their lease** (an ordinary `claimExpiresAt` update, which does move `updatedAt` — acceptable, since the task is actively in progress). Comments are open to every actor regardless of who holds the claim.
- **Every add/delete records an event** (`comment.created` / `comment.deleted`, payload `{ commentId, kind }` / `{ commentId }`) — see [Task_Workflow_API.md](./Task_Workflow_API.md#events).

## API

| Method | Path | Purpose | Success |
| ------ | ---- | ------- | ------- |
| `POST` | `/api/v1/tasks/:taskId/comments` | Add a comment | `201` + `Location` + the created comment |
| `DELETE` | `/api/v1/tasks/:taskId/comments/:commentId` | Remove one | `204`, no body |

There is no `GET` and no `PUT`. The thread ships with its task (`GET /tasks/:taskId` includes `comments`), so a second read path would need its own ordering and paging rules to keep in step with the first; and comments are append-only, so there is nothing to `PUT`. Both fall through to the `notFound` middleware as `NOT_FOUND` 404 — the contract has no `METHOD_NOT_ALLOWED`.

The router is mounted at `/api/v1/tasks/:taskId/comments` with `Router({ mergeParams: true })`. Without that flag `:taskId` is captured by the mount path and never reaches the handler, so every comment request 404s — which reads as "the task does not exist" rather than "the router is misconfigured".

```http
POST /api/v1/tasks/42/comments
X-Actor: agent:claude-code

{ "body": "Reissued the client certificate — retry and let me know.", "kind": "progress" }
```

### Not-found handling

**`POST` checks that the task exists before inserting.** Relying on the foreign key to fail is not sufficient: a missing parent raises Prisma `P2003` (foreign key constraint failed), not `P2025`, so an unguarded insert would surface as a 500 instead of the documented 404. The service does an explicit `findUnique` and throws `TASK_NOT_FOUND`.

**`DELETE` scopes by both ids** — `deleteMany({ where: { id: commentId, taskId } })` — and treats a zero count as `COMMENT_NOT_FOUND`. That covers both "no such comment" and "the comment exists but belongs to a different task" with the same 404, so the path cannot be used to probe for other tasks' comment ids. A `findUnique` + compare would leak the difference through timing and through the temptation to return 403.

## Error codes

| Code | Status | When |
| ---- | ------ | ---- |
| `TASK_NOT_FOUND` | 404 | Parent task missing, or `:taskId` is not a positive integer |
| `COMMENT_NOT_FOUND` | 404 | Comment missing, not on this task, or `:commentId` is not a positive integer |
| `VALIDATION_ERROR` | 422 | Empty body, over-length body, unknown `kind` |

The body is validated **before** the parent is looked up, so `POST /tasks/999999/comments` with an invalid payload is a 422, not a 404. Either answer would be defensible; a route test pins which one the API gives so a reordering of the handler is a visible change.

## Related pages

- [Tasks.md](./Tasks.md)
- [Task_Workflow_API.md](./Task_Workflow_API.md)
- [Error_Handling.md](./Error_Handling.md)
