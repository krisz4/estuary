---
type: Feature
title: Agent integration (MCP server + Claude Code plugin)
description: How coding agents drive the task manager — the stdio MCP server in apps/mcp, its tools, the task-workflow skill, and setup for this repo, other repos, and self-hosted servers.
resource: apps/mcp/src/tools.ts
tags: [agents, mcp, claude-code, plugin, workflow]
status: canonical
---
# Agent integration

Coding agents create, claim, work, and hand off tasks through an MCP server. It is a **thin client over the REST API** — it never opens the database — so the API stays the one place the rules live (claims, versions, what a transition requires, agents never completing a task). Anything an agent can do through MCP, a script can do with `curl` against [Task_Workflow_API.md](./Task_Workflow_API.md).

## Overview

| Concern | Location |
| ------- | -------- |
| MCP server (stdio) | `apps/mcp` — `src/tools.ts` (tool surface), `src/api-client.ts` (HTTP), `src/format.ts` (result text), `src/config.ts` (env) |
| Project registration for this repo | `.mcp.json` at the repo root |
| npm package | `estuary-mcp`, built from `apps/mcp` by `scripts/build.js` (esbuild) — `npx -y estuary-mcp` |
| Claude Code plugin for other repos | `integrations/claude-code/` (marketplace: `.claude-plugin/marketplace.json` at the repo root) |
| Agent operating manual | `integrations/claude-code/skills/task-workflow/SKILL.md`, symlinked to `.claude/skills/task-workflow` |
| SessionStart reminder | `integrations/claude-code/scripts/session-start.mjs` |
| SessionEnd auto-release | `integrations/claude-code/scripts/session-end.mjs`, shared identity helper `scripts/identity.mjs` |
| Env vars | [../engineering/ENVIRONMENT_VARIABLES.md § apps/mcp](../engineering/ENVIRONMENT_VARIABLES.md) |

## Architecture

```
Claude Code ──stdio (JSON-RPC)──► apps/mcp ──HTTP /api/v1 + X-Actor [+ Bearer]──► apps/api ──Prisma──► SQLite
     ▲                                                                                  │
     ├── SessionStart hook (plugin) ── GET /tasks?status=in_progress, GET /tasks/stats ─┤
     └── SessionEnd hook (plugin) ───── POST /tasks/:id/release for this session's own ──┘
                                        still-claimed, still-in_progress tasks
```

- **Inputs are the contract schemas.** Tool input schemas are composed from `@estuary/contracts` (`createTaskInputSchema`, `transitionInputSchema`, `decisionRequestSchema`, …), so the model sees the API's own bounds and the SDK rejects a bad call before any request. The API still validates everything.
- **Every request** carries `X-Actor: $TASKS_ACTOR` (or the derived per-checkout actor, below) and, when set, `Authorization: Bearer $TASKS_API_TOKEN`.
- **Read results** are text: a summary line (`TASK-000042 [in_progress] Title · high · project estuary · labels web · claimed by agent:x until … · v7`), the `statusNote`, the open decision and any answered ones, parent/subtasks/dependencies/dependents (with their project when it differs), the live state of GitHub links, then the JSON. `task_get` includes the 10 most recent comments by default (`commentLimit`, 0–200, and a line saying how many older ones were left out). `task_list` is compact by default — one line per task (reference, status, title, priority, project, labels, parent, subtask count, open dependencies, claim holder, version, updated date, a marker for `needsTriage`, and `concerns` when set) plus a 160-character description snippet — and appends the page as JSON only with `verbose: true` (Claude Code caps MCP output at 25k tokens by default).
- **Write results are compact one-line confirmations** — e.g. `TASK-000042 → needs_qa (v8)`, or `task_comment`'s `Comment #118 (progress) added to task 42.` — rather than echoing the full task or comment JSON back: the caller already knows what it sent, and a write tool's job is to confirm the state landed, not to resend the payload at the model's expense.
- **Errors** come back as `isError` results with the API's `code`, `message`, `details`, `requestId`, and a one-line hint for the codes an agent can act on. An unreachable API yields "Task manager API not reachable at <url> … Is it running (`pnpm dev:api`)?".
- **Server instructions** (sent at MCP initialize, shown to the model while connected) carry the status list, the work loop, and the hard rules. The skill carries the long form.

