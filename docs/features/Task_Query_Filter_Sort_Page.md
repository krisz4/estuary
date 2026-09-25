---
type: Feature
title: Ticket list query — filtering, sorting, paging
description: Every query parameter on GET /tickets, the response envelope, and how the UI binds it to the URL.
resource: apps/api/src/services/ticket-query.ts
tags: [tickets, list, filtering, sorting, pagination, api]
status: canonical
---
# Ticket list query — filtering, sorting, paging

Task 3 of the brief. This is the most-graded part of the API, so it is specified tightly.

## Overview

| Concern | Location |
| ------- | -------- |
| Query schema | `ticketListQuerySchema` in `packages/contracts/src/ticket-query.ts` |
| Prisma translation | `apps/api/src/services/ticket-query.ts` (`buildWhere`, `buildOrderBy`) |
| Route | `GET /api/v1/tickets` in `apps/api/src/routes/tickets.route.ts` |
| URL binding (web) | `apps/web/src/pages/tickets-list/useTicketListParams.ts` |
| Filter UI | `apps/web/src/features/tickets/TicketFilterBar.tsx` |

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

Sortable fields: `id`, `createdAt`, `updatedAt`, `title`, `status`, `priority`.

`id` is the reference order (the UI labels that column "Reference"). Two fields do **not** sort alphabetically:

- **`priority`** sorts by severity (`urgent` > `high` > `medium` > `low`), not by string.
- **`status`** sorts by lifecycle order (`open` → `in_progress` → `resolved` → `closed`).

SQLite cannot express that ordering on a text column, so both are backed by integer rank columns (`priorityRank`, `statusRank`) maintained by the service on every write. Any code path that sets `status` or `priority` **must** go through `applyTicketRanks()` or sorting silently breaks. See [Ticket_Priority.md](./Ticket_Priority.md).

**Stable ordering:** `{ id: "desc" }` is appended as a tiebreaker so paging never repeats or drops a row whose sort key is not unique. It is omitted when `id` is already the sort field, since a second clause on the same column is dead weight.

The tiebreaker's direction is `desc`, and the cost of that choice is **not** symmetric with the sort it tiebreaks. A SQLite index on `(col)` is physically `(col, rowid)`, so `ORDER BY col DESC, id DESC` is a straight backwards walk with no sort step — but `ORDER BY col ASC, id DESC` reports `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`, and so does the `createdAt ASC` pairing. Measured in stage 7 with `EXPLAIN QUERY PLAN`.

So `desc` is free on descending sorts and costs a temp B-tree on ascending ones — chosen because the default view (`createdAt:desc`) and the two most-used sorts are descending, not because the direction is cost-free.

### Filtering

| Param | Type | Matches |
| ----- | ---- | ------- |
| `status` | repeatable enum | OR within the param: `?status=open&status=in_progress` |
| `priority` | repeatable enum | OR within the param |
| `category` | repeatable enum | OR within the param |
| `assignee` | string | **Exact, case-sensitive.** Send a value from `GET /tickets/facets` |
| `assigneeIsNull` | boolean | `true` returns only unassigned tickets, `false` only assigned ones. Mutually exclusive with `assignee` (sending both → `VALIDATION_ERROR`) |
| `requesterEmail` | email | Exact; lowercased before compare, matching how it is stored |
| `q` | string, 1–120 | Free text — see below |
| `createdFrom` / `createdTo` | `YYYY-MM-DD` | Inclusive day bounds, UTC — see below |

Different params AND together; repeated values within one param OR together. `?status=open&status=resolved&priority=urgent` = "(open OR resolved) AND urgent".

**On the board (`/tickets/board`) `status` selects which *columns* render**, and every column then sends its own single-status request. The parameter's meaning on the wire is unchanged — the difference is entirely in which requests the screen makes — but it is worth knowing before "fixing" the board to also filter rows: on a screen whose columns are the statuses, applying the filter twice leaves columns that are empty for a reason nothing on screen explains. See [../pages/Tickets_Board.md](../pages/Tickets_Board.md).

`assigneeIsNull` filters in **both** directions. `false` is not "no filter" — it is "assigned to someone". A boolean that only means something when it is `true` is a trap for the next caller who sends the other value explicitly.

**`status` and `priority` push *both* predicates — the rank column and the text column — ANDed together.** `?status=open` compiles to `statusRank IN (0) AND status IN ('open')`, not to either one alone. The two terms do different jobs and **removing either is a regression**:

