# Documentation

Documentation for Estuary, the task manager for AI agents and the humans working with them. AI agents start at [AGENTS.md](./AGENTS.md); it has the routing table and the conventions.

## Map

| Folder | Audience | Contents |
| ------ | -------- | -------- |
| [pages/](./pages/README.md) | Agents + engineers | One doc per UI screen: route, components, API calls, states |
| [features/](./features/README.md) | Agents + engineers | One doc per domain behavior: rules, data model, endpoints |
| [engineering/](#engineering) | Engineers | Architecture, database, error contract, env vars, testing, UI guidelines |
| [operations/](#operations) | Engineers | Docker, CI, releases, and running the stack |
| [history/](#history) | Anyone curious | The helpdesk code challenge this started as, and how it was first built |

## Engineering

| Doc | Description |
| --- | ----------- |
| [ARCHITECTURE.md](./engineering/ARCHITECTURE.md) | Monorepo layout, layer boundaries, request lifecycle, key decisions |
| [DATABASE.md](./engineering/DATABASE.md) | Prisma schema, indexes, SQLite caveats, migration workflow |
| [API_ERROR_CONTRACT.md](./engineering/API_ERROR_CONTRACT.md) | Error envelope, code table, status mapping |
| [ENVIRONMENT_VARIABLES.md](./engineering/ENVIRONMENT_VARIABLES.md) | Every env var, its default, and who reads it |
| [TESTING.md](./engineering/TESTING.md) | Test pyramid, fixtures, what each layer must cover |
| [UI_DESIGN_GUIDELINES.md](./engineering/UI_DESIGN_GUIDELINES.md) | Tokens, breakpoints, component patterns, required states |

## Operations

| Doc | Description |
| --- | ----------- |
| [DOCKER.md](./operations/DOCKER.md) | Dockerfiles, compose, volumes, production build |
| [CI.md](./operations/CI.md) | GitHub Actions workflows: gate order, the checks that exist only in CI, CodeQL, the secret scan |
| [RELEASING.md](./operations/RELEASING.md) | Versioning, cutting a release (npm + GHCR + GitHub release), and upgrading from a pre-rename checkout |

## History

Estuary began as a helpdesk-ticketing code challenge and was rebuilt into an AI task manager afterward. These are records of that first build. Keep them unedited apart from link fixes; they describe the old system, not the current one.

| Doc | Description |
| --- | ----------- |
| [instructions.md](./history/instructions.md) | The original code-challenge brief |
| [IMPLEMENTATION_PLAN.md](./history/IMPLEMENTATION_PLAN.md) | Build order from empty repo to submission: 16 stages, their gates, and the dependency graph |
| [HOW_IT_WAS_BUILT.md](./history/HOW_IT_WAS_BUILT.md) | The author's write-up of how the challenge was planned and built with AI agents |
| [BUILD_LOG.md](./history/BUILD_LOG.md) | Per-stage results, deferred work, and the performance ledger (the `P`/`D` numbers code comments cite) |
