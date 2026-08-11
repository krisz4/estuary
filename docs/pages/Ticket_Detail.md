---
type: Page
title: Ticket detail
description: Full ticket view with inline status change, comment thread, edit and delete actions.
resource: apps/web/src/pages/ticket-detail/
tags: [tickets, detail, comments, delete]
status: canonical
---
# Page Review: Ticket Detail

Task 4.2 of the brief — a separate page, not a modal, so the URL is shareable.

## Route

- Path: `/tickets/:ticketId` — `ticketId` is the integer id, which **is** the ticket number (`/tickets/42` ↔ `HD-000042`). See [../features/Ticket_Numbering.md](../features/Ticket_Numbering.md). A non-numeric segment 404s rather than 422s.
- File: `src/pages/ticket-detail/TicketDetailPage.tsx`
- Type: Client component, data via TanStack Query

## Dependencies

### Components used

| Component | Role on this page |
| --------- | ----------------- |
| `PageHeader` | Back link to the list (preserving the previous query string), reference + title, action buttons |
| `StatusSelect` | Inline status change — the most common action, so it does not require entering the edit form |
| `StatusBadge`, `PriorityBadge` | Current state |
| `DetailField` | Label/value pair used for requester, assignee, category, timestamps |
| `CommentThread` (`src/features/comments/`) | Ordered list of comments + composer |
| `ConfirmDialog` | Destructive delete confirmation |
| `DetailSkeleton`, `ErrorPanel`, `NotFoundState` | Async states |

### Hooks / API calls

| Call | Method | Endpoint |
| ---- | ------ | -------- |
| `getTicket(ticketId)` | `GET` | `/api/v1/tickets/:ticketId` — includes `comments` |
| `updateTicket(ticketId, { status })` | `PATCH` | `/api/v1/tickets/:ticketId` (inline status change) |
| `deleteTicket(ticketId)` | `DELETE` | `/api/v1/tickets/:ticketId` |
| `createComment(ticketId, input)` | `POST` | `/api/v1/tickets/:ticketId/comments` |
| `deleteComment(ticketId, commentId)` | `DELETE` | `/api/v1/tickets/:ticketId/comments/:commentId` |

Query key: `queryKeys.tickets.detail(ticketId)`. Every mutation on this page invalidates that key **and** `queryKeys.tickets.all` (the list's status counts and rows are now stale).

## Behavior / UI flow

1. **Header** — `HD-000042` as small muted text above the title; title as `<h1>`. Right side: "Edit" (→ `/tickets/:id/edit`) and "Delete" (destructive variant).
2. **Back link** returns to the list carrying the previous search params from `location.state.from`, so a user does not lose their filters. If opened directly (no state), it goes to bare `/tickets`.
3. **Summary grid** — status, priority, category, requester (name + mailto link), assignee (or "Unassigned"), created, updated, resolved/closed when set. Timestamps show relative time with the absolute value in `title` and in a `<time datetime>` attribute.
4. **Description** — plain text with `whitespace-pre-wrap` so the requester's line breaks survive. Rendered as a text node; never `dangerouslySetInnerHTML`.
5. **Inline status change** — selecting a new status fires the PATCH immediately with an optimistic update; the select is disabled while in flight. On failure it rolls back and shows the error inline next to the control (an `INVALID_STATUS_TRANSITION` lists the allowed targets from `details.allowed`).
6. **Comments** — oldest first. Each shows author, relative timestamp, body, and a delete button. The delete button is revealed on hover/focus **only under `@media (hover: hover)`**; on touch devices it is always visible, since a hover-gated control is simply unreachable there. The composer (author name + body) sits below the thread; submit is disabled while empty or pending. On success the form clears and the new comment gets focus. On failure the typed text stays.
7. **Delete** — opens `ConfirmDialog` naming the ticket ("Delete HD-000042? This also deletes its 3 comments. This can't be undone."). On confirm: DELETE, invalidate the list, toast, navigate to `/tickets`. Cancel is the default-focused button.

## States

| State | Behavior |
| ----- | -------- |
| Loading | `DetailSkeleton` mirroring the real layout |
| Error (network/5xx) | `ErrorPanel` + Retry |
| `TICKET_NOT_FOUND` (404) | `NotFoundState`: "This ticket doesn't exist or was deleted" + "Back to tickets". Not a toast, not a blank page |
| Deleted in another tab | The next refetch 404s and lands in the same not-found state |
| Empty comments | "No comments yet" line above the composer |
| Mutation pending | Affected control disabled with a spinner; the rest of the page stays interactive |

## Responsive

| Breakpoint | Layout |
| ---------- | ------ |
| < `md` | Single column. Summary grid becomes a stacked definition list. Edit/Delete move into the header as icon buttons with labels in an overflow menu. Comment composer fields stack full-width |
| ≥ `md` | Two columns: description + comments (main), summary fields (aside, `w-72`) |

## Accessibility

- `<h1>` is the ticket title; comment authors are `<h3>`.
- The comment list is a `<ul>` with an `aria-label`; timestamps use `<time datetime>`.
- `ConfirmDialog` traps focus, closes on `Escape`, restores focus to the Delete button, and is labelled by its heading.
- The status select has a visible label and announces the change through a polite live region ("Status changed to In progress").
- Delete-comment buttons have per-comment labels ("Delete comment by Marcus Feld").

## Related

- [../features/Tickets.md](../features/Tickets.md), [../features/Comments.md](../features/Comments.md)
- [../features/Ticket_Status_Lifecycle.md](../features/Ticket_Status_Lifecycle.md)
- [Ticket_Edit.md](./Ticket_Edit.md), [Tickets_List.md](./Tickets_List.md)
