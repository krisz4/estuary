# Helpdesk

A helpdesk ticketing system — file, track, comment on, and close IT support tickets. Built for the code challenge in [instructions.md](instructions.md).

> **Status:** architecture and documentation are complete; application code is not scaffolded yet. The commands below describe the intended setup and are the contract the implementation is built to. See [docs/](docs/README.md).

## Stack

| Part | Tech |
| ---- | ---- |
| API | Node 20, Express 5, TypeScript, Prisma, SQLite |
| Web | React 19, Vite, TypeScript, React Router, TanStack Query, Tailwind |
| Shared | zod contracts consumed by both |
| Tooling | pnpm workspaces, Turborepo, vitest, Playwright, Docker |

## Run with Docker (one command)

```bash
docker compose up --build
```

- Web → http://localhost:5173
- API → http://localhost:4000
- API docs (Swagger UI) → http://localhost:4000/docs

The database is migrated and seeded automatically. Details and caveats: [docs/operations/DOCKER.md](docs/operations/DOCKER.md).

## Run locally

Requires Node 20+ and pnpm 9+.

```bash
pnpm install

cp apps/api/env.example apps/api/.env
cp apps/web/env.example apps/web/.env

pnpm --filter @helpdesk/api db:migrate   # create the SQLite database
pnpm --filter @helpdesk/api db:seed      # 63 realistic tickets

pnpm dev                                 # API on :4000, web on :5173
```

Run one side at a time with `pnpm dev:api` or `pnpm dev:web`.

## Tests

```bash
pnpm test          # unit + integration
pnpm test:e2e      # Playwright (boots both apps)
pnpm typecheck
pnpm lint
```

What each layer covers: [docs/engineering/TESTING.md](docs/engineering/TESTING.md).

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

Ticket ids are integers and double as the ticket number — `/api/v1/tickets/42` is `HD-000042`.

Every list parameter is documented in [docs/features/Ticket_Query_Filter_Sort_Page.md](docs/features/Ticket_Query_Filter_Sort_Page.md).

## Documentation

- **[docs/](docs/README.md)** — index
- **[docs/AGENTS.md](docs/AGENTS.md)** — entry point for AI agents; routing table and conventions
- **[docs/pages/](docs/pages/README.md)** — one doc per screen
- **[docs/features/](docs/features/README.md)** — one doc per domain behavior
- **[CLAUDE.md](CLAUDE.md)** — working rules for Claude Code in this repo

## Scope

No authentication and no user management, per the brief. Requester name and email are plain ticket fields, not accounts. Attachments, notifications, and real-time updates are out of scope — see [docs/features/Attachments.md](docs/features/Attachments.md) for the reasoning on the most conspicuous omission.
