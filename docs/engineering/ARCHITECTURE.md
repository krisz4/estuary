# Architecture

Monorepo layout, layer boundaries, request lifecycle, and the decisions behind them.

## Workspace layout

```
helpdesk/
├── apps/
│   ├── api/                  @helpdesk/api    — Node 24 + Express 5 + Prisma (SQLite)
│   │   ├── prisma/
│   │   │   ├── schema.prisma          schema + migrations only — the seed lives under src/
│   │   │   ├── migrations/
│   │   │   └── data/helpdesk.db      (gitignored)
│   │   ├── src/
│   │   │   ├── routes/       HTTP layer — validate, call service, respond
│   │   │   ├── services/     Business logic + all Prisma access (task, task-workflow, task-query,
│   │   │   │                 task-guards, task-status, task-events, comment)
│   │   │   ├── middleware/   requestId, errorHandler, notFound, actor, apiToken
│   │   │   ├── lib/          prisma (incl. the write queue), env, errors, params, pagination,
│   │   │   │                 openapi, serialize, logger
│   │   │   ├── seed/         Seed script + fixture pools (under src/, not prisma/)
│   │   │   ├── openapi.ts    Composes the registry from routes/*.openapi.ts
│   │   │   ├── app.ts        Express app factory (no listen — tests import this)
│   │   │   └── server.ts     Binds the port
│   │   └── openapi.json      Generated, committed
│   ├── web/                  @helpdesk/web    — React 19 + Vite + TS
│   │   └── src/
│   │       ├── pages/        One folder per route (docs/pages/)
│   │       ├── features/     Task-domain components
│   │       ├── components/   Shared presentational (ui/ = primitives)
│   │       ├── api/          Typed fetch client + query hooks + queryKeys
│   │       ├── stores/       zustand — client-only preferences (taskView, projectScope, session)
│   │       └── lib/          formatting, cn(), url helpers
│   └── mcp/                  @helpdesk/mcp    — stdio MCP server, thin client over the REST API
│       └── src/
│           ├── tools.ts      Tool surface (task_list, task_next, task_transition, …)
│           ├── api-client.ts HTTP client (X-Actor, bearer token)
│           ├── format.ts     Text formatting for tool results
│           └── config.ts     Env parsing (TASKS_*)
├── integrations/
│   └── claude-code/          Claude Code plugin: marketplace, `task-workflow` skill,
│                             SessionStart hook — wraps apps/mcp for use in other repos
├── packages/
│   ├── contracts/            @helpdesk/contracts — zod schemas + types
│   └── tsconfig/             shared tsconfig bases
├── e2e/                      Playwright specs
├── .mcp.json                 Registers apps/mcp as a project MCP server for this repo
├── docker-compose.yml
├── turbo.json
└── pnpm-workspace.yaml
```

## Dependency direction

```
apps/api ─┐
apps/web ─┼──► packages/contracts   (no reverse edges, ever)
apps/mcp ─┘
```

`apps/api`, `apps/web`, and `apps/mcp` never import each other. `apps/mcp` talks to `apps/api` only over HTTP, never Prisma — it can run against a self-hosted server with no access to the database file. `packages/contracts` imports nothing but zod.

The seed sits at `src/seed/` rather than `prisma/` because `tsconfig.build.json` sets `rootDir: "src"` and the runtime image runs the *compiled* seed — `tsx` is not installed there. A file outside `rootDir` cannot be compiled into `dist/` at all. See [../features/Seed_Data.md](../features/Seed_Data.md).

The contracts package is bundled into browser code, so it must stay runtime-agnostic: no Express, no Prisma, no React, no `node:*`. A stray `node:crypto` import surfaces as a Vite build error that points at a transitive file and wastes an hour.

## API layers

| Layer         | May import                              | Must not                      |
| ------------- | --------------------------------------- | ----------------------------- |
| `routes/`     | contracts, services, `lib/` helpers     | Prisma                        |
| `services/`   | contracts, `lib/prisma`, other services | `req` / `res` / Express types |
| `lib/`        | contracts, third-party                  | services, routes              |
| `middleware/` | contracts, `lib/errors`                 | services                      |

The rule that matters: **routes do not touch Prisma, services do not touch HTTP.** That is what makes services testable without booting a server, and it is the boundary a reviewer checks first. `apps/api/src/routes/layers.test.ts` asserts both halves against the source text, so the rule fails a test run rather than a code review.

The `lib/` helpers a route uses are `asyncHandler` (the local one-liner, not the `express-async-handler` package), `params` (path-parameter parsing, where a malformed id becomes a 404 rather than a 422), and the `errors` factories.

### Writes: the queue, the events feed, and claims

