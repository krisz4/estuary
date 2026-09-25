---
type: Page
title: Edit task
description: Edit an existing task at /tasks/:taskId/edit, sending only changed fields, with version-conflict handling.
resource: apps/web/src/pages/task-edit/
tags: [tasks, form, update, version-conflict]
status: canonical
---
# Page Review: Edit Task

## Route

- Path: `/tasks/:taskId/edit`
- File: `src/pages/task-edit/TaskEditPage.tsx`
- Type: Client component

## Dependencies

### Components used

| Component | Role |
| --------- | ---- |
| `TaskForm` | **Same component as [Task_Create.md](./Task_Create.md)**, with `mode="edit"` — swaps the resolver to `updateTaskInputSchema`, drops the "starting status" field (status is never edited here), and changes the submit label to "Save changes" |
| `PageHeader` | Back link + "Edit TASK-000042" |
| `DetailField` | The read-only metadata `<dl>` below the form: Status (`StatusBadge`), Created by (`ActorBadge`), Created, Completed |
| `ConfirmDialog` | Discard confirmation |
| `FormSkeleton`, `ErrorPanel`, `NotFoundState` | Async states |

### Hooks / API calls

| Call | Method | Endpoint |
| ---- | ------ | -------- |
| `getTask(taskId)` | `GET` | `/api/v1/tasks/:taskId` — prefills the form |
| `updateTask(taskId, patch)` | `PATCH` | `/api/v1/tasks/:taskId` |
| `getTaskFacets()` | `GET` | `/api/v1/tasks/facets` — project suggestions |

Resolver: `zodResolver(updateTaskInputSchema)`.

## Fields

Same set as create (title, description, priority, project, assignee, acceptance criteria, links, parent task) — **minus status**. Status changes happen only through the detail page's `StatusSelect` / `TransitionDialog`, because a status change carries its own required payload and side effects; the edit form's `PATCH` never accepts `status` at all (the server rejects it with a `VALIDATION_ERROR` pointing at the transition endpoint).

Not editable here: `id`, `createdAt`, `createdBy`, `version`, `completedAt`, `startedAt`, `claimedBy` — they render as read-only metadata below the form, and the schema is `.strict()` so the API rejects them if sent.

**Clearing an optional field sends `null`, not `""`.** Same rule as create.

## Behavior / UI flow

1. Load the task, then mount `TaskForm` with `defaultValues` from it (`toFormValues(task)`). The form does not render before data arrives.
2. **Only changed fields are sent.** `diffTaskPatch()` compares the schema's output against **the task the form was initialised from** — a snapshot taken once at mount (`TaskEditForm`'s `baselineRef`), never the live query data, since react-hook-form reads `defaultValues` only once. Both sides of the diff are in the server's canonical shape (`null` for a cleared optional, a trimmed title, a lowercased project), so a trailing space the user typed is correctly *not* a change.
3. If nothing changed, submit short-circuits to a "No changes to save" info toast and does not call the API (the server would answer `AT_LEAST_ONE_FIELD` otherwise).
4. **Version conflict.** The save sends `expectedVersion` — the version the form was loaded at. If an agent (or anyone else) wrote the task in between, the server answers `VERSION_CONFLICT` (409); the page shows an alert banner above the form ("This task changed while you were editing… Reload to see their changes") with a **Reload task** button. Reloading re-fetches, bumps a `formGeneration` key so `TaskForm` remounts from the fresh copy, and — the one action on this page that replaces typed values — the notice says so before it happens. Nothing else on this page auto-merges a concurrent change.
5. **Success** — invalidate `queryKeys.tasks.detail(id)`, `queryKeys.tasks.all`, and the events feed, toast "Changes saved", navigate to `/tasks/:id` with `replace: true`, carrying `location.state` along.
6. **Cancel / dirty guard** — identical to create, and `replace`s the same way on both cancel and save, so Back from the detail page never re-opens this form.

## States

| State | Behavior |
| ----- | -------- |
| Loading | `FormSkeleton` |
| `TASK_NOT_FOUND` | `NotFoundState` + "Back to tasks" (covers a task deleted in another tab) |
| Load error | `ErrorPanel` + Retry |
| Field invalid | Inline error, same treatment as create |
| Saving | Button spinner, fields read-only |
| `VERSION_CONFLICT` (409) | Alert banner above the form with a "Reload task" action; every typed value stays until Reload is clicked |
| Save error (other) | Destructive toast; values preserved |

## Responsive

Identical to [Task_Create.md](./Task_Create.md) — same component, same breakpoints, same sticky action bar below `md`. The read-only metadata `<dl>` is `grid-cols-2` below `sm`, `grid-cols-4` from it.

## Accessibility

Inherited from `TaskForm`: labelled fields, `aria-invalid` + `aria-describedby`, assertive error summary on submit failure, native `<form>` submit. The version-conflict notice is `role="alert"`, since it arrives in response to the user's own save and changes what they should do next.

The read-only metadata block is a `<dl>`, not disabled inputs — disabled inputs are skipped by screen readers and look like something you failed to enable.

## Related

- [../features/Tasks.md](../features/Tasks.md) — update rules, immutable fields, optimistic concurrency
- [../features/Task_Status_Lifecycle.md](../features/Task_Status_Lifecycle.md) — where status actually changes
- [Task_Detail.md](./Task_Detail.md), [Task_Create.md](./Task_Create.md)
