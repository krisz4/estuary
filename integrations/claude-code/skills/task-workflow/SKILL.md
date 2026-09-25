---
name: task-workflow
description: Operating manual for the AI task manager's MCP tools (task_next, task_claim, task_heartbeat, task_submit_for_qa, task_request_decision, task_create, …). Use when picking up, working, or handing off a task; when filing tasks for work discovered mid-change; when deciding which status a piece of work belongs in; or when a human asks what needs their attention.
when_to_use: 'Triggers: "work the next task", "pick up TASK-42", "file a follow-up", "what needs me?", "what''s blocked?", any task_* tool call, or finishing work that came from a task.'
---

# Task workflow

The task manager is the shared board between you, other agents, and the humans who review your work. Its rules are enforced by the API; this skill is how to work *with* them instead of bouncing off them. Tools come from the `tasks` MCP server.

## Statuses — where work belongs

Pick the first row whose signal matches. New work defaults to **backlog**; **todo** only when you can write acceptance criteria.

| Status | Put work here when… | Required with it |
| ------ | ------------------- | ---------------- |
| `todo` | It is ready to start: scope is clear, and you can state how "done" will be checked. | `acceptanceCriteria` |
| `needs_refinement` | It is real but too vague to act on — no repro, conflicting requirements, unknown scope. | `reason`: what is missing |
| `blocked` | It cannot start or continue until other tasks finish, or an outside event happens (upstream release, external outage). | `blockedBy` task ids and/or `reason` |
| `needs_user_decision` | A human must choose between options (product/UX trade-off, architecture, scope change, anything risky, destructive, or costly). | question, 2–6 options, recommendation, context |
| `needs_user_action` | A human must *do* something you cannot: grant access, create a secret or account, approve externally, test on hardware. | exact `instructions` |
| `in_progress` | You (or another agent) are working it now. Reached by claiming, never by filing. | a live claim |
| `needs_qa` | The work is finished and meets the acceptance criteria; a human verifies. | `summary` (+ PR/branch links) |
| `done` | A human verified it. **Agents never set this** (`ACTOR_NOT_PERMITTED`). | — |
| `backlog` | Worth doing, not ready or not now — the default for new work. | — |
| `deferred` | No other status applies and it is deliberately parked (out of scope for now, superseded, won't fix yet). | `reason` — always |

## The work loop

1. **Get a task.** `task_next` claims the best available `todo` in this repository's project (or an abandoned `in_progress` whose lease expired — read its comments and continue). If a human named a task, `task_claim` it instead. `TASK_ALREADY_CLAIMED` means someone else holds it: leave it alone.
2. **Read before you touch code.** Acceptance criteria, `statusNote`, comments, `decisions` (an answered decision's choice and note are in `decisions[0]` and in `statusNote` — that is your instruction), dependencies.
3. **Keep the lease alive.** `task_heartbeat` at least every 10 minutes of work and before anything long (test suites, builds). A lapsed lease lets another agent take the task over.
4. **Log milestones.** `task_comment` with `kind: "progress"` when you choose an approach, finish a meaningful part, or hit a surprise — enough for another agent to resume from.
5. **Finish with exactly one hand-off** — each of these releases your claim:
   - `task_submit_for_qa` — acceptance criteria met. `summary`: what changed, how to verify (commands, URLs, screens), what was left out. `links`: PR / branch / commit.
   - `task_request_decision` — you need a human's choice. One clear question, 2–6 distinct options each with its consequences, your `recommendedOption`, and `context` (what you found). After it is answered the task returns to `todo`; whoever picks it up next reads the answer from `decisions[0]` / `statusNote`.
   - `task_request_action` — a human must act. Instructions precise enough to follow without asking you anything: what, where, how to tell it worked.
   - `task_block` — waiting on other tasks (`blockedBy` ids; it returns to `todo` by itself when they are done) or an outside event (`reason`).
   - `task_release` — you are stopping without finishing (session ending, out of your depth). The `reason` says what you did and what is left.

**Never leave a task claimed and idle. Never mark a task done.** Pass `expectedVersion` (the `version` from your last read) on writes; on `VERSION_CONFLICT`, `task_get`, reconcile, retry.

## Filing tasks

- **Follow-ups found mid-work** (a bug next door, missing tests, a refactor you resisted): `task_create` them in `backlog` rather than widening the task you hold. Mention the new reference in a progress comment.
- **Subtasks**: `parentId` = the task being split. Give each its own acceptance criteria if it goes straight to `todo`.
- **Ordering**: if B cannot start before A is done, `task_add_dependency` (B depends on A). `task_next` skips B until A is `done`; `deferred` does not count as done.
- **Project**: the repository's name as a slug (`helpdesk`, `web-app`). The server defaults to the current repository's directory name, and the SessionStart context names it — pass `project` explicitly only for another repository.
- **Idempotency**: a key is always sent. Omitted, it is derived from project + title, so a retried or re-run create returns the existing task instead of a duplicate. When you deliberately file a new task under a title that already exists, pass your own `idempotencyKey`, e.g. `claude-code:<project>:<short-slug>-<date>`.
- `task_create` with `transition` creates, then transitions — two requests. If the transition fails the task still exists: fix it with `task_transition`, do not create again.

## When a human asks in chat

- **"What needs me?"** — `task_list` with `status: ["needs_user_decision", "needs_user_action", "needs_qa"]` (all projects unless they name one). For each: the question and options, the instructions, or the QA summary — then offer to record their answers.
- **They answer a decision in chat** — `task_answer_decision` with their `choice` (an option label) and/or `note`. Only ever with an answer the human gave you in this conversation: never answer a decision yourself, including your own — the server records you as `answeredBy` but cannot tell the difference.
- **They reject QA** — `task_comment` with `kind: "qa_feedback"` saying why, then `task_transition` to `todo` (or wherever they say).
- **"What changed?"** — `task_events` from a cursor; `task_stats` for counts.

## Error codes you can act on

| Code | Do this |
| ---- | ------- |
| `VERSION_CONFLICT` | Re-read with `task_get`, reconcile, retry with the new `version`. |
| `TASK_ALREADY_CLAIMED` | Someone else holds it. Pick another task; comments are still allowed. |
| `NOT_CLAIM_HOLDER` | Your lease lapsed or a human took the task back. Re-read before doing anything. |
| `VALIDATION_ERROR` | Fix the fields named in `details`. |
| `ACTOR_NOT_PERMITTED` | You tried to mark it done — use `task_submit_for_qa`. |
| `UNAUTHORIZED` | `TASKS_API_TOKEN` does not match the server's `API_TOKEN`; tell the human. |
| "API not reachable" | The task manager is not running or `TASKS_API_URL` is wrong; tell the human, do not retry in a loop. |
