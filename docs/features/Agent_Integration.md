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
| Claude Code plugin for other repos | `integrations/claude-code/` (marketplace: `integrations/.claude-plugin/marketplace.json`) |
| Agent operating manual | `integrations/claude-code/skills/task-workflow/SKILL.md`, symlinked to `.claude/skills/task-workflow` |
| SessionStart reminder | `integrations/claude-code/scripts/session-start.mjs` |
| Env vars | [../engineering/ENVIRONMENT_VARIABLES.md § apps/mcp](../engineering/ENVIRONMENT_VARIABLES.md) |

## Architecture

```
Claude Code ──stdio (JSON-RPC)──► apps/mcp ──HTTP /api/v1 + X-Actor [+ Bearer]──► apps/api ──Prisma──► SQLite
     ▲                                                                                  │
     └── SessionStart hook (plugin) ── GET /tasks?status=in_progress, GET /tasks/stats ─┘
```

- **Inputs are the contract schemas.** Tool input schemas are composed from `@helpdesk/contracts` (`createTaskInputSchema`, `transitionInputSchema`, `decisionRequestSchema`, …), so the model sees the API's own bounds and the SDK rejects a bad call before any request. The API still validates everything.
- **Every request** carries `X-Actor: $TASKS_ACTOR` and, when set, `Authorization: Bearer $TASKS_API_TOKEN`.
- **Results** are text: a summary line (`TASK-000042 [in_progress] Title · high · project helpdesk · claimed by agent:x until … · v7`), the `statusNote`, the open decision and any answered ones, then the JSON. Lists truncate long descriptions (Claude Code caps MCP output at 25k tokens by default); `task_get` has the full text.
- **Errors** come back as `isError` results with the API's `code`, `message`, `details`, `requestId`, and a one-line hint for the codes an agent can act on. An unreachable API yields "Task manager API not reachable at <url> … Is it running (`pnpm dev:api`)?".
- **Server instructions** (sent at MCP initialize, shown to the model while connected) carry the status list, the work loop, and the hard rules. The skill carries the long form.

## Tools

| Tool | API call | Use |
| ---- | -------- | --- |
| `task_list` | `GET /tasks` | Search/filter; the inbox is `status: [needs_user_decision, needs_user_action, needs_qa]` |
| `task_get` | `GET /tasks/:id` | Full task incl. comments, decisions, dependencies; accepts `42` or `"TASK-000042"` |
| `task_create` | `POST /tasks` (+ `POST /tasks/:id/transition`) | File a task; optional `transition` applied after (see below) |
| `task_update` | `PATCH /tasks/:id` | Edit fields (never status) |
| `task_transition` | `POST /tasks/:id/transition` | Any status, with the payload it requires |
| `task_next` | `POST /tasks/next` | Claim the best available task in the project |
| `task_claim` | `POST /tasks/:id/claim` | Claim a named task |
| `task_heartbeat` | `POST /tasks/:id/heartbeat` | Extend the lease |
| `task_release` | `POST /tasks/:id/release` | Give a task up → `todo` |
| `task_comment` | `POST /tasks/:id/comments` | `kind`: `note`, `progress`, `qa_feedback` |
| `task_submit_for_qa` | transition → `needs_qa` | Finish work (agents cannot mark done) |
| `task_request_decision` | transition → `needs_user_decision` | Ask a human to choose |
| `task_request_action` | transition → `needs_user_action` | Ask a human to do something |
| `task_block` | transition → `blocked` | Waiting on tasks (`blockedBy`) or an outside event |
| `task_add_dependency` / `task_remove_dependency` | `POST` / `DELETE /tasks/:id/dependencies[/:dependsOnId]` | Ordering between tasks |
| `task_answer_decision` | `POST /tasks/:id/decision/answer` | Record a human's answer given in chat |
| `task_events` | `GET /events` | Change feed from a cursor |
| `task_stats` | `GET /tasks/stats` | Counts per status + `needsAttention` |

The four hand-off tools are deliberately redundant with `task_transition`: agents choose tools by name, and `task_submit_for_qa` makes the right ending obvious where "transition to needs_qa" does not.

### Behaviour the tools add on top of the API

- **Default project.** `task_create` and `task_next` use `TASKS_DEFAULT_PROJECT`, else the slug of the project directory's name (`CLAUDE_PROJECT_DIR`, set by Claude Code). `task_next` accepts `allProjects: true` to look everywhere. `task_list` and `task_stats` never apply it — a read must not silently hide work.
- **Idempotency key, always.** `task_create` derives one from project + title (`mcp:<project>:<title-slug>`) when the caller sends none, so a retried call, a resumed session, or a second agent noticing the same follow-up gets the existing task back (200) instead of a duplicate. Filing a new task under an old title needs an explicit key.
- **Create + transition is not atomic.** `task_create` with `transition` makes two requests, the second guarded by `expectedVersion` = the created version. If it fails, the error says the task **was created** and to use `task_transition` — never to create again. On an idempotent replay the transition runs only if the task is still in its creation status: a task that has moved on (claimed, handed to QA) is not dragged back.

## The work loop

Agents follow the `task-workflow` skill; in short:

1. `task_next` (or `task_claim` a named task).
2. Read acceptance criteria, `statusNote`, comments, answered decisions.
3. `task_heartbeat` at least every 10 minutes of work (default lease 30 min, `CLAIM_LEASE_MINUTES`).
4. `task_comment kind=progress` at milestones.
5. End with exactly one of `task_submit_for_qa`, `task_request_decision`, `task_request_action`, `task_block`, `task_release`. Never idle while claimed, never `done`.

