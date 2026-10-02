# Contributing to Estuary

Thanks for helping. This file covers setup, the rules a change has to meet, and how a pull request gets merged. Please read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) first. For a security problem, don't open an issue; follow [SECURITY.md](SECURITY.md).

## Before you start

- **Bugs:** open an issue with the bug form, including the version and how you run Estuary (Docker, `pnpm dev`, or self-hosted).
- **Features:** open an issue or a Discussion **before** writing code, especially for anything touching the task workflow, the API contract, or the database schema. A short conversation up front saves you from writing a PR that can't be merged.
- **Small fixes** (typos, docs, an obvious one-line bug): just send the PR.

Issues labelled [`good first issue`](https://github.com/krisz4/estuary/labels/good%20first%20issue) are scoped for someone new to the codebase.

### Out of scope

Estuary is deliberately small: a trusted team, one SQLite file, no accounts. These won't be merged unless the project's direction changes first, so please ask before building any of them:

user accounts, roles, or per-user permissions · real authentication beyond the shared `API_TOKEN` · websockets or push (clients poll the events feed) · file attachments · email notifications · multi-tenancy.

## Setup

You need **Node ^22.18 or ≥ 24.11** (24 LTS recommended) and pnpm through Corepack:

```bash
corepack enable
pnpm install

cp apps/api/env.example apps/api/.env
cp apps/web/env.example apps/web/.env

pnpm --filter @estuary/api db:migrate   # creates the SQLite database and seeds 62 demo tasks
pnpm dev                                 # API on :4000, web on :5173
```

The [README](README.md#run-locally) explains the Node floor, and [docs/engineering/DATABASE.md](docs/engineering/DATABASE.md#migrations) has every `db:*` script.

## Where things live

| Workspace | What it is |
| --------- | ---------- |
| `packages/contracts` | zod schemas: the single source of truth for every request and response shape |
| `apps/api` | Express 5 + Prisma (SQLite) REST API under `/api/v1` |
| `apps/web` | React 19 + Vite UI |
| `apps/mcp` | The stdio MCP server agents use (published to npm as `estuary-mcp`) |
| `integrations/claude-code` | The Claude Code plugin: MCP config, the `task-workflow` skill, a SessionStart hook |

The docs are organised for looking things up: start at [docs/AGENTS.md](docs/AGENTS.md), which has a routing table from questions to the file that answers them. [docs/engineering/ARCHITECTURE.md](docs/engineering/ARCHITECTURE.md) has the layer rules.

## Rules every change follows

These are what review checks. CI enforces most of them.

1. **Contracts first.** If a request or response shape changes, change the zod schema in `packages/contracts` first. The API and the web app both derive their types from it; never hand-write a duplicate interface.
2. **Schema changes ship with a migration.** If you edit `apps/api/prisma/schema.prisma`, run `pnpm --filter @estuary/api db:migrate --name descriptive_snake_case` and commit the migration with it. CI replays the migrations and fails if they don't match the schema. Never edit a migration that has already been merged.
3. **Docs move with behavior.** If you change a route, a query param, or a behavior, update the matching doc in [docs/features/](docs/features/README.md) or [docs/pages/](docs/pages/README.md). If you add a doc, add its row to that folder's README. New env vars go in [docs/engineering/ENVIRONMENT_VARIABLES.md](docs/engineering/ENVIRONMENT_VARIABLES.md) and the workspace's `env.example`.
4. **Errors use the envelope.** Every API failure goes through `apiError()` and returns `{ error: { code, message, details?, requestId } }`. See [docs/engineering/API_ERROR_CONTRACT.md](docs/engineering/API_ERROR_CONTRACT.md).
5. **Workflow rules don't regress.** Status changes only through the transition endpoints, every task write goes through `writeTask()` and records an event, and agents stop at `needs_qa`. See [docs/features/Task_Workflow_API.md](docs/features/Task_Workflow_API.md).
6. **UI works at 360px.** Every page is checked on a phone-width screen as well as desktop, and every async view has loading, error, and empty states. See [docs/engineering/UI_DESIGN_GUIDELINES.md](docs/engineering/UI_DESIGN_GUIDELINES.md).
7. **The OpenAPI spec stays fresh.** If the contracts changed, run `pnpm --filter @estuary/api openapi:gen` and commit `apps/api/openapi.json`.

## Checks

Run these before you push. It's the same set CI runs.

```bash
pnpm typecheck
pnpm lint
pnpm format:check   # pnpm format fixes it
pnpm test           # unit + integration; each API worker uses its own temp database
pnpm test:e2e       # Playwright; boots its own API and web app on ports 4010/5183
```

None of these touch your development database. [docs/engineering/TESTING.md](docs/engineering/TESTING.md) says what each layer must cover. A bug fix should come with a test that fails without it.

## Pull requests

- **Branch** from `main`, and keep a PR to one change. A refactor and a feature in one PR is two PRs.
- **Commit messages** are a short imperative sentence ("Add a label filter to the inbox"), plus a body when the *why* isn't obvious.
- **Fill in the PR template.** Its checklist matches the rules above.
- **Update [CHANGELOG.md](CHANGELOG.md)** under `Unreleased` for anything a user or self-hoster would notice.
- CI must be green. A maintainer reviews and squash-merges.

## Working with AI agents

Estuary is built with coding agents and for them, and AI-assisted contributions are welcome. The repo is set up for it:

- [CLAUDE.md](CLAUDE.md) holds the repo rules for Claude Code, and [.claude/agents/](.claude/agents/) holds scoped subagents (`api-engineer`, `web-engineer`, `db-migrator`, `docs-keeper`, `qa-verifier`).
- The repo's `.mcp.json` connects your agent to a local Estuary instance, so it can track its own work there: `pnpm dev:api`, then approve the `tasks` server.

You're responsible for what you submit, whoever typed it. Read the diff, run the checks, and make sure the PR description is true.

## License

Estuary is licensed under the [GNU Affero General Public License v3.0 only](LICENSE). By contributing, you agree that your contribution is licensed under the same terms (inbound = outbound). There's no CLA to sign.

If you run a **modified** Estuary as a network service, section 13 of the AGPL requires you to offer your users the modified source.
