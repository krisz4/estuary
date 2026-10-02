---
type: Feature
title: Task status lifecycle
description: The ten task statuses, what each means, what a transition into it requires, and the side effects it triggers.
resource: apps/api/src/services/task-workflow.service.ts
tags: [tasks, status, workflow, agents]
status: canonical
---
# Task status lifecycle

## Overview

| Concern | Location |
| ------- | -------- |
| Enum, lanes, attention set | `TASK_STATUSES`, `TASK_STATUS_LANES`, `HUMAN_ATTENTION_STATUSES` in `packages/contracts/src/task.ts` |
| What each transition requires | `transitionInputSchema` in `packages/contracts/src/task-workflow.ts` |
| Transition, claims, decisions, unblocking | `apps/api/src/services/task-workflow.service.ts`, `task-guards.ts` |
| Ranks, status note, timestamps (pure) | `apps/api/src/services/task-status.ts` |
| Endpoint reference | [Task_Workflow_API.md](./Task_Workflow_API.md) |

## States

The array order is the persisted `statusRank`, so "sort by status" follows this table.

| Rank | Value | Lane | Meaning | Who usually moves it here |
| ---- | ----- | ---- | ------- | ------------------------- |
| 0 | `backlog` | plan | Captured, not yet planned. **Default for new tasks.** | anyone |
| 1 | `needs_refinement` | plan | Too vague to start: missing detail, scope, or acceptance criteria | agent triage, human |
| 2 | `todo` | plan | Ready to work: has acceptance criteria | human, agent after refining |
| 3 | `in_progress` | doing | Being worked; has a live claim | agent via `next` / `claim` |
| 4 | `blocked` | waiting | Waiting on other tasks (`blockedBy`) or an external reason | agent |
| 5 | `needs_user_decision` | waiting | An agent asked a question with options and cannot proceed without an answer | agent |
| 6 | `needs_user_action` | waiting | A human must do something manual (credentials, a console click, a purchase) | agent |
| 7 | `needs_qa` | doing | Work done; a human (or QA agent) verifies it | agent |
| 8 | `done` | closed | Verified complete. **Agents cannot move here** unless `AGENTS_MAY_COMPLETE=true` | human |
| 9 | `deferred` | closed | Parked on purpose — the fallback when no other status applies, always with a reason | anyone |

`needs_user_decision`, `needs_user_action`, and `needs_qa` (`HUMAN_ATTENTION_STATUSES`) are the three statuses where an agent explicitly stopped and asked. They are a subset of the broader **attention queue** — `needs_refinement`, an un-triaged `backlog`/`todo` suggestion, and a `blocked` task with no unfinished dependency also sit in front of a person, for reasons nothing about their status alone declares. `GET /tasks/stats`'s `needsAttention` counts the whole attention set, not just these three. See [Attention_Queue.md](./Attention_Queue.md) for the six kinds, `needsTriage`, and `concerns`.

## Transitions

**There is no from→to table.** Any status may move to any other. The helpdesk this grew out of had one; for an agent workflow the useful gate is not *where a task came from* but *what the mover knows*, so each target status declares the payload it needs and the contract's discriminated union enforces it. A missing field is an ordinary `VALIDATION_ERROR` naming that field.

| To | Payload | Checked against the stored task |
| -- | ------- | -------------------------------- |
| `backlog` | `reason?` | — |
| `needs_refinement` | **`reason`** (what is unclear) | — |
| `todo` | `acceptanceCriteria?`, `reason?` | the task must end up with acceptance criteria (supplied now or already stored) |
| `in_progress` | `reason?` | takes the claim; another live claim blocks agents (`TASK_ALREADY_CLAIMED`) |
| `blocked` | `reason` and/or **`blockedBy: taskId[]`** (at least one) | each `blockedBy` is added as a dependency: must exist, not self, no cycle |
| `needs_user_decision` | **`decision`**: `question`, `options` (2–6 unique labels), `recommendedOption?` (one of the labels), `context?` | creates a `Decision`; withdraws any older open one |
| `needs_user_action` | **`instructions`** | — |
| `needs_qa` | **`summary`**, `links?`, `concerns?`, `followUps?` | links are appended to the task's links, de-duplicated by URL. `concerns`: what a reviewer must not miss (omit for a routine hand-off). `followUps` (max 10): work found but not done, filed as subtasks — see [Attention_Queue.md](./Attention_Queue.md) |
| `done` | `reason?` | agent actors → `ACTOR_NOT_PERMITTED` (403) unless `AGENTS_MAY_COMPLETE` |
| `deferred` | **`reason`** | — |

