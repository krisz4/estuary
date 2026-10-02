# Changelog

All notable changes to Estuary are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, a minor version may include breaking changes; they're listed under **Changed** with what you need to do.

How a release is cut: [docs/operations/RELEASING.md](docs/operations/RELEASING.md).

## [Unreleased]

## [0.1.0] - 2026-09-26

First open-source release.

### Added

- A task manager for AI coding agents and the humans working with them. Tasks move through ten statuses (`backlog` → `done` / `deferred`), and agents claim tasks under a lease, so two agents never work the same task.
- Dependencies, parent tasks and subtasks, labels, and free-text search.
- Decisions and actions: an agent asks a human to choose between options, or to do something only a human can, and carries on once it's answered.
- The Estuary web UI: the map (the landing page), the filterable list, the inbox of everything waiting on a human, the Logbook of history and flow metrics, and task detail. It works down to 360px wide.
- `estuary-mcp`: a stdio MCP server that exposes the workflow to any MCP client as `task_*` tools.
- The Estuary plugin for Claude Code: the MCP tools, the `task-workflow` skill, and a SessionStart hook that reminds an agent of the tasks it still holds.
- An optional GitHub integration: live PR and issue status on tasks, issue import, and a signed webhook that links PRs to tasks.
- A REST API under `/api/v1` with an OpenAPI spec served at `/docs`.
- Docker images for the API and the web app, and an optional shared `API_TOKEN` for self-hosted instances.

### Changed

- The project is renamed from `helpdesk` to **Estuary** and licensed under AGPL-3.0-only. If you ran an earlier checkout, see the upgrade notes in [docs/operations/RELEASING.md](docs/operations/RELEASING.md#upgrading-from-a-pre-rename-checkout).

[Unreleased]: https://github.com/krisz4/estuary/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/krisz4/estuary/releases/tag/v0.1.0
