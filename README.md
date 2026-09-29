# Estuary AI task manager

A task manager built for coding agents and the humans working alongside them. Tasks move through a ten-status lifecycle (`backlog` → … → `done`/`deferred`), carry a claim/lease so two agents never grab the same work, and support dependencies, decisions ("ask a human, then keep going"), and an append-only event feed. Agents drive it through an MCP server (`apps/mcp`) that wraps the same REST API the web app calls — see [docs/features/Agent_Integration.md](docs/features/Agent_Integration.md).
Project is still in early stage and many improvements are planned for it.
There is still no authentication in the accounts sense: actors self-declare who they are (`X-Actor: agent:claude-code` / `human:dana`), and an optional shared `API_TOKEN` gates a self-hosted instance — see [docs/features/Actors.md](docs/features/Actors.md).

## What's in the app

The web UI goes by **Estuary**: work flows downstream from backlog to done, and anything that waits on a human is shown in amber.

| Screen | Route | What it's for |
| ------ | ----- | ------------- |
| Map | `/tasks/map` (the landing page) | The river map of every task by status, with the needs-you queue, in-flight work, the full filterable list, and recent activity below it. Drag a task onto another status to move it, and use quick add to create one |
| List | `/tasks` | Filter by status, priority, project, assignee, label, and free text (`q`). The filters live in the URL, so a filtered view can be shared as a link |
| Inbox | `/inbox` | Everything waiting on a human: decisions to answer, actions to take, and work to QA |
| Logbook | `/logbook` | History: what changed since you left, cumulative flow, throughput, how long tasks waited on a human, cycle time, per-agent activity, the event log, and the archive |
| Task detail | `/tasks/:id` | Status, claim and decision controls, dependencies, comments, activity, and live GitHub PR/issue status |

The header's project switcher scopes every screen to a single project (or to all of them). Labels narrow work within a project, for example a monorepo workspace like `web` or `api`. Per-screen docs are in [docs/pages/](docs/pages/README.md).

## History

This started as a helpdesk-ticketing code challenge and was rebuilt into an AI task manager afterward. Some historical docs (`docs/engineering/IMPLEMENTATION_PLAN.md`, `docs/engineering/BUILD_LOG.md`) still describe that original build; they say so at the top and link forward to the current docs.

## Stack

| Part | Tech |
| ---- | ---- |
| API | Node 24 (see below for the floor), Express 5, TypeScript, Prisma, SQLite |
| Web | React 19, Vite, TypeScript, React Router, TanStack Query, Tailwind |
| MCP server | `apps/mcp` — stdio server for Claude Code and other MCP clients, thin HTTP client over the API |
| Shared | zod contracts (`packages/contracts`) consumed by all three |
| Tooling | pnpm workspaces, Turborepo, vitest, Playwright, Docker |

## Run with Docker (one command)

```bash
docker compose up --build
```

- Web → http://localhost:5173
- API → http://localhost:4000
- API docs (Swagger UI) → http://localhost:4000/docs — also proxied at http://localhost:5173/docs

The database is migrated and seeded with 62 demo tasks across three projects automatically on a clean volume (`SEED_ON_START: "true"` in `docker-compose.yml`). Set it to `"false"` to start with an empty instance. The web container serves the app *and* proxies `/api/` to the API on the same origin, so nothing the browser does is cross-origin.

```bash
docker compose down       # stop, keep the database (it lives on a named volume)
docker compose down -v    # stop and wipe the database
```

Details, caveats, and how to self-host this for agents on other machines (set `API_TOKEN`, put it behind HTTPS): [docs/operations/DOCKER.md](docs/operations/DOCKER.md).

## Run locally

**Requires Node ^22.18 or ≥ 24.11** (24 LTS recommended), which is what the root `engines` field says. Two independent floors produce that range: pnpm 11, pinned via `packageManager`, imports `node:sqlite`, which does not exist before Node 22.5 — on Node 20 the install fails with `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`. And `@babel/core` 8, which the web build pulls in for the React Compiler, requires `^22.18.0 || >=24.11.0`. Enable the pinned pnpm with `corepack enable`.

