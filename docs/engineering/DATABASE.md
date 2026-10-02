# Database

SQLite accessed through Prisma. Schema: `apps/api/prisma/schema.prisma`.

## Why SQLite

SQLite means a reviewer clones, runs one command, and has a working system — no Postgres container, no connection string to configure, no seed that fails because a service was not ready. The schema is portable: switching the Prisma `provider` to `postgresql` would need a migration reset, nothing structural.

## Schema

Six models: `Task`, `Comment`, `Decision`, `TaskDependency`, `TaskEvent`, and `TaskLabel`. The full, current definitions — with the column-by-column reasoning inline — live in `apps/api/prisma/schema.prisma`; that file's own header comment covers the things that surprise people (no native enums, `autoincrement()` only on `@id`, the derived rank columns, JSON-in-`String` columns, `TaskEvent.taskId` deliberately not being a foreign key, `TaskEvent.project` denormalised for the same reason, and `TaskLabel` being a join table rather than a JSON array). The shape, trimmed to what this page's reasoning depends on:

```prisma
model Task {
  id                 Int       @id @default(autoincrement())   // also the task number

  title              String
  description        String
  acceptanceCriteria String?

  status             String    @default("backlog")   // TaskStatus (contracts)
  statusRank         Int       @default(0)            // derived, for ordering
  statusNote         String?
  concerns           String?                          // needs_qa only: what a reviewer must not miss; null = routine
  priority           String    @default("medium")     // TaskPriority (contracts)
  priorityRank       Int       @default(1)            // derived, for ordering

  project            String?                          // lowercase slug
  assignee           String?
  createdBy          String                           // actor, e.g. "agent:claude-code"
  needsTriage        Boolean   @default(false)        // agent-filed, unseen by a person — see Attention_Queue.md
  links              String    @default("[]")         // JSON TaskLink[]

  claimedBy          String?
  claimExpiresAt     DateTime?

  version            Int       @default(1)
  idempotencyKey     String?   @unique

  parentId           Int?
  parent             Task?     @relation("Subtasks", fields: [parentId], references: [id], onDelete: SetNull)
  children           Task[]    @relation("Subtasks")

  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt
  startedAt          DateTime?
  completedAt        DateTime?

  comments           Comment[]
  decisions          Decision[]
  dependencies       TaskDependency[] @relation("DependentSide")
  dependents         TaskDependency[] @relation("DependencySide")

  @@index([createdAt])
  @@index([statusRank])
  @@index([priorityRank])
  @@index([statusRank, createdAt])
  @@index([status, priorityRank, createdAt])
  @@index([project])
  @@index([assignee])
  @@index([createdBy])
  @@index([parentId])
  @@index([needsTriage, status])
}

model Comment {
  id        Int      @id @default(autoincrement())
  taskId    Int
  author    String   // actor
  kind      String   @default("note")   // CommentKind (contracts)
  body      String
  createdAt DateTime @default(now())

  task Task @relation(fields: [taskId], references: [id], onDelete: Cascade)

  @@index([taskId, id])
}

model TaskEvent {
  id        Int      @id @default(autoincrement())
  taskId    Int                                    // not a relation — outlives its task
  type      String                                 // TaskEventType (contracts)
  actor     String
  project   String?                                // the task's project *when recorded* — see below
  payload   String    @default("{}")                // JSON
  createdAt DateTime  @default(now())

  @@index([taskId, id])
  @@index([project, id])
}

model TaskLabel {
  taskId Int
  label  String

  task Task @relation(fields: [taskId], references: [id], onDelete: Cascade)

  @@id([taskId, label])
  @@index([label])
}
```

