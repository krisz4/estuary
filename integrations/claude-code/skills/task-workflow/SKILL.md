---
name: task-workflow
description: Operating manual for the AI task manager's MCP tools (task_next, task_claim, task_heartbeat, task_submit_for_qa, task_request_decision, task_create, …). Use when picking up, working, or handing off a task; when filing tasks for work discovered mid-change; when deciding which status a piece of work belongs in; or when a human asks what needs their attention.
when_to_use: 'Triggers: "work the next task", "pick up TASK-42", "file a follow-up", "is there a task for X?", "import this GitHub issue", "what needs me?", "what''s blocked?", any task_* tool call, or finishing work that came from a task.'
---

# Task workflow

The task manager is the shared board between you, other agents, and the humans who review your work. Its rules are enforced by the API; this skill is how to work *with* them instead of bouncing off them. Tools come from the `tasks` MCP server.

**Who you are.** Unless `TASKS_ACTOR` is set, your actor is derived per checkout: `agent:claude-code@<project>`, or `agent:claude-code@<project>/<worktree>` in a git worktree — so sessions in different worktrees never take over each other's claims, and a restarted session in the same checkout still owns its own. The project is the `origin` repo's name (the same from every worktree). The SessionStart context names both. Two sessions in the *same* checkout share an actor.

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

