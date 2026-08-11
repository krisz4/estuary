---
type: Feature
title: Comments
description: Ticket comment thread — model, endpoints, ordering, and cascade behavior.
resource: apps/api/src/services/comment.service.ts
tags: [tickets, comments, api]
status: canonical
---
# Comments

The brief lists "comments" among the ticket fields. They are modelled as a child table rather than a text blob so each entry keeps its own author and timestamp.

## Overview

| Concern | Location |
| ------- | -------- |
| Prisma model | `Comment` in `apps/api/prisma/schema.prisma` |
| Shapes | `packages/contracts/src/comment.ts` |
| Service | `apps/api/src/services/comment.service.ts` |
| Route | `apps/api/src/routes/comments.route.ts` (mounted under `/tickets/:ticketId/comments`) |
| UI | `apps/web/src/features/comments/CommentThread.tsx` on [../pages/Ticket_Detail.md](../pages/Ticket_Detail.md) |

## Data model

| Field | Type | Notes |
| ----- | ---- | ----- |
| `id` | `Int` | Autoincrement. Monotonic, which is what makes the ordering tiebreaker correct |
| `ticketId` | `Int` | FK → `Ticket.id`, `onDelete: Cascade` |
| `authorName` | `String` | 2–80 chars. A name, not an account |
| `body` | `String` | 1–2000 chars, trimmed. Plain text, rendered escaped |
| `createdAt` | `DateTime` | |

No `updatedAt`: comments are append-only. There is no edit endpoint, because an editable audit trail that nobody audits is just a mutable field with extra steps.

## Rules

- **Ordering is `createdAt` ascending, then `id` ascending** (oldest first) everywhere — the thread reads top to bottom. The `id` tiebreaker is reliable *because* ids are sequential integers; the seed creates several comments inside the same millisecond, so without a monotonic tiebreaker their order would be arbitrary and would differ between runs.
- **Comments load with the ticket.** `GET /tickets/:ticketId` includes the full `comments` array. There is no separate list endpoint and no comment pagination — a helpdesk ticket with 500 comments is not a case worth designing for here.
- **List responses never include comments**, only `commentCount`. Including them would turn the list query into an N+1.
- **Deleting a ticket deletes its comments** via FK cascade, enforced at the database level rather than in application code, so it holds even for direct SQL.
- **Comment writes do not touch `Ticket.updatedAt`.** `updatedAt` means "a ticket field changed". A busy thread would otherwise keep bumping tickets to the top of an `updatedAt` sort while nothing about the ticket itself moved. If "last activity" ordering is ever wanted, it needs its own column — do not repurpose this one.

## API

| Method | Path | Purpose | Success |
| ------ | ---- | ------- | ------- |
| `POST` | `/api/v1/tickets/:ticketId/comments` | Add a comment | `201` + `Location` + the created comment |
| `DELETE` | `/api/v1/tickets/:ticketId/comments/:commentId` | Remove one | `204`, no body |

There is no `GET` and no `PUT`. The thread ships with its ticket (`GET /tickets/:ticketId` includes `comments`), so a second read path would need its own ordering and paging rules to keep in step with the first; and comments are append-only, so there is nothing to `PUT`. Both fall through to the `notFound` middleware as `NOT_FOUND` 404 — the contract has no `METHOD_NOT_ALLOWED`.

The router is mounted at `/api/v1/tickets/:ticketId/comments` with `Router({ mergeParams: true })`. Without that flag `:ticketId` is captured by the mount path and never reaches the handler, so every comment request 404s — which reads as "the ticket does not exist" rather than "the router is misconfigured".

```http
POST /api/v1/tickets/42/comments

{ "authorName": "Marcus Feld", "body": "Reissued the VPN certificate — try again and let me know." }
```

### Not-found handling

**`POST` checks that the ticket exists before inserting.** Relying on the foreign key to fail is not sufficient: a missing parent raises Prisma `P2003` (foreign key constraint failed), not `P2025`, so an unguarded insert would surface as a 500 instead of the documented 404. The service does an explicit `findUnique` and throws `TICKET_NOT_FOUND`.

**`DELETE` scopes by both ids** — `deleteMany({ where: { id: commentId, ticketId } })` — and treats a zero count as `COMMENT_NOT_FOUND`. That covers both "no such comment" and "the comment exists but belongs to a different ticket" with the same 404, so the path cannot be used to probe for other tickets' comment ids. A `findUnique` + compare would leak the difference through timing and through the temptation to return 403.

## UI behavior

The composer sits below the thread with the author name and body fields. On success the mutation invalidates `queryKeys.tickets.detail(ticketId)` and clears the form; the new comment appears at the bottom and receives focus for screen readers. Failure keeps the typed text — never clear a form you failed to submit.

## Error codes

| Code | Status | When |
| ---- | ------ | ---- |
| `TICKET_NOT_FOUND` | 404 | Parent ticket missing, or `:ticketId` is not a positive integer |
| `COMMENT_NOT_FOUND` | 404 | Comment missing, not on this ticket, or `:commentId` is not a positive integer |
| `VALIDATION_ERROR` | 422 | Empty body, over-length body, missing author |

The body is validated **before** the parent is looked up, so `POST /tickets/999999/comments` with an invalid payload is a 422, not a 404. Either answer would be defensible; a route test pins which one the API gives so a reordering of the handler is a visible change.

## Related pages

- [../pages/Ticket_Detail.md](../pages/Ticket_Detail.md)
- [Tickets.md](./Tickets.md)
- [Error_Handling.md](./Error_Handling.md)
