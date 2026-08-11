---
type: Feature
title: Tickets
description: The Ticket resource — fields, CRUD endpoints, validation rules, and delete semantics.
resource: apps/api/src/services/ticket.service.ts
tags: [tickets, crud, api, core]
status: canonical
---
# Tickets

The single core resource. Everything else in the product hangs off it.

## Overview

| Concern | Location |
| ------- | -------- |
| Prisma model | `Ticket` in `apps/api/prisma/schema.prisma` |
| Shapes + validation | `packages/contracts/src/ticket.ts` |
| Business logic | `apps/api/src/services/ticket.service.ts` |
| HTTP layer | `apps/api/src/routes/tickets.route.ts` |
| Client hooks | `apps/web/src/api/tickets.ts` |
| List UI | [../pages/Tickets_List.md](../pages/Tickets_List.md) |
| Detail UI | [../pages/Ticket_Detail.md](../pages/Ticket_Detail.md) |

## Data model

| Field | Type | Notes |
| ----- | ---- | ----- |
| `id` | `Int` | Primary key **and** the ticket number. Appears in URLs; rendered as `HD-000042` — see [Ticket_Numbering.md](./Ticket_Numbering.md) |
| `title` | `String` | 5–120 chars, trimmed, required |
| `description` | `String` | 10–5000 chars, trimmed, required. Plain text — rendered as escaped text nodes, never `dangerouslySetInnerHTML` |
| `status` | `String` | `open` \| `in_progress` \| `resolved` \| `closed`. Default `open`. See [Ticket_Status_Lifecycle.md](./Ticket_Status_Lifecycle.md) |
| `priority` | `String` | `low` \| `medium` \| `high` \| `urgent`. Default `medium`. See [Ticket_Priority.md](./Ticket_Priority.md) |
| `category` | `String?` | Enum: `hardware` \| `software` \| `network` \| `access` \| `email` \| `other`. Optional |
| `requesterName` | `String` | 2–80 chars. The "user" from the brief — a plain name field, **not** an account |
| `requesterEmail` | `String` | Valid email, trimmed and **lowercased on write** (exact-match filtering depends on it) |
| `assignee` | `String?` | Free-form name of the IT person handling it, 2–80 chars |
| `createdAt` | `DateTime` | Set by DB default |
| `updatedAt` | `DateTime` | Prisma `@updatedAt`. Moves only on ticket field changes — **not** when a comment is added |
| `resolvedAt` | `DateTime?` | Set/cleared by status transitions, never by the client |
| `closedAt` | `DateTime?` | Same |
| `comments` | `Comment[]` | Cascade delete — see [Comments.md](./Comments.md) |

`status`, `priority`, and `category` are `String` columns because **SQLite has no enum type**. The zod enums in `packages/contracts` are the real constraint; a service must never write a value that did not come from the corresponding `.parse()`.

