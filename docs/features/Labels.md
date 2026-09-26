---
type: Feature
title: Labels
description: Free-form tags that narrow work inside a project — the workspace of a monorepo, or a kind of work.
resource: packages/contracts/src/task.ts
tags: [tasks, labels, filtering, mcp]
status: canonical
---
# Labels

## Overview

| Concern | Location |
| ------- | -------- |
| Schema (`labelSchema`, `labelsInputSchema`, bounds) | `packages/contracts/src/task.ts` |
| Storage | `TaskLabel` join table — `apps/api/prisma/schema.prisma`, [../engineering/DATABASE.md](../engineering/DATABASE.md) |
| Write path | `apps/api/src/services/task.service.ts` (`createTask`, `updateTask`) |
| Filter | `?label=` on `GET /tasks` — `apps/api/src/services/task-query.ts` (`buildWhere`) |
| Facets | `GET /tasks/facets` → `labels` |
| MCP | `task_next`'s `label` param; labels shown in `task_list` / `task_get` output |

`project` answers "which repository", a label answers "which part of it" — typically the workspace of a monorepo (`web`, `api`, `contracts`) or a kind of work (`bug`, `flaky-test`, `perf`). Independent of `project`: a task can carry labels with no project at all.

## Rules

- **A lowercase slug**, canonicalized the same way `project` is: `?label=` is an exact-match filter and SQLite's `equals` is case-sensitive with no `mode: "insensitive"`, so `Web` and `web` must not be two labels. `/` is allowed so a label can name a path-like area (`apps/web`). Pattern: `^[a-z0-9][a-z0-9._/-]*$`, max 32 characters (`TASK_LABEL_MAX`).
- **The whole set, not additive.** `labels` on create/PATCH **replaces** the task's label set — the same rule as `links`. To add one label, send the full list back with it appended (read the task first). Duplicates collapse and the set comes back sorted (`labelsInputSchema`'s transform), so storage order never depends on how the caller typed it.
- **Max 10 labels per task** (`TASK_LABELS_MAX`).
- **`PATCH` with `labels` compares sorted arrays**, not a diff: if the incoming set is identical to the stored one, `updateTask` treats it as no change — no version bump, no event, no write — the same "nothing changed must mean nothing changed" rule as every other PATCH field.
- **Storage is a join table (`TaskLabel`), not a JSON array on `Task`.** SQLite has no array type, and `?label=` has to be an indexed exact match rather than a `LIKE` scan over an encoded string.

## API

| Endpoint | Labels behavior |
| -------- | ---------------- |
| `POST /tasks`, `PATCH /tasks/:taskId` | `labels?: string[]` — replaces the set. Omit the field to leave labels unchanged on a PATCH; send `[]` to clear them |
| `GET /tasks?label=x&label=y` | Tasks carrying **any** of the given labels (OR within the param, like `status`/`priority`/`project`) — ANDed with every other filter |
| `GET /tasks/facets` | `labels: string[]` — distinct values actually present, sorted. The only source of options for a label filter select |
| `POST /tasks/next` (`NextTaskInput.label`) | Only consider tasks carrying at least one of the given labels — how an agent working in one workspace of a monorepo asks for that workspace's work. Omit for any label, including unlabelled tasks |

`taskSummarySchema.labels` (and therefore every task response) is a **sorted array of strings** — see [Tasks.md](./Tasks.md) for the full task shape.

### Example

```http
PATCH /api/v1/tasks/42
Content-Type: application/json

{ "labels": ["web", "bug"] }
```

```http
GET /api/v1/tasks?label=web&label=api
```
→ tasks carrying `web` **or** `api`.

## Related

- [Tasks.md](./Tasks.md) — the task resource `labels` lives on
- [Task_Query_Filter_Sort_Page.md](./Task_Query_Filter_Sort_Page.md) — `?label=` alongside every other filter
- [Agent_Integration.md](./Agent_Integration.md) — `task_next`'s `label` param, for a monorepo workspace
