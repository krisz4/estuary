---
type: Feature
title: Attention queue
description: Everything that is in front of a person and why — the six attention kinds, needsTriage, concerns, and follow-ups.
resource: packages/contracts/src/task.ts
tags: [tasks, attention, inbox, needsTriage, concerns, follow-ups, agents]
status: canonical
---
# Attention queue

## Overview

Why this exists: an agent works unattended between hand-offs, and three things can go wrong with that if nothing watches for them — it leaves something a person never sees (a suggestion filed in passing, a task blocked for a reason that will never resolve itself), it hands back routine work that then costs a person a full read anyway, or it quietly drops a session mid-task. The attention queue is the one place all of that surfaces, and it costs an agent no extra calls: everything in it is a side effect of work the agent was already doing (filing a task, finishing one, stopping a session), never a separate "flag this for review" step.

| Concern | Location |
| ------- | -------- |
| The six kinds, classifier | `ATTENTION_KINDS`, `attentionKindOf` in `packages/contracts/src/task.ts` |
| `GET /tasks?attention=true` filter | `attentionWhere` in `apps/api/src/services/task-query.ts` (kept in lockstep with `attentionKindOf` — `attention.test.ts` checks every row both ways) |
| `needsTriage` lifecycle | `apps/api/src/services/task.service.ts` (`insertTask`, `updateTask`), `task-workflow.service.ts` (`clearsTriage`) |
| `concerns` | `transitionInputSchema`'s `needs_qa` branch; cleared on any transition out of `needs_qa` |
| `followUps` | `followUpInputSchema` in `packages/contracts/src/task-workflow.ts`; filed by `fileFollowUps()` in `task-workflow.service.ts` |
| `GET /tasks/stats` `needsAttention` | `getTaskStats()` in `task.service.ts` — counts `attentionWhere`, not just the three human statuses |
| Web inbox | [../pages/Inbox.md](../pages/Inbox.md), [../pages/Tasks_Map.md](../pages/Tasks_Map.md) "Needs you" |
| MCP / SessionEnd hook | [Agent_Integration.md](./Agent_Integration.md) |

## The six kinds

`attentionKindOf(task)` classifies a task; `attention=true` on `GET /tasks` (and `GET /floor`, which shares the same filter fields) selects exactly the tasks it classifies non-null. In the order the inbox groups them:

| Kind | Status | Extra condition | Why it needs a person |
| ---- | ------ | ---------------- | ---------------------- |
| `decide` | `needs_user_decision` | — | An agent asked a question with options and cannot proceed |
| `act` | `needs_user_action` | — | A human must do something manual |
| `review` | `needs_qa` | — | Work is finished and wants verification |
| `refine` | `needs_refinement` | — | Nobody has said what "done" looks like yet |
| `suggested` | `backlog` or `todo` | `needsTriage` | An agent filed or left this and no person has looked at it |
| `blocked` | `blocked` | no unfinished dependency | Blocked for an outside reason only — nothing will ever auto-unblock it, so it would wait forever unseen |

A `blocked` task with an open dependency is **not** in the queue — the system's own auto-unblock will move it along once that dependency finishes, so a person looking at it would have nothing to do. An `in_progress` or `deferred` task carrying `needsTriage` is also not in the queue: being claimed, or being deliberately parked, already answers "has anyone looked at this".

`needs_user_decision` / `needs_user_action` / `needs_qa` are also `HUMAN_ATTENTION_STATUSES` — the three statuses where an agent explicitly stopped and asked. The other three kinds exist because work can also sit unseen without anyone asking: `refine`, `suggested`, and outside-`blocked` are all discovered rather than declared.

`GET /tasks/stats`'s `needsAttention` counts this whole set now, not just the three human statuses — so the header badge and the SessionStart hook's count moved with it; a server upgrade changes what that number means without changing its shape.

## `needsTriage`

A new `Task` column (`Boolean`, default `false`), carried on `TaskSummary`. It answers one question: **has a person looked at this agent-filed or agent-left task yet?**

| Event | Effect |
| ----- | ------ |
| `agent:` actor creates a task (`task_create`, or a follow-up filed by a hand-off) | Set `true` |
| `human:` actor creates a task | `false` (never set) |
| Any human write — `PATCH`, a transition, a `release` | Cleared |
| Any claim — `claim`, transition to `in_progress`, `POST /tasks/next` | Cleared |
| Transition to `done` or `deferred`, by anyone | Cleared |
| Answering a decision | Cleared |
| An agent editing or transitioning its own suggestion otherwise (e.g. refining it into `todo`) | **Left set** — the task is still unreviewed by a person, it has just moved |

