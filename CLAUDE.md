# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Helpdesk ticketing system — users create, edit, comment on, and delete IT support tickets. Original brief: [instructions.md](instructions.md). **No authentication and no user management** (deliberate scope decision from the brief — do not add auth).

## Agent checklist (before finishing)

1. **Contracts first** — Request/response shapes live in `packages/contracts` as zod schemas. If an API shape changes, change the schema there first; API and web both derive their types from it. Never hand-write a duplicate interface in `apps/web`.
2. **Schema** — If `apps/api/prisma/schema.prisma` changed → a migration under `apps/api/prisma/migrations/` ships in the same change set. Never commit schema-only diffs.
3. **Docs** — If behavior, routes, or query params changed → update the matching [docs/pages/](docs/pages/README.md) or [docs/features/](docs/features/README.md) doc (keep YAML frontmatter + folder README in sync). New env vars → [docs/engineering/ENVIRONMENT_VARIABLES.md](docs/engineering/ENVIRONMENT_VARIABLES.md) + both `env.example` files.
4. **Errors** — Every API failure path returns the standard envelope via `apiError()`. No bare `res.status(500).send("...")`. See [docs/engineering/API_ERROR_CONTRACT.md](docs/engineering/API_ERROR_CONTRACT.md).
5. **Types & tests** — Run `pnpm typecheck` after touching `packages/contracts` or the Prisma schema. Run `pnpm test` for the workspace you changed.

## Commands

Standard scripts are in `package.json` (root and per-workspace). What isn't obvious from there:

- `pnpm dev` runs both apps via Turborepo → API on **4000**, web on **5173**. `pnpm dev:api` / `pnpm dev:web` run one.
- **`db:*` scripts are always invoked as `pnpm --filter @helpdesk/api db:<script>`** from the repo root (they are defined in `apps/api/package.json` and resolve paths relative to it). Use that form everywhere, including in docs. The SQLite file lives at `apps/api/prisma/data/helpdesk.db` and is gitignored.
- `db:reset` drops and re-seeds — destructive. `db:seed` generates 63 realistic tickets so the list page has something to filter and page through; it is guarded by `ALLOW_SEED`, not `NODE_ENV`.
- `pnpm test` = vitest across workspaces. API tests run against a **temp SQLite file per worker**, never the dev DB. E2E uses its own third database.
- `pnpm test:e2e` = Playwright; it boots both apps itself via `webServer` config, on **dedicated ports** (API 4010, web 5183) against a third database at `e2e/helpdesk-e2e.db`. It never reuses a running `pnpm dev` — that would point the mutating specs at your local data.
- OpenAPI spec is generated from the zod contracts: `pnpm --filter @helpdesk/api openapi:gen` → `apps/api/openapi.json`, served at `GET /docs`.

## Architecture

**Monorepo** managed with pnpm workspaces + Turborepo.

| Workspace | Stack | Responsibility |
|-----------|-------|----------------|
| `apps/api` | Node 20 + Express 5 + TypeScript + Prisma (SQLite) | REST API under `/api/v1`, validation, error envelope, OpenAPI, seed |
| `apps/web` | React 19 + Vite + TypeScript + React Router + TanStack Query + Tailwind | All UI, responsive down to 360px |
| `packages/contracts` | TypeScript + zod | Shared request/response schemas, enums, and inferred types — the single source of truth for the API surface |
| `packages/tsconfig` | — | Shared `tsconfig` bases |

Full diagram and layer rules: [docs/engineering/ARCHITECTURE.md](docs/engineering/ARCHITECTURE.md).

**Dependency direction is one-way:** `apps/*` → `packages/contracts`. The contracts package must stay runtime-agnostic — no Express, no Prisma, no React, no `node:` imports. It is imported by browser code.

### API layering (`apps/api/src`)

```
routes/      Express routers — parse + validate (zod) → call service → send
services/    Business logic + Prisma access. No req/res objects in here.
lib/         prisma client, errors, pagination, openapi, logger
middleware/  requestId, errorHandler, notFound
```

Routes never touch Prisma directly; services never touch `req`/`res`. This is the rule that keeps the service layer unit-testable.

### Web structure (`apps/web/src`)

```
pages/        One folder per route (see docs/pages/)
components/   Shared presentational components (ui/ = primitives)
features/     Ticket-domain components used by pages
api/          Typed fetch client + TanStack Query hooks (query keys live here)
lib/          formatting, cn(), url-state helpers
```

