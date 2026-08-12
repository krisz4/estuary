# Helpdesk

A helpdesk ticketing system — file, track, comment on, and close IT support tickets. Built for the code challenge in [instructions.md](instructions.md).

Tickets have a reference (`HD-000042`), a status lifecycle, a priority, a category, a requester, an optional assignee, and a comment thread. The list screen filters, sorts, and pages entirely through the URL, so any view is shareable — and the [board](docs/pages/Tickets_Board.md) at `/tickets/board` is a second reading of that same URL state, with one column per status and drag-and-drop between them. There is no authentication — that is a deliberate scope decision from the brief, not an omission.

## Stack

| Part | Tech |
| ---- | ---- |
| API | Node (20+ at runtime, 22.5+ to develop — see below), Express 5, TypeScript, Prisma, SQLite |
| Web | React 19, Vite, TypeScript, React Router, TanStack Query, Tailwind, dnd-kit (board) |
| Shared | zod contracts consumed by both |
| Tooling | pnpm workspaces, Turborepo, vitest, Playwright, Docker |

## Run with Docker (one command)

```bash
docker compose up --build
```

- Web → http://localhost:5173
- API → http://localhost:4000
- API docs (Swagger UI) → http://localhost:4000/docs — also proxied at http://localhost:5173/docs

The database is migrated and seeded with 63 tickets automatically on a clean volume. The web container serves the app *and* proxies `/api/` to the API on the same origin, so nothing the browser does is cross-origin.

```bash
docker compose down       # stop, keep the database (it lives on a named volume)
docker compose down -v    # stop and wipe the database
```

Details and caveats: [docs/operations/DOCKER.md](docs/operations/DOCKER.md).

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

On a fresh database `db:migrate` runs the seed itself, through Prisma's `seed` hook — you should see `Seed complete … "tickets":63`. To re-seed later (it wipes tickets and comments first, then recreates the same 63 deterministically):

```bash
pnpm --filter @helpdesk/api db:seed
```