The claim/close rule is deliberate: a claim means *someone* is dealing with it, agent or human, so it is no longer sitting ignored even though no person has specifically approved it. Only a human write, or the task reaching a closed state, counts as "seen and decided".

**Backfill.** A second migration, `20261002073859_backfill_needs_triage`, sets `needsTriage = true` once over rows that predate the column: `createdBy LIKE 'agent:%'`, never started (`startedAt IS NULL`), status `backlog` or `todo`, and no `TaskEvent` recorded by a `human:` actor — the same rule the server applies to a live create, run once so agent-filed suggestions from before this feature shipped also surface in the inbox instead of silently staying invisible forever.

`PATCH /tasks/:taskId` accepts `needsTriage: boolean` explicitly. `{ needsTriage: false }` alone — no other field — is the inbox's **Accept**: it bumps `version` and records a `task.updated` event with `fields: ["needsTriage"]`, same as any other PATCH. A human PATCH of unrelated fields that happens to clear an agent's `needsTriage` lists `"needsTriage"` in that same event's `fields` too — there is only one code path for "what changed", not a special case for the explicit accept.

## `concerns`

A new `Task` column (`String?`, max 2000), optional on the `needs_qa` transition (`task_submit_for_qa`). What a reviewer must not miss — a deviation from the acceptance criteria, a risk, a shortcut taken under time pressure. Omitted = a routine hand-off, which is what lets the inbox offer routine QA items for one-click batch approval instead of asking for a full read. Cleared on any transition **out of** `needs_qa`, to whatever status, so it never persists as a stale warning on a task that moved on.

## Follow-ups

Work an agent found but did not do — a recommendation, a part left out, a bug next door — filed on the hand-off itself (`followUpInputSchema`, max 10 per call) rather than in a comment or a second tool call, so it costs nothing extra and cannot be forgotten between "I'm done" and the session ending. Each is `{ title, description, acceptanceCriteria?, missing?, priority? }` — the same title/description bounds as a regular task, `priority` defaulting to `medium`; `missing` only matters when `acceptanceCriteria` is omitted, and becomes the filed subtask's `statusNote`. Accepted on:

- the `needs_qa` transition (`task_submit_for_qa`)
- `POST /tasks/:id/release` (`task_release`)

Each is filed, in the same transaction as the hand-off, as a **subtask** of the task being handed off: same project, same labels, `needsTriage: true` (an agent filed it). Status depends on whether it has acceptance criteria:

| Has `acceptanceCriteria`? | Status | `statusNote` |
| ------------------------- | ------ | ------------ |
| Yes | `todo` | — |
| No | `needs_refinement` | `missing`, or "Filed as a follow-up without acceptance criteria — say what done looks like." |

A follow-up whose title (case-insensitive) is already an **open** subtask of that task is skipped — retried hand-offs (a timed-out request, a retried release) do not file duplicates. The filed task's `task.created` event carries `followUpOf: <parent id>`, so the activity feed and anything reading events can tell a follow-up from an ordinary new task.

## The SessionEnd hook

`integrations/claude-code/scripts/session-end.mjs` closes the last gap: a session that ends (crashes, times out, or the user just closes it) without a hand-off leaves its claimed task stuck `in_progress` with nobody heartbeating it — eventually the lease expires and `task_next` recovers it, but until then it is invisible to a person and to other agents. On any session end except `clear`, the hook finds the tasks this session worked (task ids seen in its own `task_*` tool calls in the transcript) that are still `in_progress` and claimed by this checkout's actor, and releases each one back to `todo` with reason `"Released automatically: the Claude Code session ended before handing this off. Read the progress comments and continue."`. Never blocks or fails the session — any error exits 0 silently. See [Agent_Integration.md](./Agent_Integration.md) for the hook's place in the plugin and `scripts/identity.mjs`, which it shares with `session-start.mjs` for actor/project derivation.

## Related pages

- [../pages/Inbox.md](../pages/Inbox.md) — the six groups, their actions, the `attention=true` query
- [../pages/Tasks_Map.md](../pages/Tasks_Map.md) — "Needs you" section, same grouping
- [../pages/Task_Detail.md](../pages/Task_Detail.md) — `concerns` near the status note, the "Suggested by an agent" line
- [Task_Status_Lifecycle.md](./Task_Status_Lifecycle.md) — `concerns` / `followUps` on the `needs_qa` payload
- [Task_Workflow_API.md](./Task_Workflow_API.md) — `release`'s `followUps`, `stats.needsAttention`
- [Agent_Integration.md](./Agent_Integration.md) — MCP tool params, the SessionEnd hook