1. **Get a task.** `task_next` claims the best available `todo` in this repository's project (or an abandoned `in_progress` whose lease expired — read its comments and continue). Working in one workspace of a monorepo? Pass `label: ["web"]`. If a human named a task, `task_claim` it instead. `TASK_ALREADY_CLAIMED` means someone else holds it: leave it alone.
2. **Read before you touch code.** Acceptance criteria, `statusNote`, comments, `decisions` (an answered decision's choice and note are in `decisions[0]` and in `statusNote` — that is your instruction), dependencies.
3. **Keep the lease alive.** `task_heartbeat` at least every 10 minutes of work and before anything long (test suites, builds). A lapsed lease lets another agent take the task over.
4. **Log milestones.** `task_comment` with `kind: "progress"` when you choose an approach, finish a meaningful part, or hit a surprise — enough for another agent to resume from.
5. **Finish with exactly one hand-off** — each of these releases your claim:
   - `task_submit_for_qa` — acceptance criteria met. `summary`: what changed, how to verify (commands, URLs, screens). `links`: PR / branch / commit. `concerns`: **only** when a reviewer must look at something specific (a deviation, a risk, a shortcut, a check you could not run) — omit it for routine work, which the human then approves in one click. `followUps`: see below. Put the reference (`TASK-000042`) in the PR title or branch name: with the GitHub webhook connected, that links the PR to the task by itself.
   - `task_request_decision` — you need a human's choice. One clear question, 2–6 distinct options each with its consequences, your `recommendedOption`, and `context` (what you found). After it is answered the task returns to `todo`; whoever picks it up next reads the answer from `decisions[0]` / `statusNote`.
   - `task_request_action` — a human must act. Instructions precise enough to follow without asking you anything: what, where, how to tell it worked.
   - `task_block` — waiting on other tasks (`blockedBy` ids; it returns to `todo` by itself when they are done) or an outside event (`reason`).
   - `task_release` — you are stopping without finishing (session ending, out of your depth). The `reason` says what you did and what is left; separable leftovers go in `followUps`. (If a session ends with a task still claimed, the plugin releases it back to `todo` for you — but a hand-off with a reason is always better.)

**Nothing you found may stay in chat.** Every recommendation you make, part you left out, or problem you noticed goes in `followUps` on the hand-off — no extra calls: each becomes a subtask a human sees, `todo` if you give `acceptanceCriteria`, otherwise `needs_refinement` with `missing` (what a person must decide or supply). Keep each one short; skip it if it is not worth a person's attention.

**Never leave a task claimed and idle. Never mark a task done.** Pass `expectedVersion` (the `version` from your last read) on writes; on `VERSION_CONFLICT`, `task_get`, reconcile, retry.

## Finding related work

Search before you file, and before you start, so you neither duplicate a task nor miss one it touches.

- `task_list q=…` — every whitespace-separated term must match (AND); double-quote a phrase (`"login redirect" safari`). Searches title, description, acceptance criteria, status note, links, and comments.
- `label: ["web"]` — one workspace of a monorepo; `project` is the repository.
- `dependsOn: 42` — who waits on 42. `dependencyOf: 42` — what 42 waits on. `parentId: 42` — its subtasks. `parentIsNull: true` — top-level tasks and epics only.
- Rows are one line each; `task_get` for the full text. `task_get` shows the 10 most recent comments — pass `commentLimit` for more.

## Filing tasks

- **Follow-ups found mid-work** (a bug next door, missing tests, a refactor you resisted): collect them and attach them as `followUps` to your hand-off rather than widening the task you hold. `task_create` only when it must exist before you hand off (another agent should start it now) — search first, then file it as `todo` with criteria or `needs_refinement`; `backlog` is for ideas you are *not* recommending. Tasks you file are marked untriaged until a person looks at them.
- **Labels**: in a monorepo, label every task with its workspace (`labels: ["web"]`, `["api", "contracts"]`); add a kind (`bug`, `flaky-test`) when useful. `task_update` `labels` replaces the whole set.
- **From a GitHub issue**: `task_import_github_issue` (URL, `owner/repo#123`, or `#123` for this repo) instead of retyping it — importing twice returns the same open task.
- **Subtasks**: `parentId` = the task being split. Give each its own acceptance criteria if it goes straight to `todo`.
- **Ordering**: if B cannot start before A is done, `task_add_dependency` (B depends on A). `task_next` skips B until A is `done`; `deferred` does not count as done.
- **Project**: the repository's name as a slug (`estuary`, `web-app`). The server defaults to it (from `origin`, so worktrees agree), and the SessionStart context names it — pass `project` explicitly only for another repository.
- **Idempotency**: a key is always sent. Omitted, it is derived from project + title, so a retried or re-run create returns the existing task — while that task is still open. Once it is `done` or `deferred` the same call files a fresh task. To file a second *open* task under an existing title, pass your own `idempotencyKey`, e.g. `claude-code:<project>:<short-slug>-<date>`.
- `task_create` with `transition` creates, then transitions — two requests. If the transition fails the task still exists: fix it with `task_transition`, do not create again.

## When a human asks in chat

- **"What needs me?"** — `task_list` with `attention: true` (all projects unless they name one): decisions, actions, QA, refinement, untriaged suggestions, and tasks blocked on an outside reason. For each: the question and options, the instructions, the QA summary and concerns, or what is missing — then offer to record their answers.
- **They answer a decision in chat** — `task_answer_decision` with their `choice` (an option label) and/or `note`. Only ever with an answer the human gave you in this conversation: never answer a decision yourself, including your own — the server records you as `answeredBy` but cannot tell the difference.
- **They reject QA** — `task_comment` with `kind: "qa_feedback"` saying why, then `task_transition` to `todo` (or wherever they say).
- **"What changed?"** — `task_events` from a cursor (all projects; narrow with `project`, `actor`, `type`); `task_stats` for counts.

## Error codes you can act on

| Code | Do this |
| ---- | ------- |
| `VERSION_CONFLICT` | Re-read with `task_get`, reconcile, retry with the new `version`. |
| `TASK_ALREADY_CLAIMED` | Someone else holds it. Pick another task; comments are still allowed. |
| `NOT_CLAIM_HOLDER` | Your lease lapsed or a human took the task back. Re-read before doing anything. |
| `VALIDATION_ERROR` | Fix the fields named in `details`. |
| `ACTOR_NOT_PERMITTED` | You tried to mark it done — use `task_submit_for_qa`. |
| `UNAUTHORIZED` | `TASKS_API_TOKEN` does not match the server's `API_TOKEN`; tell the human. |
| `INTEGRATION_NOT_CONFIGURED` | The server has no GitHub integration: `task_create` with the issue URL in `links`. |
| "API not reachable" | The task manager is not running or `TASKS_API_URL` is wrong; tell the human, do not retry in a loop. |
