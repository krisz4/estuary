# Database

SQLite accessed through Prisma. Schema: `apps/api/prisma/schema.prisma`.

## Why SQLite

SQLite means a reviewer clones, runs one command, and has a working system — no Postgres container, no connection string to configure, no seed that fails because a service was not ready. The schema is portable: switching the Prisma `provider` to `postgresql` would need a migration reset, nothing structural.

## Schema

```prisma
model Ticket {
  id             Int       @id @default(autoincrement())   // also the ticket number

  title          String
  description    String

  status         String    @default("open")      // TicketStatus (contracts)
  statusRank     Int       @default(0)           // derived, for ordering
  priority       String    @default("medium")    // TicketPriority (contracts)
  priorityRank   Int       @default(1)           // derived, for ordering
  category       String?                         // TicketCategory (contracts)

  requesterName  String
  requesterEmail String                          // stored lowercase
  assignee       String?

  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  resolvedAt     DateTime?
  closedAt       DateTime?

  comments       Comment[]

  @@index([createdAt])
  @@index([statusRank])
  @@index([priorityRank])
  @@index([statusRank, createdAt])
  @@index([requesterEmail])
  @@index([category])
  @@index([assignee])
}

model Comment {
  id         Int      @id @default(autoincrement())
  ticketId   Int
  authorName String
  body       String
  createdAt  DateTime @default(now())

  ticket     Ticket   @relation(fields: [ticketId], references: [id], onDelete: Cascade)

  @@index([ticketId, id])
}
```

## Integer primary keys (not cuid)

Both models use `Int @id @default(autoincrement())`, and **`Ticket.id` is the ticket number** — there is no separate `ticketNumber` column. Reasoning and the rejected alternatives are in [../features/Ticket_Numbering.md](../features/Ticket_Numbering.md).

The forcing constraint: Prisma's SQLite connector rejects `@default(autoincrement())` on any field that is not the `@id`, with `The autoincrement() default value is used on a non-id field even though the datasource does not support this.` ([prisma#1938](https://github.com/prisma/prisma/issues/1938), [prisma#6477](https://github.com/prisma/prisma/issues/6477)). A cuid `id` plus an autoincrementing `ticketNumber` — the obvious design — does not compile on SQLite.

`Comment.id` being an integer is also what makes comment ordering deterministic: it is monotonic, so `ORDER BY createdAt, id` breaks same-millisecond ties in true insertion order. A cuid tiebreaker would not (cuid2 is deliberately unsortable).

## SQLite caveats (each has bitten someone)