Run one side at a time with `pnpm dev:api` or `pnpm dev:web`. Every `db:*` script is invoked as `pnpm --filter @helpdesk/api db:<script>` from the repo root; the full list is in [docs/engineering/DATABASE.md](docs/engineering/DATABASE.md#migrations).

## Tests

```bash
pnpm test          # 765 unit + integration tests (contracts, API, web)
pnpm test:e2e      # 6 Playwright spec files — boots both apps itself
pnpm typecheck
pnpm lint
pnpm format:check
```

`pnpm test` runs each API worker against its own temporary SQLite file, and `pnpm test:e2e` uses a third database on dedicated ports — neither ever touches your development data. What each layer covers: [docs/engineering/TESTING.md](docs/engineering/TESTING.md).

CI runs the same sequence plus an OpenAPI freshness check and a schema/migration drift check: [docs/operations/CI.md](docs/operations/CI.md).

## API

Base path `/api/v1`. Full reference is the generated OpenAPI spec at `/docs`.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/tickets` | List with filtering, sorting, paging |
| `GET` | `/tickets/facets` | Distinct assignees and categories, for the filter selects |
| `GET` | `/tickets/:id` | One ticket with its comments |
| `POST` | `/tickets` | Create |
| `PATCH` | `/tickets/:id` | Update |
| `DELETE` | `/tickets/:id` | Delete (comments cascade) |
| `POST` | `/tickets/:id/comments` | Add a comment |
| `DELETE` | `/tickets/:id/comments/:commentId` | Delete a comment |

Plus `GET /health` at the root, outside `/api/v1`.

```bash
curl 'http://localhost:4000/api/v1/tickets?status=open&priority=urgent&sort=createdAt:desc&page=1&pageSize=20'
```

List responses are enveloped as `{ data, meta }`; a single resource is returned as the object. Failures always return `{ error: { code, message, details?, requestId } }`, and clients branch on `code` rather than on the HTTP status — see [docs/engineering/API_ERROR_CONTRACT.md](docs/engineering/API_ERROR_CONTRACT.md).

Ticket ids are integers and double as the ticket number — `/api/v1/tickets/42` is `HD-000042`.

Every list parameter is documented in [docs/features/Ticket_Query_Filter_Sort_Page.md](docs/features/Ticket_Query_Filter_Sort_Page.md).

## Layout

```
apps/api               Express + Prisma. routes/ → services/ → lib/
apps/web               React SPA. pages/ features/ components/ api/ lib/
packages/contracts     zod schemas + inferred types — the single source of truth
packages/tsconfig      shared tsconfig bases
e2e/                   Playwright specs
docs/                  see below
```

`apps/*` depend on `packages/contracts` and never on each other. Layer rules and the request lifecycle: [docs/engineering/ARCHITECTURE.md](docs/engineering/ARCHITECTURE.md).

## Documentation

- **[docs/](docs/README.md)** — index
- **[docs/AGENTS.md](docs/AGENTS.md)** — entry point for AI agents; routing table and conventions
- **[docs/pages/](docs/pages/README.md)** — one doc per screen
- **[docs/features/](docs/features/README.md)** — one doc per domain behavior
- **[CLAUDE.md](CLAUDE.md)** — working rules for Claude Code in this repo

## Scope

No authentication and no user management, per the brief. Requester name and email are plain ticket fields, not accounts. Attachments, notifications, and real-time updates are out of scope — see [docs/features/Attachments.md](docs/features/Attachments.md) for the reasoning on the most conspicuous omission.

## Implementation and key decisions

**1. Plan architecture**

- I choose to create a separate nodejs app and react app instead of a nextjs solution. It was closer to the task description. To make development and sharing easier I choose to put these two apps into one monorepo. Similarly to make it easier to share and run the project I went with SQLite for db.
- All the request and response shapes live in `packages/contracts` as zod schemas, and both apps get their types from there. The OpenAPI spec is generated from the same schemas. This is what kept the API and the web app in sync, they were built in different stages by different agent sessions and never drifted apart.
- Using AI I created the plan for architecture and set up AGENTS.md and CLAUDE.md files. I used a similar set of instructions and structure as I do with my own projects. That also means a routing table for agents in `docs/AGENTS.md`, one doc per screen and per feature, and scoped subagents in `.claude/agents/`. The implementation might be slightly more serious than what this test expects but it's closer to how I work on a real project.

**2. I created and refined an implementation plan with AI**

It ended up as 16 stages in [docs/engineering/IMPLEMENTATION_PLAN.md](docs/engineering/IMPLEMENTATION_PLAN.md), each one with a pass/fail gate written before the stage ran.

**3. Building the application**

- I gave the following prompt to AI: Build the docs/engineering/IMPLEMENTATION_PLAN.md in the following way: You are an orchestrator managing the the build. Each step of the plan has to be run in a subagent in sequence. Once sub agent finished. A code review has to be done on it. Any remaining work or deferred work has to be documented and if resolvable use any source needed including web search, and finding reference of existing products. Once everything finished and code review findings fixed too commit the changes. After commit start a new subagent with the next step repeat the previously described steps until all steps finished. Consider the performance as well and improvement possibilities and keep track of them in a doc. Don't do them in parallel each step after the next
- The decision for no parallel agents are just for easier tracking and easier continuation in case I run out of session token window
- The prompt creates a multi step flow that builds, reviews and documents feature than commits it. There is also a BUILD_LOG.md file that keeps track of progress and any notes made by the ai. It also keeps track of performance improvement possibilities that were not implemented
- The git history is one commit per stage.
- The thing I like most about how this went is that every stage had to prove its own tests can actually fail. A gate means nothing if the tests behind it pass no matter what, so each stage broke the implementation on purpose and checked that a named test fires. Every stage from 6 onward found at least one test that could not fail. It also caught real bugs, not just weak tests. Stage 7 found `?q=%` returning the whole table, and stage 11 found three UI defects just by looking at screenshots that every test had passed through.

**4. Reviewing BUILD_LOG**

- Decided on which items are worth or needed to be implemented from the deferred items and optimalization suggestions
- The ones I didn't take are written down with a reason and a trigger for when to revisit, so they are decisions and not things that got forgotten. The `commentCount` join, the wildcard search path and its bind parameter limit, and turning off vitest per file isolation, which I remeasured and dropped because the number that made it look slow turned out to be noise.

**5. Manual QA and fixups**

- UI changes: instead of just a list view I wanted a drag and drop columns for the the different states
- Selected view didn't persist on navigation. Introduced state with zustand. I prefer to use it over directly accessing local storage. The rule I settled on is that anything a shared link should reproduce stays in the URL, the store is only for per machine preference.
- Added some optimalizations. The main one is the React Compiler. One component opts out, `CommentComposer`, because it needs `register()` to run again after `reset()` to clear the textarea and the compiler has no way to see that. The reason is written in the file.