`Decision` (one open decision per task, `requestedBy`/`answeredBy` actors) and `TaskDependency` (a composite-key edge table, `taskId` depends on `dependsOnId`) are in the schema file. See [../features/Task_Status_Lifecycle.md](../features/Task_Status_Lifecycle.md#decisions), [../features/Task_Workflow_API.md](../features/Task_Workflow_API.md#dependencies), and [../features/Task_Workflow_API.md](../features/Task_Workflow_API.md#events).

`TaskEvent.project` is denormalised for the same reason `taskId` is not a foreign key: the events feed must still be filterable by project after the task that produced an event is deleted or moved to another project. It is written once, at event-insert time, from the task's *current* project — never updated retroactively if the task later moves.

`TaskLabel` is a composite-key join table (`taskId`, `label`), not a JSON array on `Task`: SQLite has no array type, and `?label=` has to be an indexed exact match, not a `LIKE` scan over an encoded string. Labels are lowercase slugs (`labelSchema` in `packages/contracts`), replace-not-merge on write (`labelsInputSchema`), capped at `TASK_LABELS_MAX` (10) per task.

`needsTriage` and `concerns` back the attention queue — who the inbox shows a task to and why, including work an agent filed or finished without a human asking for it. `(needsTriage, status)` is indexed because `attentionWhere` filters on both. See [../features/Attention_Queue.md](../features/Attention_Queue.md).

## Integer primary keys (not cuid)

Every model uses `Int @id @default(autoincrement())`, and **`Task.id` is the task number** — there is no separate `taskNumber` column. Reasoning and the rejected alternatives are in [../features/Task_Numbering.md](../features/Task_Numbering.md).

The forcing constraint: Prisma's SQLite connector rejects `@default(autoincrement())` on any field that is not the `@id`, with `The autoincrement() default value is used on a non-id field even though the datasource does not support this.` ([prisma#1938](https://github.com/prisma/prisma/issues/1938), [prisma#6477](https://github.com/prisma/prisma/issues/6477)). A cuid `id` plus an autoincrementing `taskNumber` — the obvious design — does not compile on SQLite.

`Comment.id` being an integer is also what makes comment ordering deterministic: it is monotonic, so `ORDER BY createdAt, id` breaks same-millisecond ties in true insertion order. A cuid tiebreaker would not (cuid2 is deliberately unsortable).

## SQLite caveats (each has bitten someone)

| Caveat | Consequence |
| ------ | ----------- |
| **`autoincrement()` only on the `@id` field** | See above. Non-id autoincrement is a *schema validation* error, not a runtime one — it fails at `prisma generate` |
| **No native enums** | `status`, `priority`, `kind` (comment), and `type` (event) are `String`. The zod enums in `packages/contracts` are the only enforcement — never write a literal status string outside the service helpers |
| **No `mode: "insensitive"`** | Unsupported by the SQLite connector ([prisma#8268](https://github.com/prisma/prisma/issues/8268)); it is not even in the generated types. Do not reach for it |
| **`=` is case-sensitive, `LIKE` is not** | `equals` on text is case-**sensitive**; `contains` / `startsWith` compile to `LIKE` and are case-**insensitive for ASCII only**. Any filter needing case-insensitive equality must compare canonical values (see below) |
| **Single writer** | Writes serialize — and concurrent *interactive* transactions deadlock rather than queue. See [Concurrent writes](#concurrent-writes) for the in-process write queue and WAL that handle it |
| **No full-text search** | `q` uses `LIKE` scans. Acceptable at seed scale; a real deployment would want FTS5 |
| **Dates stored as integers** | Prisma handles the conversion; never write raw SQL against the timestamp columns |

### Canonical values instead of case-insensitive matching

Because `equals` is case-sensitive and `mode: "insensitive"` does not exist here, every field that is filtered by exact match stores a canonical value:

| Field | Canonicalization |
| ----- | ---------------- |
| `project` | A slug, lowercased and trimmed by `projectSchema` on write *and* on the filter input |
| `createdBy` / `claimedBy` / every actor column | Lowercased by `actorSchema` when the `X-Actor` header is parsed; the `createdBy` / `claimedBy` filters lowercase their input the same way |
| `assignee` | Stored as typed. The filter sends an **exact stored value**, sourced from `GET /api/v1/tasks/facets`, so casing always matches |
| `TaskLabel.label` | A slug, lowercased and trimmed by `labelSchema` on write *and* on the filter input — same rule as `project` |

(This replaced an earlier IT-helpdesk-era design where `category` was a fixed enum and `requesterEmail` was the lowercase exact-match field; both are gone from the schema. `project` and the actor columns took over the same role.)

Do not "fix" this by adding `mode: "insensitive"` or by lowercasing at query time — the former does not compile, the latter defeats the index.

## Concurrent writes

**Every interactive write transaction goes through `writeTransaction()` in `apps/api/src/lib/prisma.ts`, which queues them in process, one at a time.** Nothing in `services/` calls `prisma.$transaction(async …)` for a write directly.

Why: Prisma opens interactive transactions on SQLite as deferred (`BEGIN`). Each takes a shared lock on its first read and tries to upgrade on its first write. Two that have both read cannot both upgrade — SQLite refuses one, the other waits on it, and the pair ends as a `Socket timeout` 500 after the busy timeout. Measured, not assumed: 15 concurrent `POST /tasks` produced 9 such failures, and concurrent `GET /tasks` failed alongside them. Agents polling and writing in parallel make this the normal load, not an edge case.

The queue costs nothing SQLite was not already charging — it serializes writers regardless — and turns the deadlock into a short wait. A rejected transaction does not wedge the queue. It is correct because the API is **one process per database file**, which is how it is built and deployed; a second process writing the same file would need `BEGIN IMMEDIATE`, which Prisma does not expose.

Around it:

- **`POST /tasks/next`** runs its conditional `UPDATE` (the claim) and the claim's events in one `writeTransaction`, so it cannot interleave with a queued transaction's read-then-write and a committed claim never lacks its events. The candidate read happens outside the lock; the conditional `UPDATE` re-checks the version *and* the lease, and `next` re-reads its candidates if every one was lost to a concurrent write, rather than answering "nothing to do" over a queue that still has work in it.
- **Reads take no lock.** `listTasks` uses the batch `$transaction([findMany, count])` form, which runs as one statement sequence on one snapshot; its `LIKE` prefilter runs before it.
- **WAL.** `enableWal()` (`PRAGMA journal_mode = WAL`) runs in `server.ts` before `listen`, so readers proceed while a write is in flight instead of queuing behind it. The mode is persisted in the file, so re-running it on every boot is a no-op. The `-wal` / `-shm` siblings are gitignored and live on the same volume as the database.

`apps/api/src/lib/prisma.test.ts` pins the queue (ordering, survival after a rejection); `apps/api/src/routes/concurrency.route.test.ts` fires bursts of creates, list reads, `next` calls, comments, and patches at once and asserts every one succeeds.

## Indexes

| Index | Serves |
| ----- | ------ |
| `createdAt` | Default sort (`createdAt:desc`) |
| `statusRank` | Status filter + status sort |
| `priorityRank` | Priority filter + priority sort |
| `(statusRank, createdAt)` | The common view: tasks in a given status, newest first |
| `(status, priorityRank, createdAt)` | `POST /tasks/next`'s candidate query — live `todo` work at the top priority, oldest first |
| `project`, `assignee`, `createdBy` | Their filters, and the `facets` `GROUP BY` (covering — see below) |
| `parentId` | Subtask lookups (`parentId` filter, ancestor-cycle check) |
| `id` (implicit PK) | Reference lookup, and the stable sort tiebreaker |
| `(taskId, id)` on Comment | Loading a thread in insertion order |
| `(taskId, id)` on TaskEvent | The `after=<id>` cursor feed |
| `(project, id)` on TaskEvent | Filtering the events feed by project (`?project=`) while keeping the `id` cursor order |
| `(taskId, status)` on Decision | Finding the open decision for a task |
| `label` on TaskLabel | The `?label=` exact-match filter; `taskId` is covered by the `@@id([taskId, label])` primary key already |

`title` / `description` are unindexed — SQLite cannot use a B-tree for a leading-wildcard `LIKE` anyway.

**`status` and `priority` are unindexed, deliberately.** The list query filters on `statusRank` / `priorityRank` **and** on the text column: the rank term is what an index can serve, the text term is what keeps the answer correct if a rank ever drifts from the string it describes. SQLite uses the index for the rank term and applies the text term as a residual predicate, so the correctness term is free. See [../features/Task_Query_Filter_Sort_Page.md](../features/Task_Query_Filter_Sort_Page.md#filtering).

Three plans measured in stage 7 against the real SQL Prisma emits (63 rows, no `ANALYZE`), because the shape of the emitted query is not what reading the Prisma call suggests:

| Query | Plan |
| ----- | ---- |
| `status` filter + `createdAt:desc` | `SEARCH Task USING INDEX Task_statusRank_createdAt_idx (statusRank=?)` — a **search, not covering**: `include: { _count }` projects every column, so each matched index entry still costs a table row lookup. The `count` half of the pair *is* covering |
| `priority:desc` | `SCAN Task USING INDEX Task_priorityRank_idx`, and **no temp B-tree** — the index is physically `(priorityRank, rowid)`, so a backwards walk already satisfies `priorityRank DESC, id DESC` |
| `q` search, plain term | Not re-measured since `q` grew to more fields. As of stage 7 (title/description only): one statement, `SCAN Task USING INDEX Task_createdAt_idx`, evaluating both `LIKE`s per row. `q` now also filters `acceptanceCriteria`, `statusNote`, `links` (all `contains`, so plausibly the same shape) and comment bodies via a `comments: { some: { body: { contains } } }` relation filter, which Prisma compiles as a subquery/semi-join rather than a `LEFT JOIN` — not verified with `EXPLAIN QUERY PLAN` post-change. The scan itself is expected regardless — a leading-wildcard `LIKE` has no index to use — but the ordering still comes from the index |
| `q` search, term with `%` / `_` / `!` | Two statements. The raw `LIKE … ESCAPE` prefilter (`resolveTextSearch`) is a `SCAN Task` **`LEFT JOIN Comment`**, checking `title`, `description`, `acceptanceCriteria`, `statusNote`, `links`, and every comment's `body` in one pass — the join is explicit here because a parameterized raw query cannot reuse Prisma's relation-filter compilation the plain-term path gets for free. The page it feeds is `SEARCH Task USING INTEGER PRIMARY KEY (rowid=?)` **plus `USE TEMP B-TREE FOR ORDER BY`** — an `id IN (…)` list gives up the `createdAt` index for ordering. Which is why only a term that needs escaping takes this path |

The list query's `commentCount` is the one cost that is not visible in the Prisma call: `_count` compiles to a `LEFT JOIN` on a **materialized** `SELECT taskId, COUNT(*) … GROUP BY taskId` over the whole `Comment` table, plus a runtime `AUTOMATIC COVERING INDEX` on it. It is `O(all comments)` per list page rather than `O(pageSize)`. Irrelevant at seed scale; the lever, if it ever matters, is a second `groupBy` scoped to the 20 ids on the page rather than a schema change.

**Facets use `groupBy`, not `findMany` + `distinct`.** Prisma applies `distinct` **in the client**: it emits `SELECT id, assignee FROM Task WHERE assignee IS NOT NULL ORDER BY assignee` and dedupes in memory, so the endpoint would read one row per assigned task and could never be index-only (the `id` in the projection rules it out). `groupBy` emits a real `GROUP BY`, which plans as `SEARCH Task USING COVERING INDEX Task_assignee_idx`. Verified with `EXPLAIN QUERY PLAN` in stage 6.

## Derived columns

`statusRank` and `priorityRank` exist only so SQLite can sort by lifecycle and severity instead of alphabetically. They are **derived state in the database**, which is a smell worth naming: the mitigation is that exactly one helper writes them.

```ts
// apps/api/src/services/task-status.ts
export function applyTaskRanks<T extends { status?: string; priority?: string }>(data: T) { … }
```

Every create and update path calls it, including the seed. A `prisma.task.update({ data: { status } })` written anywhere else silently corrupts sort order — the row still shows the right badge, so nobody notices until someone sorts. If you add a write path, add a test that sorts after it.

## Migrations

```bash
pnpm --filter @estuary/api db:migrate --name descriptive_snake_case   # create + apply
pnpm --filter @estuary/api db:deploy                                  # apply only (Docker, CI)
pnpm --filter @estuary/api db:studio                                  # browse
pnpm --filter @estuary/api db:seed                                    # wipe and re-seed 62 tasks
pnpm --filter @estuary/api db:reset                                   # drop, migrate, seed (destructive)
```

Rules:

1. Every `schema.prisma` edit ships with its migration folder in the same change set. Schema-only diffs break `docker compose up` on a clean volume.
2. Containers and CI run `db:deploy`, never `db push`.
3. `db push` is for throwaway local experiments only.
4. Migration SQL is reviewed, not just generated — SQLite rebuilds the whole table for many `ALTER`s, and Prisma's generated SQL shows it.
5. `db:reset` **prompts before it drops anything, and that prompt is deliberate.** Its only caller is a human at a terminal: containers and CI run `db:deploy` plus the guarded seed (rule 2, and [../operations/DOCKER.md](../operations/DOCKER.md)), so nothing automated ever needs `--force`. The prompt is also the *only* confirmation on this path — `migrate reset` drops and recreates the database before the seed runs, so `ALLOW_SEED` does not cover it. After migrating it runs `src/seed/index.ts` through the `prisma.seed` hook in `apps/api/package.json`. Prisma's CLI additionally refuses this command when it detects it was invoked by an AI agent, and asks for explicit human consent; that guard is Prisma's, not ours.

## The database file

`apps/api/prisma/data/estuary.db`, set by `DATABASE_URL="file:./data/estuary.db"`. Gitignored, including `-wal` and `-shm` siblings. In Docker it lives on a named volume so it survives `docker compose down` — see [../operations/DOCKER.md](../operations/DOCKER.md).

Tests never touch it: each worker gets its own temp file, and E2E gets a third, separate database. See [TESTING.md](./TESTING.md).

## Related

- [../features/Tasks.md](../features/Tasks.md) — field semantics
- [../features/Task_Numbering.md](../features/Task_Numbering.md) — why the id is the number
- [../features/Seed_Data.md](../features/Seed_Data.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