| Caveat | Consequence |
| ------ | ----------- |
| **`autoincrement()` only on the `@id` field** | See above. Non-id autoincrement is a *schema validation* error, not a runtime one — it fails at `prisma generate` |
| **No native enums** | `status`, `priority`, `category` are `String`. The zod enums in `packages/contracts` are the only enforcement — never write a literal status string outside the service helpers |
| **No `mode: "insensitive"`** | Unsupported by the SQLite connector ([prisma#8268](https://github.com/prisma/prisma/issues/8268)); it is not even in the generated types. Do not reach for it |
| **`=` is case-sensitive, `LIKE` is not** | `equals` on text is case-**sensitive**; `contains` / `startsWith` compile to `LIKE` and are case-**insensitive for ASCII only**. Any filter needing case-insensitive equality must compare canonical values (see below) |
| **Single writer** | Writes serialize. Fine here; it is the first thing to hit under real concurrency |
| **No full-text search** | `q` uses `LIKE` scans. Acceptable at seed scale; a real deployment would want FTS5 |
| **Dates stored as integers** | Prisma handles the conversion; never write raw SQL against the timestamp columns |

### Canonical values instead of case-insensitive matching

Because `equals` is case-sensitive and `mode: "insensitive"` does not exist here, every field that is filtered by exact match stores a canonical value:

| Field | Canonicalization |
| ----- | ---------------- |
| `requesterEmail` | Lowercased and trimmed on write |
| `category` | Constrained to the `TicketCategory` enum (already lowercase) |
| `assignee` | Stored as typed. The filter sends an **exact stored value**, sourced from `GET /api/v1/tickets/facets`, so casing always matches |

Do not "fix" this by adding `mode: "insensitive"` or by lowercasing at query time — the former does not compile, the latter defeats the index.

## Indexes

| Index | Serves |
| ----- | ------ |
| `createdAt` | Default sort (`createdAt:desc`) |
| `statusRank` | Status filter + status sort |
| `priorityRank` | Priority filter + priority sort |
| `(statusRank, createdAt)` | The common view: open tickets, newest first |
| `requesterEmail` | Requester filter |
| `category`, `assignee` | Their filters, and the `facets` `GROUP BY` (covering — see below) |
| `id` (implicit PK) | Reference lookup, and the stable sort tiebreaker |
| `(ticketId, id)` on Comment | Loading a thread in insertion order |

`title` / `description` are unindexed — SQLite cannot use a B-tree for a leading-wildcard `LIKE` anyway.

**`status` and `priority` are unindexed, deliberately.** The list query filters on `statusRank` / `priorityRank` **and** on the text column: the rank term is what an index can serve, the text term is what keeps the answer correct if a rank ever drifts from the string it describes. SQLite uses the index for the rank term and applies the text term as a residual predicate, so the correctness term is free. See [../features/Ticket_Query_Filter_Sort_Page.md](../features/Ticket_Query_Filter_Sort_Page.md#filtering).

Three plans measured in stage 7 against the real SQL Prisma emits (63 rows, no `ANALYZE`), because the shape of the emitted query is not what reading the Prisma call suggests:

| Query | Plan |
| ----- | ---- |
| `status` filter + `createdAt:desc` | `SEARCH Ticket USING INDEX Ticket_statusRank_createdAt_idx (statusRank=?)` — a **search, not covering**: `include: { _count }` projects every column, so each matched index entry still costs a table row lookup. The `count` half of the pair *is* covering |
| `priority:desc` | `SCAN Ticket USING INDEX Ticket_priorityRank_idx`, and **no temp B-tree** — the index is physically `(priorityRank, rowid)`, so a backwards walk already satisfies `priorityRank DESC, id DESC` |
| `q` search, plain term | One statement: `SCAN Ticket USING INDEX Ticket_createdAt_idx`, evaluating both `LIKE`s per row. The scan is expected — a leading-wildcard `LIKE` has no index to use — but the ordering still comes from the index |
| `q` search, term with `%` / `_` / `!` | Two statements. The raw `LIKE … ESCAPE` prefilter is `SCAN Ticket`. The page it feeds is `SEARCH Ticket USING INTEGER PRIMARY KEY (rowid=?)` **plus `USE TEMP B-TREE FOR ORDER BY`** — an `id IN (…)` list gives up the `createdAt` index for ordering. Which is why only a term that needs escaping takes this path |

The list query's `commentCount` is the one cost that is not visible in the Prisma call: `_count` compiles to a `LEFT JOIN` on a **materialized** `SELECT ticketId, COUNT(*) … GROUP BY ticketId` over the whole `Comment` table, plus a runtime `AUTOMATIC COVERING INDEX` on it. It is `O(all comments)` per list page rather than `O(pageSize)`. Irrelevant at seed scale; the lever, if it ever matters, is a second `groupBy` scoped to the 20 ids on the page rather than a schema change.

**Facets use `groupBy`, not `findMany` + `distinct`.** Prisma applies `distinct` **in the client**: it emits `SELECT id, assignee FROM Ticket WHERE assignee IS NOT NULL ORDER BY assignee` and dedupes in memory, so the endpoint would read one row per assigned ticket and could never be index-only (the `id` in the projection rules it out). `groupBy` emits a real `GROUP BY`, which plans as `SEARCH Ticket USING COVERING INDEX Ticket_assignee_idx`. Verified with `EXPLAIN QUERY PLAN` in stage 6.

## Derived columns

`statusRank` and `priorityRank` exist only so SQLite can sort by lifecycle and severity instead of alphabetically. They are **derived state in the database**, which is a smell worth naming: the mitigation is that exactly one helper writes them.

```ts
// apps/api/src/services/ticket-status.ts
export function applyTicketRanks<T extends { status?: string; priority?: string }>(data: T) { … }
```

Every create and update path calls it, including the seed. A `prisma.ticket.update({ data: { status } })` written anywhere else silently corrupts sort order — the row still shows the right badge, so nobody notices until someone sorts. If you add a write path, add a test that sorts after it.

## Migrations

```bash
pnpm --filter @helpdesk/api db:migrate --name descriptive_snake_case   # create + apply
pnpm --filter @helpdesk/api db:deploy                                  # apply only (Docker, CI)
pnpm --filter @helpdesk/api db:studio                                  # browse
pnpm --filter @helpdesk/api db:seed                                    # wipe and re-seed 63 tickets
pnpm --filter @helpdesk/api db:reset                                   # drop, migrate, seed (destructive)
```

Rules:

1. Every `schema.prisma` edit ships with its migration folder in the same change set. Schema-only diffs break `docker compose up` on a clean volume.
2. Containers and CI run `db:deploy`, never `db push`.
3. `db push` is for throwaway local experiments only.
4. Migration SQL is reviewed, not just generated — SQLite rebuilds the whole table for many `ALTER`s, and Prisma's generated SQL shows it.
5. `db:reset` **prompts before it drops anything, and that prompt is deliberate.** Its only caller is a human at a terminal: containers and CI run `db:deploy` plus the guarded seed (rule 2, and [../operations/DOCKER.md](../operations/DOCKER.md)), so nothing automated ever needs `--force`. The prompt is also the *only* confirmation on this path — `migrate reset` drops and recreates the database before the seed runs, so `ALLOW_SEED` does not cover it. After migrating it runs `src/seed/index.ts` through the `prisma.seed` hook in `apps/api/package.json`. Prisma's CLI additionally refuses this command when it detects it was invoked by an AI agent, and asks for explicit human consent; that guard is Prisma's, not ours.

## The database file

`apps/api/prisma/data/helpdesk.db`, set by `DATABASE_URL="file:./data/helpdesk.db"`. Gitignored, including `-wal` and `-shm` siblings. In Docker it lives on a named volume so it survives `docker compose down` — see [../operations/DOCKER.md](../operations/DOCKER.md).

Tests never touch it: each worker gets its own temp file, and E2E gets a third, separate database. See [TESTING.md](./TESTING.md).

## Related

- [../features/Tickets.md](../features/Tickets.md) — field semantics
- [../features/Ticket_Numbering.md](../features/Ticket_Numbering.md) — why the id is the number
- [../features/Seed_Data.md](../features/Seed_Data.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
