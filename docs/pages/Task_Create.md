---
type: Page
title: Create task
description: Form for filing a new task at /tasks/new.
resource: apps/web/src/pages/task-create/
tags: [tasks, form, create]
status: canonical
---
# Page Review: Create Task

## Route

- Path: `/tasks/new` — declared **before** `/tasks/:taskId` in the router, otherwise `new` matches as an id
- File: `src/pages/task-create/TaskCreatePage.tsx`
- Type: Client component

## Dependencies

### Components used

| Component | Role |
| --------- | ---- |
| `TaskForm` (`src/features/tasks/TaskForm.tsx`) | **Shared with [Task_Edit.md](./Task_Edit.md)** — same fields, layout, and server-error mapping, driven by a `mode` prop. Create passes `emptyTaskFormValues()`; edit passes the loaded task and omits the status field |
| `PageHeader` | Back link + "New task" title |
| `Field`, `Input`, `Textarea`, `Select` | Primitives from `src/components/ui/` |
| `FormErrorSummary` | Assertive live region above the fields, and the home for any server message with no field |
| `ConfirmDialog` | Discard confirmation for a dirty cancel or a blocked navigation |
| `Button` | Submit ("Create task") and Cancel, in a bar that is sticky below `md` |

### Hooks / API calls

| Call | Method | Endpoint |
| ---- | ------ | -------- |
| `createTask(input)` | `POST` | `/api/v1/tasks` |
| `getTaskFacets()` | `GET` | `/api/v1/tasks/facets` — feeds the project field's `<datalist>` suggestions |

Form: react-hook-form + `zodResolver(createTaskInputSchema)` from `packages/contracts` — the same schema the server validates with.

## Fields

| Field | Control | Rules |
| ----- | ------- | ----- |
| Title | text | Required, 5–120 chars, live counter past 100 |
| Description | textarea, 6 rows | Required, 10–5000 chars |
| Starting status | select | One of `CREATABLE_TASK_STATUSES`: `backlog` (default), `needs_refinement`, `todo`. Picking `todo` makes Acceptance criteria required on this form — the contract's own `superRefine`, so the message is word-for-word what a `todo` transition would say |
| Priority | select | Defaults to `medium` |
| Project | text, with a `<datalist>` of existing values from facets | Optional. Free-text slug, canonicalized (lowercased) by the schema — see [../engineering/DATABASE.md](../engineering/DATABASE.md#canonical-values-instead-of-case-insensitive-matching) |
| Assignee | text | Optional free-form name/handle |
| Acceptance criteria | textarea | Optional unless Starting status is `todo`. ≤5000 chars |
| Links | repeatable label + URL rows | Optional, up to `TASK_LINKS_MAX`. A row left entirely blank is treated as unused, not as an invalid link |
| Parent task | text | Optional. Any spelling `parseReference` accepts — `12`, `#12`, `TASK-000012` |

Every optional field the form clears sends `null`, not `""` — the schema transforms it, but an empty string stored anywhere would vanish from every filter that matches on it exactly.

## Behavior / UI flow

1. Title field is focused on mount.
2. Validation runs on blur, then on change once a field has errored (`mode: "onTouched"`).
3. Submit disables the button, shows a spinner, and blocks double submission. Every create also carries a fresh `idempotencyKey` (minted once per visit to this page), so retrying a timed-out submit returns the original task rather than filing a duplicate.
4. **Success** — invalidate `queryKeys.tasks.all` and the events feed, toast "Task TASK-000042 created", and `navigate(/tasks/:id, { replace: true })` to the new task's detail page, carrying `location.state` along so the filtered list/board the user came from is still one "Back" away.
5. **Cancel** — if the form is untouched, navigate back immediately; if dirty, confirm discard first. Either way the destination is `useBackToListPath()` — the remembered view (`stores/taskView`) for the path, `location.state.from` for the query. Every entry point into this page (list rows, the empty-state CTA, both header "New task" buttons via `listReturnState(location)`) attaches that state.
6. A dirty form also guards browser navigation via a `beforeunload` handler **and** react-router's `useBlocker` (`lib/useUnsavedChangesGuard.ts`), both reading refs rather than props so a successful submit's own navigation is never mistaken for an unguarded exit.

## States

| State | Behavior |
| ----- | -------- |
| Idle | Submit enabled (validation happens on submit; a disabled-until-valid button hides *why* it is disabled) |
| Field invalid | Inline message under the field, red border, `aria-invalid`, `aria-describedby` |
| Submitting | Button spinner + disabled; fields read-only |
| `VALIDATION_ERROR` from the server | `details` split with `splitValidationErrors()`; recognised keys go on their fields, and `_` or any key this form does not render goes to `FormErrorSummary`. Focus moves to the first control marked `aria-invalid` in DOM order, falling back to the summary when the rejection named no rendered field |
| Other error | Destructive toast; all typed values preserved |

## Responsive

| Breakpoint | Layout |
| ---------- | ------ |
| < `md` | Single column, full-width fields, 16px base font on inputs. Actions stick to the bottom of the viewport in a bordered bar |
| ≥ `md` | Max-width `2xl` form; priority/project/assignee share rows; actions right-aligned below the form |

## Accessibility

- Every input has a real `<label for>`; placeholders are never used as labels.
- Errors are linked by `aria-describedby` and the field carries `aria-invalid`.
- On submit failure an `aria-live="assertive"` summary announces the failing fields before focus moves.
- The form is a real `<form>` with `onSubmit` — Enter submits from any text input.

## Related

- [../features/Tasks.md](../features/Tasks.md) — field rules and the create payload
- [../features/Task_Status_Lifecycle.md](../features/Task_Status_Lifecycle.md) — what "starting status" allows and why
- [../features/Validation_And_Contracts.md](../features/Validation_And_Contracts.md)
- [Task_Edit.md](./Task_Edit.md) — shares `TaskForm`
