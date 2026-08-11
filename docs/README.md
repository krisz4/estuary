# Documentation

Documentation for the helpdesk ticketing system. AI agents start at [AGENTS.md](./AGENTS.md); it has the routing table and the conventions.

## Map

| Folder | Audience | Contents |
| ------ | -------- | -------- |
| [pages/](./pages/README.md) | Agents + engineers | One doc per UI screen: route, components, API calls, states |
| [features/](./features/README.md) | Agents + engineers | One doc per domain behavior: rules, data model, endpoints |
| [engineering/](#engineering) | Engineers | Architecture, database, error contract, env vars, testing, UI guidelines |
| [operations/](#operations) | Engineers | Docker and running the stack |

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

## Product brief

The original code challenge is [../instructions.md](../instructions.md). It is a historical record — keep it unedited. Where the implementation goes beyond the brief (comments, priorities, seed data, OpenAPI), the feature doc says so.