## Tools

| Tool | API call | Use |
| ---- | -------- | --- |
| `task_list` | `GET /tasks` | Search/filter (`q` terms AND; `label`, `parentIsNull`, `dependsOn`, `dependencyOf`, …). `attention: true` answers "what needs me?" in one call — see [Attention_Queue.md](./Attention_Queue.md) — instead of naming the three human statuses by hand |
| `task_get` | `GET /tasks/:id` (+ `GET /tasks/:id/github`) | Full task incl. recent comments, decisions, dependencies, GitHub link state; accepts `42` or `"TASK-000042"` |
| `task_create` | `POST /tasks` (+ `POST /tasks/:id/transition`) | File a task; optional `transition` applied after (see below) |
| `task_update` | `PATCH /tasks/:id` | Edit fields (never status) |
| `task_transition` | `POST /tasks/:id/transition` | Any status, with the payload it requires |
| `task_next` | `POST /tasks/next` | Claim the best available task in the project |
| `task_claim` | `POST /tasks/:id/claim` | Claim a named task |
| `task_heartbeat` | `POST /tasks/:id/heartbeat` | Extend the lease |
| `task_release` | `POST /tasks/:id/release` | Give a task up → `todo`. `followUps?` files the same shape as `task_submit_for_qa`'s — see [Attention_Queue.md](./Attention_Queue.md) |
| `task_comment` | `POST /tasks/:id/comments` | `kind`: `note`, `progress`, `qa_feedback` |
| `task_submit_for_qa` | transition → `needs_qa` | Finish work (agents cannot mark done). `concerns?` (what a reviewer must not miss — omit for a routine hand-off) and `followUps?` (work found but not done, filed as subtasks) — see [Attention_Queue.md](./Attention_Queue.md) |
| `task_request_decision` | transition → `needs_user_decision` | Ask a human to choose |
| `task_request_action` | transition → `needs_user_action` | Ask a human to do something |
| `task_block` | transition → `blocked` | Waiting on tasks (`blockedBy`) or an outside event |
| `task_add_dependency` / `task_remove_dependency` | `POST` / `DELETE /tasks/:id/dependencies[/:dependsOnId]` | Ordering between tasks |
| `task_answer_decision` | `POST /tasks/:id/decision/answer` | Record a human's answer given in chat |
| `task_events` | `GET /events` | Change feed from a cursor; all projects unless narrowed by `taskId`, `project`, `actor`, `type` |
| `task_import_github_issue` | `POST /integrations/github/import` | Turn a GitHub issue (URL, `owner/repo#n`, or `#n` for the origin repo) into a task; needs the GitHub integration |
| `task_stats` | `GET /tasks/stats` | Counts per status + `needsAttention` |

The four hand-off tools are deliberately redundant with `task_transition`: agents choose tools by name, and `task_submit_for_qa` makes the right ending obvious where "transition to needs_qa" does not.

### Behaviour the tools add on top of the API

