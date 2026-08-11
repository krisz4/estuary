---
type: Page
title: Create ticket
description: Form for filing a new ticket at /tickets/new.
resource: apps/web/src/pages/ticket-create/
tags: [tickets, form, create]
status: canonical
---
# Page Review: Create Ticket

Task 4.3 of the brief.

## Route

- Path: `/tickets/new` — declared **before** `/tickets/:ticketId` in the router, otherwise `new` matches as an id
- File: `src/pages/ticket-create/TicketCreatePage.tsx`
- Type: Client component

## Dependencies

### Components used

| Component | Role |
| --------- | ---- |
| `TicketForm` (`src/features/tickets/TicketForm.tsx`) | **Shared with [Ticket_Edit.md](./Ticket_Edit.md)** — same fields, driven by a `mode` prop |
| `PageHeader` | "New ticket" title + Cancel |
| `FormField`, `Input`, `Textarea`, `Select` | Primitives with label, description, and error slots |
| `Button` | Submit ("Create ticket") and Cancel |

`TicketForm` is one component, not two near-copies. Create passes `defaultValues` from the create schema; edit passes the loaded ticket and shows the status field.

### Hooks / API calls

| Call | Method | Endpoint |
| ---- | ------ | -------- |
| `createTicket(input)` | `POST` | `/api/v1/tickets` |

Form: react-hook-form + `zodResolver(createTicketInput)` from `packages/contracts` — the same schema the server validates with, so client and server messages agree.

## Fields

| Field | Control | Rules |
| ----- | ------- | ----- |
| Title | text | Required, 5–120 chars, live counter past 100 |
| Description | textarea, 6 rows, autosize | Required, 10–5000 chars |
| Priority | select | Defaults to `medium` |
| Category | select | Optional. The `TicketCategory` enum: `hardware`, `software`, `network`, `access`, `email`, `other`. The blank option submits `null`, not `""` |
| Your name | text | Required, 2–80 |
| Your email | email | Required, valid email. Helper text: "We'll use this to follow up" — it is not an account |
| Assignee | text | Optional. Present because IT often files on someone's behalf |

Status is **not** on this form — every new ticket starts `open`. Offering a status picker at creation invites "resolved" tickets that were never open.

## Behavior / UI flow

1. Title field is focused on mount.
2. Validation runs on blur, then on change once a field has errored (`mode: "onTouched"`) — validating every keystroke from the start scolds people mid-typing.
3. Submit disables the button, shows a spinner, and blocks double submission. Mutations are never auto-retried, so a double-click cannot create two tickets.
4. **Success** — invalidate `queryKeys.tickets.all`, toast "Ticket HD-000042 created", and `navigate(/tickets/:id, { replace: true })` to the new ticket's detail page. `replace` means Back returns to the list, not to a form whose submission already happened.
5. **Cancel** — if the form is untouched, navigate back immediately; if dirty, confirm discard first.
6. A dirty form also guards browser navigation via a `beforeunload` handler and the router blocker.

## States

| State | Behavior |
| ----- | -------- |
| Idle | Submit enabled (validation happens on submit; a disabled-until-valid button hides *why* it is disabled) |
| Field invalid | Inline message under the field, red border, `aria-invalid`, `aria-describedby` |
| Submitting | Button spinner + disabled; fields read-only |
| `VALIDATION_ERROR` from the server | `details` mapped onto the matching fields; focus moves to the first one. No toast — the errors are on screen |
| Other error | Destructive toast; **all typed values preserved** |

## Responsive

| Breakpoint | Layout |
| ---------- | ------ |
| < `md` | Single column, full-width fields, 16px base font on inputs (anything smaller triggers iOS zoom-on-focus). Actions stick to the bottom of the viewport in a bordered bar so Submit is always reachable |
| ≥ `md` | Max-width `2xl` form; priority and category share a row; actions right-aligned below the form |

## Accessibility

- Every input has a real `<label for>`; placeholders are never used as labels.
- Errors are linked by `aria-describedby` and the field carries `aria-invalid`.
- On submit failure an `aria-live="assertive"` summary announces "3 fields need attention" before focus moves.
- The form is a real `<form>` with `onSubmit` — Enter submits from any text input.

## Related

- [../features/Tickets.md](../features/Tickets.md) — field rules and the create payload
- [../features/Validation_And_Contracts.md](../features/Validation_And_Contracts.md)
- [Ticket_Edit.md](./Ticket_Edit.md) — shares `TicketForm`