```bash
pnpm install

cp apps/api/env.example apps/api/.env
cp apps/web/env.example apps/web/.env

pnpm --filter @helpdesk/api db:migrate   # creates the SQLite database and seeds it

pnpm dev                                 # API on :4000, web on :5173
```

Open http://localhost:5173.

On a fresh database `db:migrate` runs the seed itself, through Prisma's `seed` hook — you should see `Seed complete … "tasks":62`. To re-seed later (it wipes tasks, comments, decisions, dependencies, and events first, then recreates the same 62 deterministically):

```bash
pnpm --filter @helpdesk/api db:seed
```

Run one side at a time with `pnpm dev:api` or `pnpm dev:web`. Every `db:*` script is invoked as `pnpm --filter @helpdesk/api db:<script>` from the repo root; the full list is in [docs/engineering/DATABASE.md](docs/engineering/DATABASE.md#migrations).

## Tests

```bash
pnpm test          # unit + integration tests across contracts, API, web, and the MCP server
pnpm test:e2e      # Playwright — boots both apps itself
pnpm typecheck
pnpm lint
pnpm format:check
```

`pnpm test` runs each API worker against its own temporary SQLite file, and `pnpm test:e2e` uses a third database on dedicated ports — neither ever touches your development data. What each layer covers: [docs/engineering/TESTING.md](docs/engineering/TESTING.md).

CI runs the same sequence plus an OpenAPI freshness check and a schema/migration drift check: [docs/operations/CI.md](docs/operations/CI.md).

## API

Base path `/api/v1`. Full reference is the generated OpenAPI spec at `/docs`, or [docs/features/Task_Workflow_API.md](docs/features/Task_Workflow_API.md) for the behavior behind every endpoint.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/tasks` | List with filtering, sorting, paging |
| `GET` | `/tasks/facets` | Distinct assignees, projects, creators, for filter selects |
| `GET` | `/tasks/stats` | Count per status, plus how many need human attention |
| `GET` | `/tasks/:id` | One task with comments, decisions, dependencies |
| `POST` | `/tasks` | Create (idempotent — a repeated `idempotencyKey` replays the same task) |
| `PATCH` | `/tasks/:id` | Update (never `status` — see below) |
| `DELETE` | `/tasks/:id` | Delete (comments/decisions/dependencies cascade) |
| `POST` | `/tasks/:id/transition` | Move to any of the ten statuses, with the payload it requires |
| `POST` | `/tasks/next` \| `/tasks/:id/claim` \| `/tasks/:id/heartbeat` \| `/tasks/:id/release` | Claim, extend, or give up the lease an agent works under |
| `POST` | `/tasks/:id/decision/answer` | Answer an open "ask a human" decision |
| `POST`/`DELETE` | `/tasks/:id/dependencies[/:dependsOnId]` | Add or remove a blocking dependency |
| `POST`/`DELETE` | `/tasks/:id/comments[/:commentId]` | Add or delete a comment |
| `GET` | `/events` | Cursor-paged change feed |
| `GET` | `/floor` | Compact, dependency-aware snapshot behind the map |
| `GET` | `/stats/history` | The Logbook's charts: buckets, cumulative flow, wait-time and cycle-time percentiles, per-agent activity |
| `GET` | `/tasks/:id/github` | Live state of the task's GitHub PR/issue links (optional integration) |
| `GET` \| `POST` | `/integrations/github` \| `/integrations/github/import` \| `/integrations/github/webhook` | Integration status, issue import, and the signed PR webhook |

Plus `GET /health` at the root, outside `/api/v1`.

```bash
curl -H 'X-Actor: human:you' \
  'http://localhost:4000/api/v1/tasks?status=todo&priority=urgent&sort=createdAt:desc&page=1&pageSize=20'
```

List responses are enveloped as `{ data, meta }`; a single resource is returned as the object. Failures always return `{ error: { code, message, details?, requestId } }`, and clients branch on `code` rather than on the HTTP status — see [docs/engineering/API_ERROR_CONTRACT.md](docs/engineering/API_ERROR_CONTRACT.md).

Every write is attributed to an `X-Actor` (`agent:<name>` / `human:<name>`, defaults to `human:anonymous`) — see [docs/features/Actors.md](docs/features/Actors.md). Task ids are integers and double as the task number — `/api/v1/tasks/42` is `TASK-000042`.

`/tasks` also takes `?q=` for free-text search and a repeatable `?label=`. Every list parameter is documented in [docs/features/Task_Query_Filter_Sort_Page.md](docs/features/Task_Query_Filter_Sort_Page.md).

## GitHub integration (optional)

This is off by default. Set `GITHUB_TOKEN` on the API to show the live state of PR and issue links and to import issues as tasks. Set `GITHUB_WEBHOOK_SECRET` so that PRs mentioning `TASK-42` in their title, body, or branch get linked and commented on the task automatically. The webhook never changes a task's status. The same variables work with Docker Compose. Details are in [docs/features/GitHub_Integration.md](docs/features/GitHub_Integration.md).

## Connecting Claude Code (or another MCP client)

```bash
pnpm --filter @helpdesk/mcp build
pnpm dev:api
claude   # approve the "tasks" server from the repo's .mcp.json when prompted
```

That gives Claude Code tools like `task_next`, `task_transition`, `task_submit_for_qa`, and `task_import_github_issue` against this repo's API. Unless you set `TASKS_ACTOR`, the agent acts as `agent:claude-code@<project>`, or `agent:claude-code@<project>/<worktree>` in a linked worktree. That way a resumed session keeps its claims, and parallel worktrees don't take over each other's tasks. For other repositories, a self-hosted server, or the Claude Code plugin (skill + SessionStart hook): [docs/features/Agent_Integration.md](docs/features/Agent_Integration.md).

## Layout

```
apps/api               Express + Prisma. routes/ → services/ → lib/
apps/web               React SPA. pages/ features/ components/ api/ lib/
apps/mcp               Stdio MCP server — thin HTTP client over apps/api, for coding agents
integrations/          Claude Code plugin wrapping apps/mcp for use in other repos
packages/contracts     zod schemas + inferred types — the single source of truth
packages/tsconfig      shared tsconfig bases
e2e/                   Playwright specs
docs/                  see below
```

`apps/*` depend on `packages/contracts` and never on each other — `apps/mcp` reaches `apps/api` only over HTTP, never Prisma, so it can point at a self-hosted server on another machine. Layer rules and the request lifecycle: [docs/engineering/ARCHITECTURE.md](docs/engineering/ARCHITECTURE.md).

## Documentation

- **[docs/](docs/README.md)** — index
- **[docs/AGENTS.md](docs/AGENTS.md)** — entry point for AI agents; routing table and conventions
- **[docs/pages/](docs/pages/README.md)** — one doc per screen
- **[docs/features/](docs/features/README.md)** — one doc per domain behavior
- **[CLAUDE.md](CLAUDE.md)** — working rules for Claude Code in this repo

## Scope

No accounts, roles, or logins. Who did what is a self-declared `X-Actor` header (`agent:claude-code`, `human:dana`), and a self-hosted instance can require a shared `Authorization: Bearer <API_TOKEN>` on top of that — see [docs/features/Actors.md](docs/features/Actors.md). Attachments, notifications, and real-time updates are out of scope — see [docs/features/Attachments.md](docs/features/Attachments.md) for the reasoning on the most conspicuous omission.

- UI changes: instead of just a list view I wanted a drag and drop columns for the the different states
- Selected view didn't persist on navigation. Introduced state with zustand. I prefer to use it over directly accessing local storage. The rule I settled on is that anything a shared link should reproduce stays in the URL, the store is only for per machine preference.
- Added some optimalizations. The main one is the React Compiler. One component opts out, `CommentComposer`, because it needs `register()` to run again after `reset()` to clear the textarea and the compiler has no way to see that. The reason is written in the file.
