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
