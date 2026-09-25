---
type: Page
title: Edit ticket
description: Edit an existing ticket at /tickets/:ticketId/edit, sending only changed fields.
resource: apps/web/src/pages/ticket-edit/
tags: [tickets, form, update]
status: canonical
---
# Page Review: Edit Ticket

Task 4.5 of the brief.

## Route

- Path: `/tickets/:ticketId/edit`
- File: `src/pages/ticket-edit/TicketEditPage.tsx`
- Type: Client component

## Dependencies

### Components used

| Component | Role |
| --------- | ---- |
| `TicketForm` | **Same component as [Ticket_Create.md](./Ticket_Create.md)**, with `mode="edit"` — swaps the resolver to `updateTicketInputSchema`, adds the status field, and changes the submit label to "Save changes". Those three are the only differences |
| `PageHeader` | Back link + "Edit HD-000042" |
| `DetailField` | The read-only metadata `<dl>` below the form |
| `ConfirmDialog` | Discard confirmation |
| `FormSkeleton`, `ErrorPanel`, `NotFoundState` | Async states |

### Hooks / API calls

| Call | Method | Endpoint |
| ---- | ------ | -------- |
| `getTicket(ticketId)` | `GET` | `/api/v1/tickets/:ticketId` — prefills the form |
| `updateTicket(ticketId, patch)` | `PATCH` | `/api/v1/tickets/:ticketId` |

Resolver: `zodResolver(updateTicketInput)` from `packages/contracts`.

## Fields

Same set as create, **plus Status**, which is editable here and on the detail page. `requesterName` / `requesterEmail` remain editable — a typo'd requester email is a real correction people need.

Not editable: `id`, `createdAt`, `resolvedAt`, `closedAt`. They render as read-only metadata below the form; the schemas are `.strict()`, so the API rejects them if sent.

**Clearing an optional field sends `null`, not `""`.** Emptying the assignee input must produce `{ "assignee": null }`. The contract schema transforms `""` → `null` as a backstop, but the form should not rely on it: a ticket stored with an empty-string assignee matches neither the "Unassigned only" filter nor any name, so it vanishes from every assignee view. Same for category.

## Behavior / UI flow

1. Load the ticket, then `reset()` the form with its values. The form does not render before data arrives — a form that repopulates after mount fights anything already typed.
2. **Only changed fields are sent.** `diffTicketPatch()` compares the schema's *output* against **the ticket the form was initialised from** — a snapshot taken once at mount (`TicketEditForm`'s `baselineRef`), never the live query data. react-hook-form reads `defaultValues` once, so a refetch landing after mount would otherwise make the diff see a field the user never touched as changed and PATCH the stale value over someone else's edit. That is the exact loss the diff exists to prevent, so the two sides of the comparison must come from the same moment. It PATCHes the subset. Both sides are then in the server's canonical shape (`null` for a cleared optional, a trimmed title, a lowercased email), so a trailing space the user typed is correctly *not* a change. Sending the whole object would clobber a concurrent change to a field the user never touched.
3. If nothing changed, submit short-circuits to a "No changes to save" info toast and does not call the API (the server would answer `AT_LEAST_ONE_FIELD` anyway).
4. Status changes go through the same lifecycle guard as the detail page — see [../features/Ticket_Status_Lifecycle.md](../features/Ticket_Status_Lifecycle.md). An illegal transition surfaces inline on the status field with the allowed targets, built from the server's `details.allowed` by `lib/statusTransition.ts`. Neither screen keeps a local copy of the transition table: the guard is deliberately permissive and has been loosened before, and a client-side copy would forbid something the server allows with nothing failing anywhere.
5. **Success** — invalidate `queryKeys.tickets.detail(id)` and `queryKeys.tickets.all`, toast "Changes saved", navigate back to `/tickets/:id` with `replace: true`.
6. **Cancel / dirty guard** — identical to create: untouched cancels immediately, dirty confirms discard.

## States

| State | Behavior |
| ----- | -------- |
| Loading | `FormSkeleton` |
| `TICKET_NOT_FOUND` | `NotFoundState` + "Back to tickets" (covers a ticket deleted in another tab) |
| Load error | `ErrorPanel` + Retry |
| Field invalid | Inline error, same treatment as create |
| Saving | Button spinner, fields read-only |
| `INVALID_STATUS_TRANSITION` (409) | Inline on the status field, listing `details.allowed`; other edits stay in the form |
| Save error | Destructive toast; values preserved |

## Responsive

Identical to [Ticket_Create.md](./Ticket_Create.md) — same component, same breakpoints, same sticky action bar below `md`.

## Accessibility

Inherited from `TicketForm`: labelled fields, `aria-invalid` + `aria-describedby`, assertive error summary on submit failure, native `<form>` submit.

The read-only metadata block is a `<dl>`, not disabled inputs — disabled inputs are skipped by screen readers and look like something you failed to enable.

## Related

- [../features/Tickets.md](../features/Tickets.md) — update rules, immutable fields
- [../features/Ticket_Status_Lifecycle.md](../features/Ticket_Status_Lifecycle.md)
- [Ticket_Detail.md](./Ticket_Detail.md), [Ticket_Create.md](./Ticket_Create.md)
