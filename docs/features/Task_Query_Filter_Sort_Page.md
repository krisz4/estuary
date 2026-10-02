---
type: Feature
title: Task list query — filtering, sorting, paging
description: Every query parameter on GET /tasks, the response envelope, and how the UI binds it to the URL.
resource: apps/api/src/services/task-query.ts
tags: [tasks, list, filtering, sorting, pagination, api]
status: canonical
---
# Task list query — filtering, sorting, paging

The endpoint every screen and every agent's `task_list` call goes through. This is the highest-traffic part of the API, so it is specified tightly.

## Overview

| Concern | Location |
| ------- | -------- |
| Query schema | `taskListQuerySchema` in `packages/contracts/src/task-query.ts` |
| Prisma translation | `apps/api/src/services/task-query.ts` (`buildWhere`, `buildOrderBy`) |
| Route | `GET /api/v1/tasks` in `apps/api/src/routes/tasks.route.ts` |
| URL binding (web) | `apps/web/src/pages/tasks-list/useTaskListParams.ts` |
| Filter UI | `apps/web/src/features/tasks/TaskFilterBar.tsx` |

## Parameters

All are optional. The schema is `.strict()`, so an unknown parameter is rejected with `VALIDATION_ERROR` — a typo'd filter silently returning everything is worse than an error. (The web client strips unknown keys before it builds a request; see [URL binding](#url-binding-on-the-web).)

An **empty-string value is treated as absent**, not as a malformed value: `?page=&status=` behaves like `?`. Browsers and form serializers produce empty params routinely, and `z.coerce.number()` would otherwise turn `""` into `0` and fail the `min(1)` bound. A preprocessor drops empty strings before parsing.

### Paging

| Param | Type | Default | Rules |
| ----- | ---- | ------- | ----- |
| `page` | int | `1` | 1–1,000,000 (`MAX_PAGE`). A page beyond the end returns `data: []` with correct `meta`, **not** a 404 — but only inside that bound. The ceiling is chosen so `(MAX_PAGE - 1) * MAX_PAGE_SIZE` stays inside Int32, the width of Prisma's `skip` in the query engine: without it `?page=99999999999` overflows and 500s instead of returning the documented empty page |
| `pageSize` | int | `20` | 1–100. Values above 100 are rejected, not clamped — clamping hides a client bug |

Offset paging (`skip`/`take`), not cursor paging: the UI needs jump-to-page and a total count, and the dataset is small.

### Sorting

| Param | Type | Default | Rules |
| ----- | ---- | ------- | ----- |
| `sort` | `field:direction` | `createdAt:desc` | One clause. `direction` ∈ `asc`,`desc` |

Sortable fields: `id`, `createdAt`, `updatedAt`, `title`, `status`, `priority`, `completedAt`.