Every transition body also accepts `expectedVersion` (→ `VERSION_CONFLICT` on mismatch).

`PATCH /tasks/:taskId` does not accept `status` at all; sending it returns a `VALIDATION_ERROR` on `status` that points at the transition endpoint.

### Same-status transitions

`blocked → blocked` with a new reason is allowed and **does** write: it is how a blocker is updated. This differs from the helpdesk's "same status is a no-op" rule, which existed because PATCH carried status alongside other fields; the transition endpoint carries nothing else, so a same-status call always means "update the note".

### Other ways a status changes

| Path | Result |
| ---- | ------ |
| `POST /tasks/next`, `POST /tasks/:id/claim` | → `in_progress`, claimed |
| `POST /tasks/:id/release` | `in_progress` → `todo`, claim cleared |
| `POST /tasks/:id/decision/answer` | `needs_user_decision` → `todo` (criteria gate skipped — the task was already in flight) |
| Auto-unblock (server, as `system:taskmanager`) | `blocked` → `todo` once every dependency is `done` — after a blocker reaches `done`, is deleted, or a dependency is removed |

## Side effects

Applied in the same write as the status:

| Effect | When |
| ------ | ---- |
| `statusNote` replaced | Every transition: `reason` / `instructions` / `summary` / the decision's question, or `null` |
| `concerns` set or cleared | Set only by a `needs_qa` transition (from its optional `concerns`); **any** other transition clears it, including `needs_qa → needs_qa` with no `concerns` sent |
| `needsTriage` cleared | A human actor's transition; an agent transitioning to `in_progress`, `done`, or `deferred`. An agent moving its own suggestion to any other status (e.g. refining it into `todo`) leaves it set — see [Attention_Queue.md](./Attention_Queue.md) |
| follow-ups filed | `needs_qa` transition and `release`, from their optional `followUps` — each a subtask, see [Attention_Queue.md](./Attention_Queue.md) |
| `statusRank` recomputed | Every status write, via `applyTaskRanks()` — the only writer |
| `startedAt = now` | First entry into `in_progress` only; never cleared |
| `completedAt = now` | → `done` |
| `completedAt = null` | `done` → anything else (reopened) |
| claim set / cleared | set on → `in_progress`, cleared on any other target |
| open decision withdrawn | any transition while one is open (a new question replaces the old one) |
| `version + 1` | every write to the task row |
| event(s) recorded | `task.status_changed` always; `task.claimed`, `decision.requested`, `decision.withdrawn`, `dependency.added` as applicable |

`deferred` does **not** satisfy a dependency: a task waiting on something that was parked keeps waiting.

## UI mapping

Badges always render the text label; colour never carries the meaning alone ([../engineering/UI_DESIGN_GUIDELINES.md](../engineering/UI_DESIGN_GUIDELINES.md)). Moving to a status that needs payload opens the transition dialog, from the detail page's picker, the inbox, or the map; cancelling it puts the task back where it was.

No client keeps its own copy of these rules beyond the shared contract: the web dialog asks for the fields `transitionInputSchema` requires for the target status, and server `VALIDATION_ERROR` details map back onto them.

## Error codes

| Code | Status | When |
| ---- | ------ | ---- |
| `VALIDATION_ERROR` | 422 | Missing/invalid payload for the target status; `todo` without criteria; bad `blockedBy` |
| `VERSION_CONFLICT` | 409 | `expectedVersion` mismatch |
| `TASK_ALREADY_CLAIMED` | 409 | An agent writing a task someone else holds a live claim on |
| `DEPENDENCY_CYCLE` | 409 | A `blockedBy` entry would close a loop |
| `ACTOR_NOT_PERMITTED` | 403 | An agent moving a task to `done` without `AGENTS_MAY_COMPLETE` |
| `TASK_NOT_FOUND` | 404 | No such task |

## Related

- [Attention_Queue.md](./Attention_Queue.md) — the six attention kinds, `needsTriage`, `concerns`, follow-ups
- [Task_Workflow_API.md](./Task_Workflow_API.md) — every endpoint and the cross-cutting rules
- [Actors.md](./Actors.md) — who counts as an agent
- [../pages/Tasks_Map.md](../pages/Tasks_Map.md), [../pages/Inbox.md](../pages/Inbox.md)
