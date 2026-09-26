# Feature specs index

Domain behavior, data rules, and API contracts for **agents and engineers**. Parent index: [../README.md](../README.md). Agent entry: [../AGENTS.md](../AGENTS.md).

Each doc has YAML frontmatter (`type: Feature`, `title`, `description`, `tags`, optional `resource` / `status`). `status: plan` = design only, confirm in code before implementing.

Prefer this index (or the frontmatter) before opening every file.

## Core domain

| Doc | Description |
| --- | ----------- |
| [Tasks.md](./Tasks.md) | The Task resource: fields, CRUD endpoints, validation, delete semantics |
| [Task_Numbering.md](./Task_Numbering.md) | The integer primary key **is** the task number, displayed as `TASK-000042` |
| [Task_Status_Lifecycle.md](./Task_Status_Lifecycle.md) | The ten statuses, what a transition into each requires, side effects |
| [Task_Workflow_API.md](./Task_Workflow_API.md) | Every endpoint incl. transitions, claims/`next`, decisions, dependencies, events; versions and idempotency |
| [Actors.md](./Actors.md) | `X-Actor` attribution, the optional `API_TOKEN`, and the agent-vs-human rules |
| [Agent_Integration.md](./Agent_Integration.md) | The MCP server (`apps/mcp`), its tools, the Claude Code plugin + `task-workflow` skill, and setup for this repo, other repos, and self-hosted servers |
| [Task_Priority.md](./Task_Priority.md) | Priority scale, ordering rules, UI mapping |
| [Labels.md](./Labels.md) | Free-form tags narrowing work inside a project — schema, replace-not-merge, `?label=`, `task_next` |
| [Task_Query_Filter_Sort_Page.md](./Task_Query_Filter_Sort_Page.md) | The list query: every param, the envelope, and how the UI binds it to the URL |
| [Comments.md](./Comments.md) | Task comment thread: model, endpoints, ordering, cascade |
| [GitHub_Integration.md](./GitHub_Integration.md) | Optional GitHub link — live PR/issue status, the inbound webhook, issue import |
| [Floor_Snapshot.md](./Floor_Snapshot.md) | `GET /floor` — the compact, graph-aware snapshot behind `/tasks/floor`: scope vs filters, the shipped window, the cap, dependency edges, replay |
| [History_Stats.md](./History_Stats.md) | `GET /stats/history` — the Logbook's charts: buckets, the CFD snapshot, human-wait/cycle-time percentiles, per-agent activity |

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
| [Attachments.md](./Attachments.md) | File attachments on tasks — deliberately out of scope, not just deferred |

## Related

- Screens that expose these features: [../pages/README.md](../pages/README.md)
- Error code table: [../engineering/API_ERROR_CONTRACT.md](../engineering/API_ERROR_CONTRACT.md)