- **Default project.** `task_create` and `task_next` use the first valid slug of: `TASKS_DEFAULT_PROJECT`; the repository name of `git remote get-url origin` (`git@github.com:owner/repo.git`, `https://…/repo(.git)`, `ssh://…`); the main checkout's directory name (parent of `git rev-parse --git-common-dir`, the same from every worktree); the project directory's name. Git runs in `CLAUDE_PROJECT_DIR` with a short timeout, and any failure (no git, no remote) falls through — so a worktree at `.claude/worktrees/agent-a1b2` still files under `estuary`. `task_next` accepts `allProjects: true` to look everywhere, and `label` to stay in one monorepo workspace. `task_list`, `task_stats`, and `task_events` never apply it — a read must not silently hide work.
- **Derived actor.** With `TASKS_ACTOR` empty, the actor is `agent:claude-code@<project>` in a main checkout and `agent:claude-code@<project>/<worktree>` in a linked worktree (worktree = the checkout's directory name), cut to 64 characters with a hash suffix if longer. It is stable across restarts of the same checkout, so a resumed session still owns its claims, and parallel sessions in different worktrees cannot take over each other's. **Two sessions in the same checkout share it** — set `TASKS_ACTOR` per session if you run that way. The plugin's SessionStart hook derives the same actor (a dependency-free twin of `apps/mcp/src/config.ts`) to list the tasks you still hold.
- **Idempotency key, always.** `task_create` derives one from project + title (`mcp:<project>:<title-slug>`) when the caller sends none, so a retried call, a resumed session, or a second agent noticing the same follow-up gets the existing task back (200) instead of a duplicate — while that task is open. Once it is `done` or `deferred` the API retires the key and creates a fresh task (201). Filing a second open task under an existing title needs an explicit key.
- **GitHub, best-effort.** When a task has GitHub links, `task_get` asks `GET /tasks/:id/github` and prints one line per link (`PR owner/repo#12 merged · checks success`). A failure prints nothing; `INTEGRATION_NOT_CONFIGURED` is remembered for the life of the server so a disabled integration costs one request, once.
- **Create + transition is not atomic.** `task_create` with `transition` makes two requests, the second guarded by `expectedVersion` = the created version. If it fails, the error says the task **was created** and to use `task_transition` — never to create again. On an idempotent replay the transition runs only if the task is still in its creation status: a task that has moved on (claimed, handed to QA) is not dragged back.

## The work loop

Agents follow the `task-workflow` skill; in short:

1. `task_next` (or `task_claim` a named task).
2. Read acceptance criteria, `statusNote`, comments, answered decisions.
3. `task_heartbeat` at least every 10 minutes of work (default lease 30 min, `CLAIM_LEASE_MINUTES`).
4. `task_comment kind=progress` at milestones.
5. End with exactly one of `task_submit_for_qa`, `task_request_decision`, `task_request_action`, `task_block`, `task_release`. Never idle while claimed, never `done`.

The skill also says: put recommendations and left-out work in the hand-off's `followUps` (`todo` when you can state acceptance criteria, else `needs_refinement` with `missing`) rather than a new backlog task or a chat message — it is filed for you and cannot be forgotten. Use `concerns` only when something needs a close look, not on every hand-off. "What needs me?" is `task_list attention: true`, not a remembered list of statuses.

## Setup — this repository

```bash
pnpm install
pnpm --filter estuary-mcp build    # → apps/mcp/dist/index.js (pnpm build also builds it)
pnpm dev:api                         # API on :4000
claude                               # approve the "tasks" server from .mcp.json when prompted
```

`.mcp.json` registers `tasks` as `node ${CLAUDE_PROJECT_DIR:-.}/apps/mcp/dist/index.js`, with `TASKS_API_URL`, `TASKS_ACTOR`, and `TASKS_API_TOKEN` passed through from your shell (defaults: local API, the derived per-checkout actor, no token). The skill is available as `.claude/skills/task-workflow` (a symlink into the plugin, so there is one copy). `pnpm --filter estuary-mcp dev` rebuilds on change; reconnect with `/mcp`.

The SessionStart hook is part of the plugin only. Installing the plugin as well as using `.mcp.json` gives you the tools twice (`mcp__tasks__*` and `mcp__plugin_estuary_tasks__*`) — pick one per repo, e.g. decline the project server or list it in `disabledMcpjsonServers`.

## Setup — other repositories

The server is published to npm as [`estuary-mcp`](https://www.npmjs.com/package/estuary-mcp) (unscoped: `@estuary` on npm belongs to someone else), so other repos need no checkout of this one — only Node 20+ with `npx`, and an Estuary API they can reach (**it does not have to run on the same machine**). `apps/mcp` builds it with esbuild into one `dist/index.js` that bundles `packages/contracts`, so the package's only runtime dependencies are the MCP SDK and zod. Pick one:

**A. The plugin (recommended): tools + skill + SessionStart hook.**

```bash
claude plugin marketplace add krisz4/estuary
claude plugin install estuary@estuary \
  --config api_url=http://localhost:4000/api/v1   # actor: leave unset to derive it per checkout
```

The marketplace manifest is `.claude-plugin/marketplace.json` at the **repository root**, listing the plugin at `./integrations/claude-code`. It has to be there: `claude plugin marketplace add owner/repo` reads only `.claude-plugin/marketplace.json` at the root, has no option to point elsewhere, and a `path` set by hand in `extraKnownMarketplaces` finds a nested manifest but still resolves the plugin's relative `source` from the repository root. To clone only what the plugin needs, add `--sparse .claude-plugin integrations`.

Installed this way, Claude Code copies the plugin into its cache, so the launcher (`scripts/start-mcp.mjs`) finds no checkout next to it and runs `npx -y estuary-mcp@<version>`, where `<version>` is the plugin's own `version` from `.claude-plugin/plugin.json`. Plugin and package are released in lockstep, so an installed plugin always runs the server version it shipped with, and `claude plugin update estuary` moves both. The first start downloads the package into npm's cache; later starts reuse it. Change options later with `/plugin configure estuary`; the token (`api_token`) is marked sensitive and goes to the OS credential store.

**Contributors: the plugin from a checkout.** Add the checkout itself as the marketplace:

```bash
pnpm install && pnpm --filter estuary-mcp build
claude plugin marketplace add /path/to/estuary
claude plugin install estuary@estuary
```

A marketplace added from a local directory is loaded **in place** rather than copied, so the launcher finds `../../apps/mcp/dist/index.js` and runs your build: a `git pull` + rebuild (or `pnpm --filter estuary-mcp dev`) takes effect on the next session. If that checkout is not built, the launcher says so on stderr and falls back to the published package. To run a build from a plugin installed any other way, set `server_path` to `/path/to/estuary/apps/mcp/dist/index.js`; an explicit `server_path` that does not exist is an error rather than a silent fallback. For a one-off session: `claude --plugin-dir /path/to/estuary/integrations/claude-code`.

**B. MCP server only, available in every repo (no skill, no hook):**

```bash
claude mcp add tasks --scope user \
  -e TASKS_API_URL=http://localhost:4000/api/v1 \
  -- npx -y estuary-mcp
```

The server name goes first because `-e` takes several values and would otherwise swallow it; `--` separates Claude Code's options from the server command. Use `--scope project` to write a shareable `.mcp.json` into one repo instead. Pin a version (`npx -y estuary-mcp@0.1.0`) if you want upgrades to be deliberate. From a checkout, `-- node /path/to/estuary/apps/mcp/dist/index.js` runs your build instead. Copy [`integrations/claude-code/skills/task-workflow`](https://github.com/krisz4/estuary/tree/main/integrations/claude-code/skills/task-workflow) into that repo's `.claude/skills/` (or `~/.claude/skills/`) if you want the skill without the plugin.

Either way, tasks are filed under the repo's name (from `origin`, else the main checkout's directory) as the project unless you set `TASKS_DEFAULT_PROJECT` (option B) or the agent passes `project`, and the actor is derived per checkout unless you set `actor` / `TASKS_ACTOR`.

## Self-hosted server

Run the API where agents can reach it (see [../operations/DOCKER.md](../operations/DOCKER.md)) and set `API_TOKEN` on it — without it, anyone who can reach the port can read and write every task. Then point each agent at it:

| Setting | Plugin option | `claude mcp add` / `.mcp.json` env |
| ------- | ------------- | ---------------------------------- |
| API URL | `api_url=https://tasks.example.com/api/v1` | `TASKS_API_URL=https://tasks.example.com/api/v1` |
| Token | `api_token=<API_TOKEN value>` | `TASKS_API_TOKEN=<API_TOKEN value>` |
| Identity | `actor=agent:<machine-or-agent-name>` | `TASKS_ACTOR=agent:<machine-or-agent-name>` |

Give each agent (or machine) a distinct actor name: claims, the "your claimed tasks" reminder, and the audit trail all key off it. The URL must include `/api/v1`; in the Docker stack the web origin works too, because nginx proxies `/api/` to the API.

## SessionStart hook

On `startup`, `resume`, `clear`, and `compact`, the plugin runs `scripts/session-start.mjs` (no dependencies, 2.5 s request timeout). It prints, as context for the model: the API and actor, the project name to use for this repo, the `in_progress` tasks whose claim belongs to this actor (with lease expiry and "resume or release" instructions), and the `needsAttention` count. If the API is unreachable or rejects the request, it prints nothing and exits 0 — it never gets in the way of a session.

The list has no `claimedBy` filter, so the hook fetches up to 100 `in_progress` tasks and filters by `claim.actor` itself.

## SessionEnd hook

On session end for every reason **except** `clear`, the plugin runs `scripts/session-end.mjs`: it reads the tasks this session's own `task_*` tool calls touched out of the transcript, keeps the ones still `in_progress` and claimed by this checkout's actor, and `POST /tasks/:id/release`s each back to `todo` with reason `"Released automatically: the Claude Code session ended before handing this off. Read the progress comments and continue."`. This is what keeps unfinished work from being stranded `in_progress` until its lease expires — a session that crashes or is closed mid-task now hands it back immediately instead of making the next agent (or a human) wait out `CLAIM_LEASE_MINUTES`. Like the SessionStart hook, any error (API unreachable, malformed transcript) exits 0 silently — it never blocks a session ending. Actor/project derivation is shared with `session-start.mjs` via `scripts/identity.mjs`, so both hooks agree on which actor's claims are "this session's own". See [Attention_Queue.md](./Attention_Queue.md).

## Troubleshooting

| Symptom | Cause / fix |
| ------- | ----------- |
| `/mcp` shows `tasks` failed; log says `Invalid task manager MCP configuration` | A `TASKS_*` value is malformed — typically `TASKS_ACTOR` without `agent:`/`human:`, or a URL without `http(s)://`. The message names the variable |
| Log says `MCP server not found at …` (plugin) | `server_path` points at a file that does not exist. Build it (`pnpm --filter estuary-mcp build`) or clear `server_path` to use the published package |
| Plugin's `tasks` server fails; log shows an `npx -y estuary-mcp@…` error | The package could not be downloaded or started: no network access to the npm registry, a project `.npmrc` pointing at a registry without it, or no `npx` on `PATH`. Fix the access, or set `server_path` to a local build |
| Every tool returns "Task manager API not reachable at …" | The API is not running (`pnpm dev:api`) or `TASKS_API_URL` points elsewhere. `curl <url-without-/api/v1>/health` to check |
| "… returned 200 with a non-JSON body" / "no error envelope" | `TASKS_API_URL` points at the web app or a proxy page, not the API; it must end in `/api/v1` |
| `UNAUTHORIZED` on every call | The server has `API_TOKEN` set and `TASKS_API_TOKEN` is missing or different |
| `ACTOR_NOT_PERMITTED` on a transition | An agent tried `done`. Use `task_submit_for_qa`; a human marks it done (or the server sets `AGENTS_MAY_COMPLETE=true`) |
| `TASK_ALREADY_CLAIMED` | Someone else holds a live lease. Pick another task; a human can release it from the UI |
| `task_next` says nothing to claim | No `todo` with finished dependencies in the default project. `allProjects: true`, or refine backlog tasks into `todo` |
| Tools listed twice | Both `.mcp.json` and the plugin are active in this repo — disable one |
| Project `.mcp.json` server never starts | Claude Code asks for approval of project servers once; `claude mcp reset-project-choices` to be asked again |

## Related

- [Attention_Queue.md](./Attention_Queue.md) — `attention`, `concerns`, `followUps`, the SessionEnd hook
- [Task_Workflow_API.md](./Task_Workflow_API.md) — the REST surface this wraps
- [Task_Status_Lifecycle.md](./Task_Status_Lifecycle.md) — statuses and what each requires
- [Actors.md](./Actors.md) — the `X-Actor` model
- [../engineering/ENVIRONMENT_VARIABLES.md](../engineering/ENVIRONMENT_VARIABLES.md) — `TASKS_*`