Query keys are centralized in `apps/web/src/api/queryKeys.ts` — invalidate through those, never with inline arrays.

## Database

SQLite via Prisma. Three constraints shape the schema more than anything else — all three are in [docs/engineering/DATABASE.md](docs/engineering/DATABASE.md):

1. **No native enums.** `status`, `priority`, `category` are `String` columns constrained by the zod enums in `packages/contracts`. Never write a raw status string in a service.
2. **`autoincrement()` only on the `@id` field.** That is why `Ticket.id` is an `Int` and *is* the ticket number (`/tickets/42` ↔ `HD-000042`) rather than a cuid alongside a separate counter — see [docs/features/Ticket_Numbering.md](docs/features/Ticket_Numbering.md).
3. **No `mode: "insensitive"`, and `equals` is case-sensitive.** Exact-match filters compare canonical values instead: `category` is an enum, `requesterEmail` is stored lowercase, and `assignee` options come from `GET /tickets/facets`.

Migration workflow:

1. Edit `apps/api/prisma/schema.prisma`.
2. `pnpm --filter @helpdesk/api db:migrate --name descriptive_snake_case`.
3. Commit schema + migration SQL together.

`db push` is for throwaway local experiments only.

## API conventions

- Base path `/api/v1`; `GET /health` sits outside it at the root (Docker healthchecks it). Every route is documented in [docs/features/](docs/features/README.md).
- **List responses are always enveloped:** `{ data: [...], meta: { page, pageSize, total, totalPages, hasNextPage, hasPrevPage } }`. Single-resource responses return the object directly.
- **Errors always** use `{ error: { code, message, details?, requestId } }` with a `SCREAMING_SNAKE` code. Clients branch on `error.code`, not on HTTP status alone.
- Validation is zod at the edge; a failed parse becomes `VALIDATION_ERROR` (422) with per-field `details`.
- Dates are ISO 8601 UTC strings on the wire. The DB stores `DateTime`; never send raw `Date` objects through `JSON.stringify` assumptions — the serializer in `lib/serialize.ts` handles it.

## Frontend conventions

- **List state lives in the URL**, not React state: `?page=2&pageSize=20&status=open&sort=createdAt:desc`. This makes filtered views shareable and makes back/forward work. Helper: `useTicketListParams()`, which **picks known keys** rather than strict-parsing the raw params — a stray `utm_source` on a shared link must not reset every filter. See [docs/features/Ticket_Query_Filter_Sort_Page.md](docs/features/Ticket_Query_Filter_Sort_Page.md).
- Server state is TanStack Query only. Do not mirror fetched data into `useState`.
- Mutations invalidate `queryKeys.tickets.all` on success and show a toast; destructive actions require a confirm dialog.
- **Responsive is a requirement, not a nice-to-have** (explicit in the brief): the ticket table collapses to stacked cards below `md`. Every page must be checked at 360px. See [docs/engineering/UI_DESIGN_GUIDELINES.md](docs/engineering/UI_DESIGN_GUIDELINES.md).
- Every async view has three states wired: loading (skeleton), error (with retry), empty (with CTA). Reviewers look for this.

## Documentation

**AI entry point:** [docs/AGENTS.md](docs/AGENTS.md) — routing table, conventions, search order. Read before any non-trivial change.

| Path | Use for |
| ---- | ------- |
| [docs/pages/](docs/pages/README.md) | Per-screen route, components, APIs, states |
| [docs/features/](docs/features/README.md) | Domain behavior, data rules, API contracts |
| `docs/engineering/` | Architecture, DB, error contract, env vars, testing, UI guidelines |
| `docs/operations/` | Docker, running and deploying |

`docs/pages/` and `docs/features/` use YAML frontmatter (`type`, `title`, `description`, `resource`, `tags`, `status`). Start from the folder README, then open the matching file. `status: plan` means design-only — confirm in code before implementing.

When you add a page or feature, create its doc **and** add the row to the folder README in the same change set.

## Subagents

Specialised agents live in `.claude/agents/`. Prefer them for scoped work: `api-engineer`, `web-engineer`, `db-migrator`, `docs-keeper`, `qa-verifier`. Each one's boundaries are in its own file.

## Out of scope (do not add unasked)

Authentication, user accounts, roles, permissions, real-time updates, file attachments, email notifications, and multi-tenancy are all **out of scope**. If a task seems to need one, say so and stop rather than inventing it.
