---
type: Feature
title: Tasks
description: The Task resource — fields, CRUD endpoints, validation rules, and delete semantics.
resource: apps/api/src/services/task.service.ts
tags: [tasks, crud, api, core]
status: canonical
---
# Tasks

The single core resource. Everything else in the product — comments, decisions, dependencies, events — hangs off it. Status transitions, claims, decisions, and dependencies are their own feature docs; this one is the resource itself: fields, plain CRUD, and delete.

## Overview

| Concern | Location |
| ------- | -------- |
| Prisma model | `Task` in `apps/api/prisma/schema.prisma` |
| Shapes + validation | `packages/contracts/src/task.ts` |
| CRUD logic | `apps/api/src/services/task.service.ts` |
| HTTP layer | `apps/api/src/routes/tasks.route.ts` |
| MCP client hooks | `apps/mcp/src/tools.ts` |
| Endpoint reference (all of them, incl. workflow) | [Task_Workflow_API.md](./Task_Workflow_API.md) |

## Data model

| Field | Type | Notes |
| ----- | ---- | ----- |
| `id` | `Int` | Primary key **and** the task number. Appears in URLs; rendered as `TASK-000042` — see [Task_Numbering.md](./Task_Numbering.md) |
| `title` | `String` | 5–120 chars, trimmed, required |
| `description` | `String` | 10–5000 chars, trimmed, required. Plain text, never `dangerouslySetInnerHTML` |
| `acceptanceCriteria` | `String?` | ≤5000 chars. Required (supplied or already stored) before a task can be `todo` — see [Task_Status_Lifecycle.md](./Task_Status_Lifecycle.md) |
| `status` | `String` | One of ten values, default `backlog`. See [Task_Status_Lifecycle.md](./Task_Status_Lifecycle.md) |
| `statusNote` | `String?` | The "why" of the current status — reason, question, instructions, or summary. Replaced on every transition |
| `priority` | `String` | `low` \| `medium` \| `high` \| `urgent`. Default `medium`. See [Task_Priority.md](./Task_Priority.md) |
| `project` | `String?` | Lowercase slug grouping tasks by codebase/effort. Canonicalized on write so exact-match filtering is safe |
| `assignee` | `String?` | Free-form name/handle of who is working it |
| `createdBy` | `String` | The actor (`agent:…` / `human:…`) that created it — see [Actors.md](./Actors.md) |
| `links` | `TaskLink[]` | `{ label, url }` pairs (PRs, branches, docs), max 20, de-duplicated by URL on `needs_qa` and by the GitHub webhook — see [GitHub_Integration.md](./GitHub_Integration.md) |
| `labels` | `string[]` | Sorted lowercase slugs, max 10, stored in the `TaskLabel` join table (not a column). Replace-not-merge on write, same rule as `links`. See [Labels.md](./Labels.md) |
| `parentId` | `Int?` | Subtask parent. Cannot be itself or its own descendant. `childCount` on the summary is the number of subtasks (non-zero marks a task as an epic in a list) |
| `claimedBy` / `claimExpiresAt` | `String?` / `DateTime?` | The active lease, meaningful only while `in_progress`. See [Task_Workflow_API.md](./Task_Workflow_API.md#claims-leases) |
| `version` | `Int` | Optimistic concurrency, starts at 1, +1 on every write to the task row |
| `idempotencyKey` | `String?` | Unique. A repeated `POST /tasks` with the same key replays the original task |
| `createdAt` | `DateTime` | Set by DB default |
| `updatedAt` | `DateTime` | Prisma `@updatedAt`. Moves on task field changes and lease renewal — **not** when most comments are added (the claim holder's own comment does renew the lease) |
| `startedAt` | `DateTime?` | Set on the first entry into `in_progress`, never cleared |
| `completedAt` | `DateTime?` | Set on `→ done`, cleared on reopening |
| `comments` / `decisions` / `dependencies` / `dependents` | relations | Cascade delete. See [Comments.md](./Comments.md), [Task_Status_Lifecycle.md](./Task_Status_Lifecycle.md#decisions), [Task_Workflow_API.md](./Task_Workflow_API.md#dependencies) |

`status` and `priority` are `String` columns because **SQLite has no enum type**. The zod enums in `packages/contracts` are the real constraint; a service must never write a value that did not come from the corresponding `.parse()`.

`project` replaced the old fixed IT `category` enum — it is free text but canonicalized (lowercased, slug-shaped) because it is filtered by exact match, and SQLite's `equals` is case-sensitive with no `mode: "insensitive"`. See [../engineering/DATABASE.md](../engineering/DATABASE.md#canonical-values-instead-of-case-insensitive-matching).

A pointer to another task (`TaskRef` — used for `parent`, `children`, `dependencies`, `dependents`) carries its own `project`, because dependencies and subtasks can cross repositories: an agent in `mobile-app` waiting on a `helpdesk` task needs to see that from the pointer alone.

## Rules

- **Client-supplied fields on create:** `title`, `description`, `status?` (creatable statuses only), `priority?`, `project?`, `assignee?`, `acceptanceCriteria?`, `links?`, `labels?`, `parentId?`, `idempotencyKey?`. Everything else is server-owned.
- **Immutable after create:** `id`, `createdAt`, `createdBy`, `version`. Schemas are `.strict()`, so a payload containing a server-owned field is rejected with `VALIDATION_ERROR` rather than silently ignored.
- **`PATCH` never accepts `status`.** Status changes carry requirements and side effects (claims, decisions, unblocking) and go through `POST /tasks/:taskId/transition` exclusively — see [Task_Status_Lifecycle.md](./Task_Status_Lifecycle.md).
- **Update is a partial PATCH.** An empty body (`{}`), or a body carrying only `expectedVersion`, returns `AT_LEAST_ONE_FIELD` (422). A body whose fields all resolve to their current values performs **no write at all** — no version bump, no `updatedAt` move, no event.
- **Optional string fields normalize `""` to `null`** (`assignee`, `project`, `acceptanceCriteria`). Without this, clearing a field in a form stores an empty string, and that task then matches neither `assigneeIsNull=true` nor any name filter — it disappears from every assignee view.
- **A task cannot become its own ancestor.** Setting `parentId` to itself, or to a descendant, is `VALIDATION_ERROR` on `parentId`.
- **Delete is a hard delete.** Comments, decisions, and dependency rows cascade at the database level; the task's own events survive (their `taskId` is not a foreign key) alongside a new `task.deleted` event. Dependents that were blocked only on this task are re-checked and may auto-unblock. Irreversible, and the UI confirms first.
- **Claims gate writes.** While a live claim exists, an agent other than the holder cannot `PATCH`, transition, claim, add/remove a dependency, or delete the task (`TASK_ALREADY_CLAIMED`). A human always can. See [Task_Workflow_API.md](./Task_Workflow_API.md#claims-leases).

## API

Base path `/api/v1`. Full parameter reference for the list endpoint lives in [Task_Query_Filter_Sort_Page.md](./Task_Query_Filter_Sort_Page.md); every endpoint including transitions, claims, decisions, dependencies, and events lives in [Task_Workflow_API.md](./Task_Workflow_API.md). The plain-CRUD subset:

| Method | Path | Purpose | Success |
| ------ | ---- | ------- | ------- |
| `GET` | `/tasks` | List with filter / sort / page | `200` enveloped |
| `GET` | `/tasks/facets` | Distinct assignees, projects, creators, for filter selects | `200` |
| `GET` | `/tasks/:taskId` | One task with comments, parent, children, dependencies, dependents, open decision | `200` object |
| `POST` | `/tasks` | Create (or replay an idempotent one) | `201` + `Location`; **200** on replay |
| `PATCH` | `/tasks/:taskId` | Partial update, never `status` | `200` object |
| `DELETE` | `/tasks/:taskId` | Hard delete | `204` no body |

`/tasks/facets` and `/tasks/stats` are declared **before** `/tasks/:taskId` in the router, or they would be parsed as an id (and 404, since neither is numeric — a confusing way to discover a routing order bug).

`PUT` is deliberately not implemented — the UI only ever sends partial edits, and offering both invites two code paths that drift.

### Create

```http
POST /api/v1/tasks
Content-Type: application/json
X-Actor: agent:claude-code

{
  "title": "Idempotency keys for POST /refunds",
  "description": "A retried refund request currently creates two refunds. Add an idempotency key the same way /tasks already has one.",
  "priority": "high",
  "project": "billing-service",
  "idempotencyKey": "claude-code:billing-service:refund-idempotency"
}
```

Returns the full task and `Location: /api/v1/tasks/42`.

### Facets

```json
{ "assignees": ["agent:claude-code", "human:dana"], "projects": ["billing-service", "helpdesk", "mobile-app"], "labels": ["api", "bug", "web"], "creators": ["agent:claude-code", "human:krisz"] }
```

Distinct non-null values actually present in the table, sorted. It exists because the list page's assignee/project selects have no other source of options, and because sending an exact stored value is what makes case-sensitive equality matching safe.

### Error codes

See [../engineering/API_ERROR_CONTRACT.md](../engineering/API_ERROR_CONTRACT.md) for the full table. The ones a plain CRUD caller hits most:

| Code | Status | When |
| ---- | ------ | ---- |
| `VALIDATION_ERROR` | 422 | zod rejected the body or query; `details` carries per-field messages |
| `AT_LEAST_ONE_FIELD` | 422 | Empty (or `expectedVersion`-only) PATCH body |
| `TASK_NOT_FOUND` | 404 | No task with that id, **and** for a non-numeric id — do not leak the difference |
| `VERSION_CONFLICT` | 409 | `expectedVersion` did not match the stored `version` |
| `TASK_ALREADY_CLAIMED` | 409 | An agent other than the claim holder wrote the task |

`PATCH` and `DELETE` check existence explicitly before writing, rather than relying on Prisma's `P2025`. That check is what makes a 404 reliable — see [Error_Handling.md](./Error_Handling.md).

## Testing expectations

Every CRUD path has a service unit test plus a route integration test (supertest against a temp SQLite file). Required cases are enumerated in [../engineering/TESTING.md](../engineering/TESTING.md) — read that list rather than inventing one.

## Related pages

[../pages/Tasks_List.md](../pages/Tasks_List.md), [../pages/Task_Detail.md](../pages/Task_Detail.md), [../pages/Task_Create.md](../pages/Task_Create.md), [../pages/Task_Edit.md](../pages/Task_Edit.md) — full index: [../pages/README.md](../pages/README.md).