`id` is the reference order (`TASK-000042`'s number). Two fields do **not** sort alphabetically:

- **`priority`** sorts by severity (`urgent` > `high` > `medium` > `low`), not by string.
- **`status`** sorts by lifecycle order (`backlog` → `needs_refinement` → `todo` → `in_progress` → `blocked` → `needs_user_decision` → `needs_user_action` → `needs_qa` → `done` → `deferred` — see [Task_Status_Lifecycle.md](./Task_Status_Lifecycle.md)).

SQLite cannot express that ordering on a text column, so both are backed by integer rank columns (`priorityRank`, `statusRank`) maintained by the service on every write. Any code path that sets `status` or `priority` **must** go through `applyTaskRanks()` or sorting silently breaks. See [Task_Priority.md](./Task_Priority.md).

**`completedAt` is `null` for every open task — this is the archive sort.** SQLite has no `NULLS FIRST`/`LAST` (Prisma's `nulls:` option is not supported on this connector), so ordering rides SQLite's native rule instead: `NULL` sorts as the lowest possible value. `sort=completedAt:asc` therefore puts every open task first, then the earliest completion; `sort=completedAt:desc` — the archive's default, newest-completed first — puts every open task *last*, after every closed one, which is the reading "sort by when it completed" implies for work that has not completed at all. Pair it with `status=done&status=deferred` to view the archive alone.

**Stable ordering:** `{ id: "desc" }` is appended as a tiebreaker so paging never repeats or drops a row whose sort key is not unique. It is omitted when `id` is already the sort field, since a second clause on the same column is dead weight.

The tiebreaker's direction is `desc`, and the cost of that choice is **not** symmetric with the sort it tiebreaks. A SQLite index on `(col)` is physically `(col, rowid)`, so `ORDER BY col DESC, id DESC` is a straight backwards walk with no sort step — but `ORDER BY col ASC, id DESC` reports `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`, and so does the `createdAt ASC` pairing. Measured in stage 7 with `EXPLAIN QUERY PLAN`.

So `desc` is free on descending sorts and costs a temp B-tree on ascending ones — chosen because the default view (`createdAt:desc`) and the two most-used sorts are descending, not because the direction is cost-free.

### Filtering

| Param | Type | Matches |
| ----- | ---- | ------- |
| `status` | repeatable enum | OR within the param: `?status=todo&status=in_progress` |
| `priority` | repeatable enum | OR within the param |
| `project` | repeatable slug | OR within the param. Send values from `GET /tasks/facets` |
| `label` | repeatable slug | Tasks carrying **any** of the given labels (OR within the param). Send values from `GET /tasks/facets`. See [Labels.md](./Labels.md) |
| `assignee` | string | **Exact, case-sensitive.** Send a value from `GET /tasks/facets` |
| `assigneeIsNull` | boolean | `true` returns only unassigned tasks, `false` only assigned ones. Mutually exclusive with `assignee` (sending both → `VALIDATION_ERROR`) |
| `createdBy` | actor | Exact; lowercased before compare, matching how `X-Actor` is stored |
| `claimedBy` | actor | Exact; matches the stored `claimedBy` even once the lease has expired — pair with `status=in_progress` and check `claim` on the rows when only *live* claims matter |
| `attention` | boolean | `true` = everything waiting on a person — the three `HUMAN_ATTENTION_STATUSES`, un-triaged `backlog`/`todo` suggestions, `needs_refinement`, and `blocked` with no unfinished dependency (see [Attention_Queue.md](./Attention_Queue.md)); `false` = the rest. ANDs with every other filter. Also accepted by `GET /floor`, which shares these filter fields |
| `parentId` | task id | Subtasks of one parent. Digits only, like `:taskId` (`0x2a` → 422) |
| `parentIsNull` | boolean | `true` = top-level tasks only (no parent), `false` = subtasks only. Mutually exclusive with `parentId` (sending both → `VALIDATION_ERROR`) |
| `dependsOn` | task id | Tasks that depend on this one — its **dependents** ("who waits on 42?") |
| `dependencyOf` | task id | Tasks this one depends on — its **dependencies** ("what does 42 wait on?") |
| `q` | string, 1–120 | Free text, up to 8 AND'd terms — see below |
| `createdFrom` / `createdTo` | `YYYY-MM-DD` | Inclusive day bounds, UTC — see below |

Different params AND together; repeated values within one param OR together. `?status=todo&status=blocked&priority=urgent` = "(todo OR blocked) AND urgent".

`assigneeIsNull` filters in **both** directions. `false` is not "no filter" — it is "assigned to someone". A boolean that only means something when it is `true` is a trap for the next caller who sends the other value explicitly.

**`status` and `priority` push *both* predicates — the rank column and the text column — ANDed together.** `?status=todo` compiles to `statusRank IN (2) AND status IN ('todo')`, not to either one alone. The two terms do different jobs and **removing either is a regression**:

- **The rank term is what the index uses.** `status` and `priority` themselves carry no index, so without it `Task_statusRank_createdAt_idx` goes unused on the single most common view in the app. SQLite plans the rank term as the index search and applies the text term as a residual predicate — verified with `EXPLAIN QUERY PLAN`, see [../engineering/DATABASE.md](../engineering/DATABASE.md#indexes).
- **The text term is what makes the answer exact.** The two columns are in bijection only while `applyTaskRanks()` is the sole writer of the rank. `statusRank` defaults to `0` in the schema, so any insert that skips the helper — raw SQL, a `db push` experiment, the seed — lands a row whose rank says `backlog` while its status says something else. Filtering on the rank alone would return that row under `?status=backlog`, which is a wrong result set and a wrong `meta.total`, not merely a wrong sort order.

The text term does not merely *misfile* a drifted row, it makes it **unreachable through the status filter entirely**: the row fails the text term under its true status and the rank term under the drifted one, so no `?status=` value returns it. Filtering on every status therefore returns strictly fewer rows than no status filter at all, and the two `meta.total` values disagree. That is the intended trade — a drifted row is corrupt data, and hiding it beats reporting it under a status it does not have — and it stays hypothetical only for as long as `applyTaskRanks()` remains the only writer. `task-query.test.ts` pins both halves.

**Why `assigneeIsNull` and not `assignee=none`:** a sentinel value collides with a real person. Someone named "None" is unlikely; someone typing `none` into a free-text assignee field is not. A separate boolean has no collision surface.

**Case sensitivity is not an accident.** SQLite's `equals` is case-sensitive and Prisma's SQLite connector does not support `mode: "insensitive"` ([prisma#8268](https://github.com/prisma/prisma/issues/8268)). Rather than lowercase at query time and lose the index, every exact-match field compares canonical values: `project` is a canonical lowercase slug, `createdBy` / `claimedBy` are lowercased actors, and `assignee` options come from the facets endpoint so the client always sends the exact stored string. See [../engineering/DATABASE.md](../engineering/DATABASE.md#canonical-values-instead-of-case-insensitive-matching).

#### `q`

`q` is split into **terms** by `parseSearchTerms` (in `packages/contracts`, shared with the web app so it can highlight exactly what matched): whitespace separates terms, a double-quoted run is one term (`"page resets" board` is two terms, the first a phrase), an unterminated quote runs to the end, and terms are deduplicated case-insensitively and capped at 8 (`TASK_Q_MAX_TERMS`) — more terms than that is a paragraph, not a search, and the rest are ignored.

**Every term must match** (terms AND together); **a term matches if it appears in any of:** `title`, `description`, `acceptanceCriteria`, `statusNote`, `links` (the raw JSON — a URL or link label inside it counts), or **the body of any comment on the task**. `title`/`description`/etc. use `contains`, which compiles to SQLite `LIKE` and is therefore **case-insensitive for ASCII only** — accented characters compare case-sensitively. That is a documented SQLite limitation, not a bug to fix at query time.

A term that parses as a reference (`TASK-42`, `task-000042`, `#42`, or a bare integer — see [Task_Numbering.md](./Task_Numbering.md)) additionally matches `id` exactly, so pasting a task number into search finds that task even inside a longer query.

**Each term contributes one `OR` group nested inside the top-level `AND`, one group per term:**

```ts
where = {
  AND: [
    ...filterClauses,
    ...terms.map((term) => ({
      OR: [
        { title: { contains: term } }, { description: { contains: term } },
        { acceptanceCriteria: { contains: term } }, { statusNote: { contains: term } },
        { links: { contains: term } }, { comments: { some: { body: { contains: term } } } },
        ...(refId ? [{ id: refId }] : []),
      ],
    })),
  ],
}
```

Hoisting a term's `OR` branches to the top level is the classic implementation bug here: search would then widen the result set past the active filters instead of narrowing it, and would turn "every term must match" into "any term may match".

**`%` and `_` in a term are literal characters, not wildcards.** Prisma's `contains` compiles to `LIKE ?` with **no `ESCAPE` clause**, and with no escape clause SQLite has no escape character at all — so unescaped input is live pattern syntax (`?q=%` returns every task, `?q=50%` matches "500 errors"), and pre-escaping the string before handing it to `contains` does not help either, because `!%` is then two literal characters that match nothing. Prisma will not add an escape option ([prisma#19506](https://github.com/prisma/prisma/issues/19506)).

So a **term** carrying `%`, `_`, or `!` is resolved with a parameterized raw query carrying its own escape character, checking the same fields `contains` would (title, description, acceptance criteria, status note, links, and — via a `LEFT JOIN` — every comment body):

```sql
SELECT DISTINCT t.id AS id FROM "Task" t
LEFT JOIN "Comment" c ON c."taskId" = t.id
WHERE t.title LIKE ?1 ESCAPE '!' OR t.description LIKE ?1 ESCAPE '!'
   OR t.acceptanceCriteria LIKE ?1 ESCAPE '!' OR t.statusNote LIKE ?1 ESCAPE '!'
   OR t.links LIKE ?1 ESCAPE '!' OR c.body LIKE ?1 ESCAPE '!'
```

run **once per term that needs it**, before the page/count transaction, and feeds each term's resulting id set into that term's `OR` group above, alongside its reference branch.

**That raw path is the exception, not the rule.** A term containing none of `%`, `_`, or `!` is escaped by a no-op, so `contains` and the escaped raw `LIKE` are provably the same query — same columns, same case-insensitive-ASCII `LIKE`, same rows, same order. Such a term keeps the `contains` spelling and with it the ordering index, no id list, and no bind-parameter ceiling. `?q=printer` should not pay for a problem it does not have. (`!` is in that character class because it *is* the escape character: a term containing it is one whose escaped form differs from itself.)

Measured at 63 rows (the original helpdesk-era seed size; unchanged in shape at the current 62-row seed), both matching every row: fast path **1.39 ms** p50, raw path **1.85 ms**.

On the raw path the id set is **unbounded**, and that is a ceiling rather than a slope: the ids come back as one `WHERE id IN (?,?,…)` with a bind parameter each, against SQLite's `SQLITE_MAX_VARIABLE_NUMBER` of 32766 (999 on pre-3.32 builds). It also costs the ordering index — an `id IN (…)` page plans as `SEARCH … USING INTEGER PRIMARY KEY` plus `USE TEMP B-TREE FOR ORDER BY`. Both are fine at this scale and are another reason `q` at real volume wants FTS5. Truncating with a `LIMIT` would be worse than the scan: it silently drops matches and makes `meta.total` wrong.

#### Date bounds

`createdFrom` / `createdTo` are **date-only strings in UTC**, not timestamps. They are expanded to a half-open range:

- `createdFrom=2026-08-01` → `createdAt >= 2026-08-01T00:00:00.000Z`
- `createdTo=2026-08-11` → `createdAt < 2026-08-12T00:00:00.000Z`

The upper bound is exclusive-next-day precisely so the named day is **included**. A naive `lte` against `2026-08-11T00:00:00Z` excludes everything created that day, which reads as "the filter is off by one" and is the single most common date-filter bug.

Timezone is UTC throughout; the UI labels the control accordingly rather than pretending to be local-time aware.

## Response envelope

```json
{
  "data": [ /* task summaries: no comments, with commentCount */ ],
  "meta": {
    "page": 2,
    "pageSize": 20,
    "total": 62,
    "totalPages": 4,
    "hasNextPage": true,
    "hasPrevPage": true
  }
}
```

`total` comes from the same transaction as the page itself, so the count matches the rows it describes under concurrent writes. It is Prisma's **interactive** transaction rather than the `$transaction([findMany, count])` array form, because the `q` prefilter below has to run inside the same snapshot and the array form cannot feed one query's result into the next. `totalPages` is `Math.max(1, ceil(total / pageSize))` — never `0`, which keeps the pager from rendering "Page 1 of 0". `hasNextPage` is `page < totalPages`, so it is correctly `false` on an over-the-end page.

## URL binding on the web

The list state **is** the URL. `useTaskListParams()` reads `useSearchParams()`, **picks only the keys it knows**, validates them, and returns typed values plus setters. Consequences the implementation must preserve:

- A filtered view is shareable and survives reload.
- Browser back steps through filter changes.
- The TanStack Query key derives from the parsed params, so caching and refetching follow the URL for free.
- Changing any filter resets `page` to 1. Changing `page` never touches filters. (Forgetting the reset lands users on an empty page 5 of a 1-page result — the most common bug in this screen.)

**The client picks known keys before parsing; it does not reuse the server's `.strict()` schema on the raw params.** A shared link carrying `?utm_source=slack` would otherwise fail the whole parse and silently reset every filter. Unknown keys are ignored client-side and never forwarded; the server stays strict about what it receives. They are, however, **preserved in the URL** when the helper rewrites it, so a campaign tag survives the recipient clicking "next page".

Two combinations the server rejects are resolved client-side rather than sent and 422'd, and the two are resolved in **different places**, because only one of them is reachable by clicking:

- **`assignee` together with `assigneeIsNull`** — unrepresentable in the UI, since the two are one control. Resolved at parse time (the more specific `assignee` wins), which only ever fires for a hand-edited URL.
- **An inverted `createdFrom`/`createdTo` range** — *is* reachable: `min`/`max` on `<input type="date">` mark a value invalid but a typed one still commits, so setting "to" and then typing a later "from" produces it. The filter therefore **clamps**: moving one bound past the other moves that other bound with it, so the range stays valid and the user can see what happened. Dropping the far bound at parse time instead emptied a field and its chip with no explanation while the discarded value sat on in the address bar. The parse-time drop remains as the backstop for a hand-typed URL, where there is no interaction whose intent could be honoured.

Individual invalid values (`?page=abc`) fall back to that field's default rather than rendering an error page.

Debounce `q` by 300ms before it enters the URL, and write it with `replace` so typing does not fill the history stack.

## Performance

Indexes backing these queries are listed in [../engineering/DATABASE.md](../engineering/DATABASE.md#indexes).

## Error codes

| Code | Status | When |
| ---- | ------ | ---- |
| `VALIDATION_ERROR` | 422 | Bad page/pageSize, unknown sort field, unknown param, malformed date, `assignee` together with `assigneeIsNull`, `parentId` together with `parentIsNull`, or `createdFrom` after `createdTo` |

The last one is worth stating explicitly: the **server rejects** an inverted date range (`createdTo must be on or after createdFrom`, reported on `createdTo`). The client never sends one — it clamps instead, as described above — so this 422 is reachable only by a hand-edited URL or a non-browser caller.

## Related pages

- [../pages/Tasks_List.md](../pages/Tasks_List.md) — the only consumer of plain filtering
- [Attention_Queue.md](./Attention_Queue.md) — `attention=true`, the inbox's query
