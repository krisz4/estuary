# Feature specs index

Domain behavior, data rules, and API contracts for **agents and engineers**. Parent index: [../README.md](../README.md). Agent entry: [../AGENTS.md](../AGENTS.md).

Each doc has YAML frontmatter (`type: Feature`, `title`, `description`, `tags`, optional `resource` / `status`). `status: plan` = design only, confirm in code before implementing.

Prefer this index (or the frontmatter) before opening every file.

## Core domain

| Doc | Description |
| --- | ----------- |
| [Tickets.md](./Tickets.md) | The Ticket resource: fields, CRUD endpoints, validation, delete semantics |
| [Ticket_Numbering.md](./Ticket_Numbering.md) | The integer primary key **is** the ticket number, displayed as `HD-000042` |
| [Ticket_Status_Lifecycle.md](./Ticket_Status_Lifecycle.md) | Status values, legal transitions, `resolvedAt`/`closedAt` side effects |
| [Ticket_Priority.md](./Ticket_Priority.md) | Priority scale, ordering rules, UI mapping |
| [Ticket_Query_Filter_Sort_Page.md](./Ticket_Query_Filter_Sort_Page.md) | The list query: every param, the envelope, and how the UI binds it to the URL |
| [Comments.md](./Comments.md) | Ticket comment thread: model, endpoints, ordering, cascade |

## Platform

| Doc | Description |
| --- | ----------- |
| [Validation_And_Contracts.md](./Validation_And_Contracts.md) | `packages/contracts` as the single source of truth for shapes |
| [Error_Handling.md](./Error_Handling.md) | Server envelope, client surfacing, retry and toast rules |
| [API_Documentation.md](./API_Documentation.md) | zod → OpenAPI generation, `/docs` Swagger UI |
| [Seed_Data.md](./Seed_Data.md) | What `db:seed` creates and why the volumes matter |

## Plans (not runtime SoT — confirm in code)

| Doc | Description |
| --- | ----------- |
| [Attachments.md](./Attachments.md) | File attachments on tickets — deliberately out of scope for the challenge |

## Related

- Screens that expose these features: [../pages/README.md](../pages/README.md)
- Error code table: [../engineering/API_ERROR_CONTRACT.md](../engineering/API_ERROR_CONTRACT.md)