`category` is an enum rather than free text so that exact-match filtering works: SQLite's `equals` is case-sensitive and Prisma's SQLite connector has no `mode: "insensitive"`, so a free-text category would make `?category=Network` silently miss rows stored as `network`. See [../engineering/DATABASE.md](../engineering/DATABASE.md#canonical-values-instead-of-case-insensitive-matching).

## Rules

- **Client-supplied fields on create:** `title`, `description`, `priority?`, `category?`, `requesterName`, `requesterEmail`, `assignee?`. Everything else is server-owned.
- **Immutable after create:** `id`, `createdAt`. Schemas are `.strict()`, so a payload containing them is rejected with `VALIDATION_ERROR` rather than silently ignored — silent stripping hides client bugs.
- **`resolvedAt` / `closedAt` are derived**, never accepted from the client. They are written by the status transition logic.
- **Update is a partial PATCH.** An empty body (`{}`) returns `AT_LEAST_ONE_FIELD` (422), not a no-op 200 — an empty update is always a client bug.
- **Optional string fields normalize `""` to `null`.** `assignee` and `category` are declared as `z.string().trim().transform(v => v === "" ? null : v).nullable().optional()`. Without this, clearing a field in the edit form stores an empty string, and that ticket then matches neither `assigneeIsNull=true` nor any name filter — it disappears from every assignee view. Any new optional string field gets the same treatment.
- **Delete is a hard delete.** The brief asks for delete; soft-delete would leak into every query for no user-visible benefit. Comments cascade at the database level. Irreversible, and the UI confirms first.

## API

Base path `/api/v1`. Full parameter reference for the list endpoint lives in [Ticket_Query_Filter_Sort_Page.md](./Ticket_Query_Filter_Sort_Page.md).

| Method | Path | Purpose | Success |
| ------ | ---- | ------- | ------- |
| `GET` | `/tickets` | List with filter / sort / page | `200` enveloped |
| `GET` | `/tickets/facets` | Distinct assignees + categories in use, for filter selects | `200` |
| `GET` | `/tickets/:ticketId` | One ticket **with its comments** | `200` object |
| `POST` | `/tickets` | Create | `201` + `Location` header |
| `PATCH` | `/tickets/:ticketId` | Partial update | `200` object |
| `DELETE` | `/tickets/:ticketId` | Hard delete | `204` no body |

`/tickets/facets` is declared **before** `/tickets/:ticketId` in the router, or `facets` is parsed as an id. (It would then fail the numeric coercion and 404, which is a confusing way to discover a routing order bug.)

`PUT` is deliberately not implemented — the UI only ever sends partial edits, and offering both invites two code paths that drift.

### Create

```http
POST /api/v1/tickets
Content-Type: application/json

{
  "title": "Laptop won't connect to the VPN",
  "description": "Fails with error 809 since the Tuesday update. Tried rebooting and reinstalling the client.",
  "priority": "high",
  "category": "network",
  "requesterName": "Dana Whitfield",
  "requesterEmail": "dana.whitfield@example.com"
}
```

Returns the full ticket (with `comments: []`) and `Location: /api/v1/tickets/42`.

### Detail response

```json
{
  "id": 42,
  "reference": "HD-000042",
  "title": "Laptop won't connect to the VPN",
  "description": "Fails with error 809 ...",
  "status": "in_progress",
  "priority": "high",
  "category": "network",
  "requesterName": "Dana Whitfield",
  "requesterEmail": "dana.whitfield@example.com",
  "assignee": "Marcus Feld",
  "createdAt": "2026-08-03T09:14:22.000Z",
  "updatedAt": "2026-08-04T11:02:41.000Z",
  "resolvedAt": null,
  "closedAt": null,
  "commentCount": 3,
  "comments": [ /* oldest first — see Comments.md */ ]
}
```

`reference` is computed, not stored. List responses carry `commentCount` but **omit** `comments` — the list must not fan out into N comment queries.

### Facets

```json
{ "assignees": ["Marcus Feld", "Priya Raman"], "categories": ["access", "network"] }
```

Distinct non-null values actually present in the table, sorted. It exists because the list page's assignee select has no other source of options, and because sending an exact stored value is what makes case-sensitive equality matching safe. Categories are returned even though the enum is fixed, so the filter only offers values that would return rows.

### Error codes

| Code | Status | When |
| ---- | ------ | ---- |
| `VALIDATION_ERROR` | 422 | zod rejected the body or query; `details` carries per-field messages |
| `AT_LEAST_ONE_FIELD` | 422 | Empty PATCH body |
| `TICKET_NOT_FOUND` | 404 | No ticket with that id, **and** for a non-numeric id — do not leak the difference |
| `INVALID_STATUS_TRANSITION` | 409 | See [Ticket_Status_Lifecycle.md](./Ticket_Status_Lifecycle.md) |

`PATCH` and `DELETE` check existence explicitly before writing, rather than relying on Prisma's `P2025`. That check is what makes a 404 reliable — see [Error_Handling.md](./Error_Handling.md).

## Testing expectations

Every CRUD path has a service unit test plus a route integration test (supertest against a temp SQLite file). Required cases are enumerated in [../engineering/TESTING.md](../engineering/TESTING.md) — read that list rather than inventing one.

## Related pages

- [../pages/Tickets_List.md](../pages/Tickets_List.md)
- [../pages/Ticket_Detail.md](../pages/Ticket_Detail.md)
- [../pages/Ticket_Create.md](../pages/Ticket_Create.md)
- [../pages/Ticket_Edit.md](../pages/Ticket_Edit.md)
