# Documentation guide for AI agents

Use this file when exploring or changing the helpdesk codebase. Humans: see [README.md](./README.md). Commands and repo-wide rules: [../CLAUDE.md](../CLAUDE.md).

## Repo context

- **`apps/api`** — Node + Express + Prisma/SQLite. REST under `/api/v1`, OpenAPI at `/docs`.
- **`apps/web`** — React + Vite SPA. All four screens of the product.
- **`packages/contracts`** — zod schemas + inferred types shared by both apps. Runtime-agnostic.
- **`packages/tsconfig`** — shared TS bases.

The product is small enough to hold in your head: **one resource (Ticket) with one child (Comment)**. Most tasks touch three files — a contract, a service, and a page.

## Which doc type to open

| Question | Read first |
| -------- | ---------- |
| What does this screen render, and what does it call? | `docs/pages/<Screen>.md` — index: [pages/README.md](./pages/README.md) |
| What are the ticket fields, statuses, and CRUD rules? | [features/Tickets.md](./features/Tickets.md) |
| How do filtering / sorting / paging work end to end? | [features/Ticket_Query_Filter_Sort_Page.md](./features/Ticket_Query_Filter_Sort_Page.md) |
| Which status transitions are legal? | [features/Ticket_Status_Lifecycle.md](./features/Ticket_Status_Lifecycle.md) |
| Where does `HD-000042` come from? | [features/Ticket_Numbering.md](./features/Ticket_Numbering.md) |
| How do comments work? | [features/Comments.md](./features/Comments.md) |
| What JSON does a failure return? | [engineering/API_ERROR_CONTRACT.md](./engineering/API_ERROR_CONTRACT.md) · [features/Error_Handling.md](./features/Error_Handling.md) |
| How is the OpenAPI spec produced? | [features/API_Documentation.md](./features/API_Documentation.md) |
| Schema, indexes, migrations, SQLite caveats | [engineering/DATABASE.md](./engineering/DATABASE.md) |
| Layer boundaries, dependency direction | [engineering/ARCHITECTURE.md](./engineering/ARCHITECTURE.md) |
| In what order is this being built, and what is done? | [engineering/IMPLEMENTATION_PLAN.md](./engineering/IMPLEMENTATION_PLAN.md) |
| What did a stage defer, and what is the known perf debt? | [engineering/BUILD_LOG.md](./engineering/BUILD_LOG.md) |
| What env var controls X? | [engineering/ENVIRONMENT_VARIABLES.md](./engineering/ENVIRONMENT_VARIABLES.md) |
| How do I test this / what must a test cover? | [engineering/TESTING.md](./engineering/TESTING.md) |
| Spacing, breakpoints, states, colors | [engineering/UI_DESIGN_GUIDELINES.md](./engineering/UI_DESIGN_GUIDELINES.md) |
| How do I run it in Docker? | [operations/DOCKER.md](./operations/DOCKER.md) |
| What does the seed generate? | [features/Seed_Data.md](./features/Seed_Data.md) |

## Conventions

1. **`pages/`** — One file per UI route. Filename ≈ PascalCase screen name (`Ticket_Detail.md` → `/tickets/:ticketId`). Cross-link the `features/` docs it depends on. Index: [pages/README.md](./pages/README.md).
2. **`features/`** — Domain behavior, data model, API contract, invariants. **Prefer updating the feature doc when changing business rules** — the page doc describes presentation, the feature doc describes truth.
3. **`engineering/`** — Cross-cutting technical reference. Keep `ENVIRONMENT_VARIABLES.md` in sync with `apps/api/env.example` and `apps/web/env.example`.
4. **`operations/`** — How it runs locally, in Docker, and in CI.

### Frontmatter (`pages/` + `features/` only)

```yaml
---
type: Page          # or Feature
title: Ticket detail
description: Read-only detail view with comments at /tickets/:ticketId
resource: apps/web/src/pages/ticket-detail/   # code path this doc describes
tags: [tickets, detail, comments]
status: canonical   # canonical | plan
---
```

| `status` | Meaning |
| -------- | ------- |
| *(omit)* / `canonical` | Runtime source of truth — update it when behavior changes |
| `plan` | Design / roadmap — confirm in code before implementing |

Keep frontmatter accurate when you create or materially edit a doc, and add new files to the folder README.

### Page doc body (preferred shape)

1. **Route** — URL, router entry, page component, render type
2. **Dependencies** — components used, API calls (with method + path)
3. **Behavior / UI flow** — what the screen does, in the order a user hits it
4. **States** — loading, empty, error, validation, success
5. **Responsive** — what changes below `md`
6. **Accessibility** — labels, focus, keyboard
7. **Related** — links to `features/` and sibling pages

### Feature doc body (preferred shape)

1. **Overview** — table of concerns → code paths
2. **Rules / data model** — invariants agents must not break
3. **API** — endpoints, params, payloads, error codes
4. **Related pages** — `docs/pages/` links

## Search order (recommended)

1. This file's routing table
2. [pages/README.md](./pages/README.md) or [features/README.md](./features/README.md)
3. Grep `docs/` for the route segment, field name, or error code
4. Source: `packages/contracts/src/` → `apps/api/src/services/` → `apps/api/src/routes/` → `apps/web/src/pages/`
5. Tests: `apps/api/src/**/*.test.ts`, `apps/web/src/**/*.test.tsx`, `e2e/`

Reading contracts first is usually the fastest route to an answer — the whole API surface is ~200 lines of zod.

## Required practices (always)

### Change contracts before code

A field added to a response starts in `packages/contracts`. Adding it only to the Prisma model and the Express handler leaves the web app untyped and silently drifting.

### Always create a Prisma migration

Any edit to `apps/api/prisma/schema.prisma` ships with a new folder under `apps/api/prisma/migrations/` in the same change set. SQLite migrations are cheap; skipping them breaks `docker compose up` on a clean volume.

### Never bypass the error envelope

Throw a typed `ApiError` (or let a zod parse fail) and let `middleware/errorHandler.ts` format it. Ad-hoc error responses break the client's `error.code` branching.

### Keep the three async states

Any new data-driven view needs loading, error (with a retry affordance), and empty handling. This is graded work — an unhandled empty list reads as an unfinished feature.

### Validate on both sides

The client validates for UX (inline field errors, disabled submit); the server validates for correctness. Reuse the **same** zod schema from `packages/contracts` in both places — do not write a second set of rules in the form.

## After code changes

- Update the matching `pages/` or `features/` doc if behavior, routes, or params changed.
- New env var → `engineering/ENVIRONMENT_VARIABLES.md` + the relevant `env.example`.
- New endpoint or changed payload → register the path in the matching `apps/api/src/routes/*.openapi.ts` (a route with no entry fails `openapi.contract.test.ts`), then regenerate with `pnpm --filter @helpdesk/api openapi:gen` and commit `openapi.json`. **Do not add OpenAPI metadata to a contract schema** — it is applied from `apps/api` with zod's `.meta()`, because `packages/contracts` may depend on nothing but zod.
- New error code → add it to `engineering/API_ERROR_CONTRACT.md`'s table.

## Out of scope for `docs/`

- The brief itself: [../instructions.md](../instructions.md) — historical, do not edit.
- Human setup instructions: [../README.md](../README.md).
