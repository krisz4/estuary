# Architecture

Monorepo layout, layer boundaries, request lifecycle, and the decisions behind them.

## Workspace layout

```
helpdesk/
├── apps/
│   ├── api/                  @helpdesk/api    — Node 20 + Express 5 + Prisma (SQLite)
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   ├── migrations/
│   │   │   ├── seed.ts
│   │   │   └── data/helpdesk.db      (gitignored)
│   │   ├── src/
│   │   │   ├── routes/       HTTP layer — validate, call service, respond
│   │   │   ├── services/     Business logic + all Prisma access
│   │   │   ├── middleware/   requestId, errorHandler, notFound
│   │   │   ├── lib/          prisma, errors, openapi, serialize, logger
│   │   │   ├── app.ts        Express app factory (no listen — tests import this)
│   │   │   └── server.ts     Binds the port
│   │   └── openapi.json      Generated, committed
│   └── web/                  @helpdesk/web    — React 19 + Vite + TS
│       └── src/
│           ├── pages/        One folder per route (docs/pages/)
│           ├── features/     Ticket-domain components
│           ├── components/   Shared presentational (ui/ = primitives)
│           ├── api/          Typed fetch client + query hooks + queryKeys
│           └── lib/          formatting, cn(), url helpers
├── packages/
│   ├── contracts/            @helpdesk/contracts — zod schemas + types
│   └── tsconfig/             shared tsconfig bases
├── e2e/                      Playwright specs
├── docker-compose.yml
├── turbo.json
└── pnpm-workspace.yaml
```

## Dependency direction

```
apps/api ─┐
          ├──► packages/contracts   (no reverse edges, ever)
apps/web ─┘
```

`apps/api` and `apps/web` never import each other. `packages/contracts` imports nothing but zod.

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
cannot read `x-request-id` off the response to quote back. A ticket description over `BODY_LIMIT` is
the realistic way a user reaches it. This diagram specified the opposite order until stage 4
demonstrated the consequence; `apps/api/src/app.test.ts` now pins it.

Detail: [../features/Error_Handling.md](../features/Error_Handling.md).

## Web data flow

```
URL search params ──► useTicketListParams() ──► typed params
                                                    │
                                                    ▼
                                        useTicketsQuery(params)
                                        key: queryKeys.tickets.list(params)
                                                    │
                                                    ▼
                                        api/http.ts fetch ──► /api/v1/tickets
```

Server state lives only in TanStack Query; list state lives only in the URL. Nothing is mirrored into `useState` — a second copy is a second thing to keep in sync, and the bug it produces (stale filters after back-navigation) is hard to spot in review.

Mutations invalidate through `queryKeys`, never inline key arrays.

## Key decisions

| Decision                                     | Why                                                                                                                       | Cost accepted                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Monorepo with a shared contracts package** | Only way to guarantee the API and UI agree on shapes without codegen ceremony                                             | Slightly more setup than two folders                                                                     |
| **SQLite + Prisma**                          | SQLite means a reviewer runs `docker compose up` with no external service. Prisma gives real migrations and typed queries | Single-writer concurrency, no native enums, no `mode: "insensitive"`                                     |
| **Integer PK doubling as the ticket number** | Prisma's SQLite connector only allows `autoincrement()` on the `@id` field, so cuid-plus-counter does not compile — and with no auth there is nothing enumeration could expose | Sequential ids are visible in URLs; revisit if auth is ever added ([Ticket_Numbering.md](../features/Ticket_Numbering.md)) |
| **Express over Fastify/Nest**                | Reviewers read Express without a manual; Nest's structure would dwarf a five-endpoint API                                 | Manual async error plumbing (one wrapper)                                                                |
| **Vite SPA over Next.js**                    | No SSR need, no auth, no SEO surface. Keeps the API as the only backend                                                   | No server rendering                                                                                      |
| **Offset paging**                            | UI needs jump-to-page and a total; dataset is tiny                                                                        | Would not scale past ~100k rows                                                                          |
| **Integer rank columns for status/priority** | SQLite cannot order a text column by severity                                                                             | Must be recomputed on every write — see [../features/Ticket_Priority.md](../features/Ticket_Priority.md) |
| **Hard delete**                              | Brief asks for delete; soft delete leaks a `deletedAt` filter into every query                                            | Deletion is irreversible; UI confirms                                                                    |
| **No auth**                                  | Explicitly excluded by the brief                                                                                          | —                                                                                                        |

## Testing seams

- `app.ts` exports a factory and does **not** call `listen()` — supertest imports it directly.
- The Prisma client is created in `lib/prisma.ts` from `DATABASE_URL` **at import time**, so tests must set that variable in a `setupFiles` entry, not in a `beforeAll` — by the time hooks run, the client is already bound to the dev database.
- Services take no globals, so they can be unit-tested against a temp DB with no HTTP layer.

See [TESTING.md](./TESTING.md).

## Related

- [DATABASE.md](./DATABASE.md)
- [API_ERROR_CONTRACT.md](./API_ERROR_CONTRACT.md)
- [../AGENTS.md](../AGENTS.md)
