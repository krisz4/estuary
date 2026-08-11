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
| `page` | int | `1` | ≥ 1. A page beyond the end returns `data: []` with correct `meta`, **not** a 404 |
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

### Filtering

| Param | Type | Matches |
| ----- | ---- | ------- |
| `status` | repeatable enum | OR within the param: `?status=open&status=in_progress` |
| `priority` | repeatable enum | OR within the param |
| `category` | repeatable enum | OR within the param |
| `assignee` | string | **Exact, case-sensitive.** Send a value from `GET /tickets/facets` |
| `assigneeIsNull` | boolean | `true` returns only unassigned tickets. Mutually exclusive with `assignee` (sending both → `VALIDATION_ERROR`) |
| `requesterEmail` | email | Exact; lowercased before compare, matching how it is stored |
| `q` | string, 1–120 | Free text — see below |
| `createdFrom` / `createdTo` | `YYYY-MM-DD` | Inclusive day bounds, UTC — see below |

Different params AND together; repeated values within one param OR together. `?status=open&status=resolved&priority=urgent` = "(open OR resolved) AND urgent".

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

`total` comes from a `prisma.$transaction([findMany, count])` so the count matches the page under concurrent writes. `totalPages` is `Math.max(1, ceil(total / pageSize))` — never `0`, which keeps the pager from rendering "Page 1 of 0". `hasNextPage` is `page < totalPages`, so it is correctly `false` on an over-the-end page.

## URL binding on the web

The list state **is** the URL. `useTicketListParams()` reads `useSearchParams()`, **picks only the keys it knows**, validates them, and returns typed values plus setters. Consequences the implementation must preserve:

- A filtered view is shareable and survives reload.
- Browser back steps through filter changes.
- The TanStack Query key derives from the parsed params, so caching and refetching follow the URL for free.
- Changing any filter resets `page` to 1. Changing `page` never touches filters. (Forgetting the reset lands users on an empty page 5 of a 1-page result — the most common bug in this screen.)

**The client picks known keys before parsing; it does not reuse the server's `.strict()` schema on the raw params.** A shared link carrying `?utm_source=slack` would otherwise fail the whole parse and silently reset every filter. Unknown keys are ignored client-side and never forwarded; the server stays strict about what it receives.

Individual invalid values (`?page=abc`) fall back to that field's default rather than rendering an error page.

Debounce `q` by 300ms before it enters the URL, and write it with `replace` so typing does not fill the history stack.

## Performance

Indexes backing these queries are listed in [../engineering/DATABASE.md](../engineering/DATABASE.md#indexes).

## Error codes

| Code | Status | When |
| ---- | ------ | ---- |
| `VALIDATION_ERROR` | 422 | Bad page/pageSize, unknown sort field, unknown param, malformed date, or `assignee` together with `assigneeIsNull` |

## Related pages

- [../pages/Tickets_List.md](../pages/Tickets_List.md) — the only consumer