## Setup — this repository

```bash
pnpm install
pnpm --filter @helpdesk/mcp build    # → apps/mcp/dist/index.js (pnpm build also builds it)
pnpm dev:api                         # API on :4000
claude                               # approve the "tasks" server from .mcp.json when prompted
```

`.mcp.json` registers `tasks` as `node ${CLAUDE_PROJECT_DIR:-.}/apps/mcp/dist/index.js`, with `TASKS_API_URL`, `TASKS_ACTOR`, and `TASKS_API_TOKEN` passed through from your shell (defaults: local API, `agent:claude-code`, no token). The skill is available as `.claude/skills/task-workflow` (a symlink into the plugin, so there is one copy). `pnpm --filter @helpdesk/mcp dev` rebuilds on change; reconnect with `/mcp`.

The SessionStart hook is part of the plugin only. Installing the plugin as well as using `.mcp.json` gives you the tools twice (`mcp__tasks__*` and `mcp__plugin_task-manager_tasks__*`) — pick one per repo, e.g. decline the project server or list it in `disabledMcpjsonServers`.

## Setup — other repositories

The MCP server is not published to npm; it runs from a built checkout of this repo (**the API does not need to run on the same machine — only the server script does**). Build it once (`pnpm install && pnpm --filter @helpdesk/mcp build`), then pick one:

**A. The plugin (recommended): tools + skill + SessionStart hook.**

```bash
claude plugin marketplace add /path/to/helpdesk/integrations
claude plugin install task-manager@helpdesk-tasks \
  --config api_url=http://localhost:4000/api/v1 \
  --config actor=agent:claude-code
```

The marketplace is a local directory, so Claude Code loads the plugin **in place** rather than copying it into its cache — which is what lets the plugin's launcher (`scripts/start-mcp.mjs`) find the server at `../../apps/mcp/dist/index.js` with no path configured, and makes a `git pull` + rebuild take effect on the next session. If you install the plugin some other way (a copied cache install, e.g. from a git-hosted marketplace), set `server_path` to `/path/to/helpdesk/apps/mcp/dist/index.js`. Change options later with `/plugin configure task-manager`; the token (`api_token`) is marked sensitive and goes to the OS credential store. For a one-off session: `claude --plugin-dir /path/to/helpdesk/integrations/claude-code`.

We chose a local-path launcher over bundling the server into the plugin or publishing it: bundling would mean a generated, committed build artifact that drifts from `apps/mcp`, and npm publishing is a release process this project does not have. The launcher fails with an explicit "build it with …" message when the server is missing.

**B. MCP server only, available in every repo (no skill, no hook):**

```bash
claude mcp add tasks --scope user \
  -e TASKS_API_URL=http://localhost:4000/api/v1 \
  -e TASKS_ACTOR=agent:claude-code \
  -- node /path/to/helpdesk/apps/mcp/dist/index.js
```

The server name goes first because `-e` takes several values and would otherwise swallow it; `--` separates Claude Code's options from the server command. Use `--scope project` to write a shareable `.mcp.json` into one repo instead. Copy `integrations/claude-code/skills/task-workflow` into that repo's `.claude/skills/` (or `~/.claude/skills/`) if you want the skill without the plugin.

Either way, tasks are filed under the repo's directory name as the project unless you set `TASKS_DEFAULT_PROJECT` (option B) or the agent passes `project`.

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

## Troubleshooting

| Symptom | Cause / fix |
| ------- | ----------- |
| `/mcp` shows `tasks` failed; log says `Invalid task manager MCP configuration` | A `TASKS_*` value is malformed — typically `TASKS_ACTOR` without `agent:`/`human:`, or a URL without `http(s)://`. The message names the variable |
| Log says `MCP server not found at …` (plugin) | `apps/mcp` is not built, or the plugin is a cached copy: run `pnpm --filter @helpdesk/mcp build`, or set `server_path` |
| Every tool returns "Task manager API not reachable at …" | The API is not running (`pnpm dev:api`) or `TASKS_API_URL` points elsewhere. `curl <url-without-/api/v1>/health` to check |
| "… returned 200 with a non-JSON body" / "no error envelope" | `TASKS_API_URL` points at the web app or a proxy page, not the API; it must end in `/api/v1` |
| `UNAUTHORIZED` on every call | The server has `API_TOKEN` set and `TASKS_API_TOKEN` is missing or different |
| `ACTOR_NOT_PERMITTED` on a transition | An agent tried `done`. Use `task_submit_for_qa`; a human marks it done (or the server sets `AGENTS_MAY_COMPLETE=true`) |
| `TASK_ALREADY_CLAIMED` | Someone else holds a live lease. Pick another task; a human can release it from the UI |
| `task_next` says nothing to claim | No `todo` with finished dependencies in the default project. `allProjects: true`, or refine backlog tasks into `todo` |
| Tools listed twice | Both `.mcp.json` and the plugin are active in this repo — disable one |
| Project `.mcp.json` server never starts | Claude Code asks for approval of project servers once; `claude mcp reset-project-choices` to be asked again |

## Related

- [Task_Workflow_API.md](./Task_Workflow_API.md) — the REST surface this wraps
- [Task_Status_Lifecycle.md](./Task_Status_Lifecycle.md) — statuses and what each requires
- [Actors.md](./Actors.md) — the `X-Actor` model
- [../engineering/ENVIRONMENT_VARIABLES.md](../engineering/ENVIRONMENT_VARIABLES.md) — `TASKS_*`