- **The rank term is what the index uses.** `status` and `priority` themselves carry no index, so without it `Ticket_statusRank_createdAt_idx` goes unused on the single most common view in the app. SQLite plans the rank term as the index search and applies the text term as a residual predicate — verified with `EXPLAIN QUERY PLAN`, see [../engineering/DATABASE.md](../engineering/DATABASE.md#indexes).
- **The text term is what makes the answer exact.** The two columns are in bijection only while `applyTicketRanks()` is the sole writer of the rank. `statusRank` defaults to `0` in the schema, so any insert that skips the helper — raw SQL, a `db push` experiment, the seed — lands a row whose rank says `open` while its status says something else. Filtering on the rank alone would return that row under `?status=open`, which is a wrong result set and a wrong `meta.total`, not merely a wrong sort order.

The text term does not merely *misfile* a drifted row, it makes it **unreachable through the status filter entirely**: the row fails the text term under its true status and the rank term under the drifted one, so no `?status=` value returns it. `?status=open&status=in_progress&status=resolved&status=closed` therefore returns strictly fewer rows than no status filter at all, and the two `meta.total` values disagree. That is the intended trade — a drifted row is corrupt data, and hiding it beats reporting it under a status it does not have — and it stays hypothetical only for as long as `applyTicketRanks()` remains the only writer. `ticket-query.test.ts` pins both halves.

**Why `assigneeIsNull` and not `assignee=none`:** a sentinel value collides with a real person. Someone named "None" is unlikely; someone typing `none` into a free-text assignee field is not. A separate boolean has no collision surface.

**Case sensitivity is not an accident.** SQLite's `equals` is case-sensitive and Prisma's SQLite connector does not support `mode: "insensitive"` ([prisma#8268](https://github.com/prisma/prisma/issues/8268)). Rather than lowercase at query time and lose the index, every exact-match field compares canonical values: `category` is an enum, `requesterEmail` is stored lowercase, and `assignee` options come from the facets endpoint so the client always sends the exact stored string.

#### `q`

Searches `title`, `description`, and the ticket reference. `title`/`description` use `contains`, which compiles to SQLite `LIKE` and is therefore **case-insensitive for ASCII only** — accented characters compare case-sensitively. That is a documented SQLite limitation, not a bug to fix at query time.

A `q` that parses as a reference (`HD-42`, `hd-000042`, `#42`, or a bare integer — see [Ticket_Numbering.md](./Ticket_Numbering.md)) additionally matches `id` exactly, so pasting a ticket number into search finds that ticket.

**The `q` clause is one `OR` group nested inside the top-level `AND`:**

```ts
where = {
  AND: [
    ...filterClauses,
    { OR: [ { title: { contains: q } }, { description: { contains: q } },
            ...(refId ? [{ id: refId }] : []) ] },
  ],
}
```

Hoisting those `OR` branches to the top level is the classic implementation bug here: search would then widen the result set past the active filters instead of narrowing it.

**`%` and `_` in `q` are literal characters, not wildcards.** Prisma's `contains` compiles to `LIKE ?` with **no `ESCAPE` clause**, and with no escape clause SQLite has no escape character at all — so unescaped input is live pattern syntax (`?q=%` returns every ticket, `?q=50%` matches "500 errors"), and pre-escaping the string before handing it to `contains` does not help either, because `!%` is then two literal characters that match nothing. Prisma will not add an escape option ([prisma#19506](https://github.com/prisma/prisma/issues/19506)).

So a `q` carrying `%`, `_`, or `!` is resolved with a parameterized raw query carrying its own escape character:

```sql
SELECT id FROM "Ticket"
WHERE title LIKE ?1 ESCAPE '!' OR description LIKE ?1 ESCAPE '!'
```

and feeds the resulting id set into the nested `OR` group above, alongside the reference branch. It runs inside the same transaction as the page and the count.

**That raw path is the exception, not the rule.** A term containing none of `%`, `_`, or `!` is escaped by a no-op, so `contains` and the escaped raw `LIKE` are provably the same query — same columns, same case-insensitive-ASCII `LIKE`, same rows, same order. Such a term keeps the `contains` spelling and with it the ordering index, no id list, and no bind-parameter ceiling. `?q=printer` should not pay for a problem it does not have. (`!` is in that character class because it *is* the escape character: a term containing it is one whose escaped form differs from itself.)

Measured at 63 rows, both matching every row: fast path **1.39 ms** p50, raw path **1.85 ms**.

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
  "data": [ /* ticket summaries: no comments, with commentCount */ ],
  "meta": {
    "page": 2,
    "pageSize": 20,
    "total": 63,
    "totalPages": 4,
    "hasNextPage": true,
    "hasPrevPage": true
  }
}
```

`total` comes from the same transaction as the page itself, so the count matches the rows it describes under concurrent writes. It is Prisma's **interactive** transaction rather than the `$transaction([findMany, count])` array form, because the `q` prefilter below has to run inside the same snapshot and the array form cannot feed one query's result into the next. `totalPages` is `Math.max(1, ceil(total / pageSize))` — never `0`, which keeps the pager from rendering "Page 1 of 0". `hasNextPage` is `page < totalPages`, so it is correctly `false` on an over-the-end page.

## URL binding on the web

The list state **is** the URL. `useTicketListParams()` reads `useSearchParams()`, **picks only the keys it knows**, validates them, and returns typed values plus setters. Consequences the implementation must preserve:

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
| `VALIDATION_ERROR` | 422 | Bad page/pageSize, unknown sort field, unknown param, malformed date, `assignee` together with `assigneeIsNull`, or `createdFrom` after `createdTo` |

The last one is worth stating explicitly: the **server rejects** an inverted date range (`createdTo must be on or after createdFrom`, reported on `createdTo`). The client never sends one — it clamps instead, as described above — so this 422 is reachable only by a hand-edited URL or a non-browser caller.

## Related pages

- [../pages/Tickets_List.md](../pages/Tickets_List.md) — the only consumer