Every interactive write goes through `writeTransaction()` in `lib/prisma.ts`, which serializes writers **in process** — SQLite's interactive transactions deadlock rather than queue when two both read then try to write. `POST /tasks/next`'s conditional claim update runs through it too, together with its events. Full reasoning and the failure it prevents: [DATABASE.md § Concurrent writes](./DATABASE.md#concurrent-writes).

Every write — task, comment, transition, claim, dependency, decision — also appends a row to `TaskEvent` in the **same transaction**, via `recordEvent()` in `services/task-events.ts`. `GET /events` is a cursor feed over that table (oldest first, `after=<id>`), and `taskId` is deliberately not a foreign key so the feed still describes a task after it is deleted. This is what lets the Claude Code plugin's SessionStart hook and any polling agent see "what happened since I last looked" without re-diffing the whole task list. See [../features/Task_Workflow_API.md § Events](../features/Task_Workflow_API.md#events).

### Request lifecycle

```
request
  → requestId          attach x-request-id (incoming or generated)
  → cors               ALLOWED_ORIGINS
  → json body parser   1MB limit
  → router             zod-parse params/query/body  ─┐ throws ZodError
  → service            business rules + Prisma       ─┤ throws ApiError
      └─ serialize     Date → ISO, add `reference`   ─┘ (inside the service)
  → res.json           whatever the service returned  │
  → notFound (unmatched path or verb → 404)           │
  → errorHandler ◄──────────────────────────────────── (single exit for all failures)
```

**`cors` precedes the body parser, and the order is load-bearing.** When `express.json()` rejects a
body it calls `next(err)`, which skips every remaining non-error middleware — so with `cors` mounted
after it, `MALFORMED_JSON` and `PAYLOAD_TOO_LARGE` are sent with no `Access-Control-Allow-Origin`
header. A browser turns those into opaque network errors: the web client never sees the code, and
cannot read `x-request-id` off the response to quote back. A task description over `BODY_LIMIT` is
the realistic way a user reaches it. This diagram specified the opposite order until stage 4
demonstrated the consequence; `apps/api/src/app.test.ts` now pins it.

Detail: [../features/Error_Handling.md](../features/Error_Handling.md).

## Web data flow

```
URL search params ──► useTaskListParams() ──► typed params
                                                    │
                                                    ▼
                                        useTasksQuery(params)
                                        key: queryKeys.tasks.list(params)
                                                    │
                                                    ▼
                                        api/http.ts fetch ──► /api/v1/tasks
```

Server state lives only in TanStack Query; list state lives only in the URL. Nothing is mirrored into `useState` — a second copy is a second thing to keep in sync, and the bug it produces (stale filters after back-navigation) is hard to spot in review.

Mutations invalidate through `queryKeys`, never inline key arrays.

**Client state is the third bucket, and `src/stores/` (zustand) is the only place it lives.** It holds what is neither the server's nor the URL's: a preference belonging to this user on this machine, which no other screen can reconstruct. Today that is `stores/taskView.ts`, the list ⇄ map choice, persisted to `localStorage` so a task opened from the map returns to the map (a previously-stored Kanban-board preference migrates to the map — the board itself is retired); `stores/projectScope.ts`, the last single project the list, map, or inbox URL selected, so the header keeps its project on screens without a filter URL (it follows the URL and never overrides it); and `stores/session.ts`, the display name and API token. The bar for adding a second one is the same test: if pasting the URL into another browser should reproduce it, it is URL state and does not belong here.

## Key decisions

| Decision                                     | Why                                                                                                                       | Cost accepted                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Monorepo with a shared contracts package** | Only way to guarantee the API and UI agree on shapes without codegen ceremony                                             | Slightly more setup than two folders                                                                     |
| **SQLite + Prisma**                          | SQLite means a reviewer runs `docker compose up` with no external service. Prisma gives real migrations and typed queries | Single-writer concurrency, no native enums, no `mode: "insensitive"`                                     |
| **Integer PK doubling as the task number** | Prisma's SQLite connector only allows `autoincrement()` on the `@id` field, so cuid-plus-counter does not compile — and with no auth there is nothing enumeration could expose | Sequential ids are visible in URLs; revisit if auth is ever added ([Task_Numbering.md](../features/Task_Numbering.md)) |
| **Express over Fastify/Nest**                | Reviewers read Express without a manual; Nest's structure would dwarf an eight-endpoint API                                 | Manual async error plumbing (one wrapper)                                                                |
| **Vite SPA over Next.js**                    | No SSR need, no auth, no SEO surface. Keeps the API as the only backend                                                   | No server rendering                                                                                      |
| **Offset paging**                            | UI needs jump-to-page and a total; dataset is tiny                                                                        | Would not scale past ~100k rows                                                                          |
| **Integer rank columns for status/priority** | SQLite cannot order a text column by severity                                                                             | Must be recomputed on every write — see [../features/Task_Priority.md](../features/Task_Priority.md) |
| **Hard delete**                              | Brief asks for delete; soft delete leaks a `deletedAt` filter into every query                                            | Deletion is irreversible; UI confirms                                                                    |
| **Attribution instead of auth**              | No accounts; `X-Actor` self-declares who is acting, `API_TOKEN` is an optional shared-secret gate for self-hosting        | Nothing verifies an actor's claimed identity — see [../features/Actors.md](../features/Actors.md)        |
| **MCP server as a thin HTTP client**         | Keeps every rule (claims, versions, transition payloads) in one place — the API — rather than duplicated in `apps/mcp`     | An extra network hop per agent tool call; the MCP server cannot work offline from the API                |

## Testing seams

- `app.ts` exports a factory and does **not** call `listen()` — supertest imports it directly.
- The Prisma client is created in `lib/prisma.ts` from `DATABASE_URL` **at import time**, so tests must set that variable in a `setupFiles` entry, not in a `beforeAll` — by the time hooks run, the client is already bound to the dev database.
- Services take no globals, so they can be unit-tested against a temp DB with no HTTP layer.

See [TESTING.md](./TESTING.md).

## Related

- [DATABASE.md](./DATABASE.md)
- [API_ERROR_CONTRACT.md](./API_ERROR_CONTRACT.md)
- [../AGENTS.md](../AGENTS.md)
