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
| `PageHeader` | Back link + "New ticket" title |
| `Field`, `Input`, `Textarea`, `Select` | Primitives from `src/components/ui/`. `Field` is a render prop that owns the label / `aria-invalid` / `aria-describedby` wiring — do not re-wire ARIA per form |
| `FormErrorSummary` | Assertive live region above the fields, and the home for any server message with no field |
| `ConfirmDialog` | Discard confirmation for a dirty cancel or a blocked navigation |
| `Button` | Submit ("Create ticket") and Cancel, in a bar that is sticky below `md` |

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
| Category | select | Optional. The `TicketCategory` enum: `hardware`, `software`, `network`, `access`, `email`, `other`. A "No category" option submits `null`, not `""`. It carries an internal sentinel value rather than `""`, because `""` is Radix Select's own "nothing selected" marker |
| Requester name | text | Required, 2–80 |
| Requester email | email | Required, valid email. Helper text: "We'll use this to follow up — it is not an account". Lowercased by the schema before it is sent |
| Assignee | text | Optional. Present because IT often files on someone's behalf |

Status is **not** on this form — every new ticket starts `open`. Offering a status picker at creation invites "resolved" tickets that were never open.

The `status` key is **absent from the form values entirely**, not merely unrendered. `createTicketInputSchema` is `.strict()`, so a `status` present in the parsed object is a 422 raised by the client's own resolver, on a form that looks complete.

## Behavior / UI flow

1. Title field is focused on mount.
2. Validation runs on blur, then on change once a field has errored (`mode: "onTouched"`) — validating every keystroke from the start scolds people mid-typing.
3. Submit disables the button, shows a spinner, and blocks double submission. Mutations are never auto-retried, so a double-click cannot create two tickets.
4. **Success** — invalidate `queryKeys.tickets.all`, toast "Ticket HD-000042 created", and `navigate(/tickets/:id, { replace: true })` to the new ticket's detail page. `replace` means Back returns to the list, not to a form whose submission already happened.
5. **Cancel** — if the form is untouched, navigate back immediately; if dirty, confirm discard first. Either way the destination is `backToListPath(location.state)`, so the filtered list the user came from is restored. Every link into this page carries that state: the list rows and the empty-state CTA attach `{ from: search }`, and `AppHeader`'s two "New ticket" buttons derive it with `listReturnState(location)` — the header is not rendered by the list page, so it reads the current location itself. Without that state on **every** entry point, cancelling lands on a bare `/tickets` and drops the filters.
6. A dirty form also guards browser navigation via a `beforeunload` handler **and** react-router's `useBlocker` — two different exits needing two mechanisms, both in `lib/useUnsavedChangesGuard.ts`. Both predicates read refs rather than props, because a successful submit calls `allowNavigation()` and navigates in the same tick, and a value captured at render time would still say "dirty".

## States

| State | Behavior |
| ----- | -------- |
| Idle | Submit enabled (validation happens on submit; a disabled-until-valid button hides *why* it is disabled) |
| Field invalid | Inline message under the field, red border, `aria-invalid`, `aria-describedby` |
| Submitting | Button spinner + disabled; fields read-only |
| `VALIDATION_ERROR` from the server | `details` split with `splitValidationErrors()`; recognised keys go on their fields, and `_` or any key this form does not render goes to `FormErrorSummary`. **Never mapped onto fields directly** — `setError` on an unregistered name is dropped silently. No toast. Focus moves to the first control marked `aria-invalid` **in DOM order**, falling back to the summary when the rejection named no rendered field. It is *not* `setError`'s `shouldFocus`: that focuses a registered input ref, and the three selects have none, so a 422 naming `category` used to move focus nowhere |
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
