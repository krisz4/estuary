---
type: Feature
title: Validation and shared contracts
description: packages/contracts as the single source of truth for API shapes, validation, and types.
resource: packages/contracts/src/
tags: [contracts, validation, types, zod]
status: canonical
---
# Validation and shared contracts

## Overview

| Concern | Location |
| ------- | -------- |
| Ticket shapes + enums (`TicketStatus`, `TicketPriority`, `TicketCategory`) | `packages/contracts/src/ticket.ts` |
| List query schema | `packages/contracts/src/ticket-query.ts` |
| Comment shapes | `packages/contracts/src/comment.ts` |
| Error envelope + code union | `packages/contracts/src/errors.ts` |
| Pagination envelope helper | `packages/contracts/src/pagination.ts` |
| Reference format/parse | `packages/contracts/src/reference.ts` |

## Why it exists

The API and the web app must agree on every shape. Two hand-written copies of "what a ticket looks like" drift within days. Here, one zod schema produces:

1. **Server validation** — `schema.parse(req.body)` at the route edge.
2. **Server + client types** — `type Ticket = z.infer<typeof ticketSchema>`.
3. **Client form validation** — the same schema drives the react-hook-form resolver, so the inline field errors match what the server would say.
4. **OpenAPI** — schemas carry `.openapi()` metadata and are registered into the generated spec. See [API_Documentation.md](./API_Documentation.md).

Change a rule once, and all four move together.

## Hard constraints on this package

- **No runtime dependencies beyond zod.** No Express, no Prisma, no React, no `node:*` imports. It is bundled into browser code; a stray `import fs` breaks the Vite build with an error that points nowhere useful.
- **No Prisma types re-exported.** The Prisma model and the wire shape are allowed to differ (e.g. `statusRank` and `priorityRank` are DB-only and never serialized). Deriving one from the other couples the API surface to storage.
- Schemas are exported as both the schema and the inferred type: `ticketSchema` / `Ticket`.

## Naming pattern

| Suffix | Meaning |
| ------ | ------- |
| `…Schema` | The zod schema |
| `…Input` | Client → server payload (`createTicketInput`, `updateTicketInput`) |
| `…Query` | Query-string shape |
| Bare noun | Server → client response (`ticketSchema`, `ticketSummarySchema`) |

`ticketSummarySchema` (list rows) is `ticketSchema.omit({ comments: true })`. Derive, don't retype.

## Validation rules that live here

Length bounds, enum membership, email format, date coercion, page bounds, sort-field whitelist. Rules requiring a DB read — "does this ticket exist", "is this transition legal given the current status" — belong in the service layer, not in zod. The dividing line: **zod validates the request in isolation; services validate against state.**

## Coercion and normalization

Query strings are all strings, so the query schema uses `z.coerce.number().int()` for `page`/`pageSize` and a preprocessor that wraps single values into arrays for the repeatable filters (`status`, `priority`, `category`). Body schemas do **not** coerce — a JSON body sending `"page": "2"` is a client bug and should say so.

Two normalizations are load-bearing rather than cosmetic:

| Rule | Why |
| ---- | --- |
| **Empty query values are dropped before parsing** (`?page=` behaves as absent) | `z.coerce.number()` turns `""` into `0`, which then fails `min(1)` and 422s a request the user never meant to make. Forms and link builders emit empty params constantly |
| **Optional strings transform `""` → `null`** (`assignee`, `category`) | Otherwise clearing a field in the edit form stores an empty string, and that ticket matches neither `assigneeIsNull=true` nor any name filter — it disappears from every assignee view |

`requesterEmail` is lowercased and trimmed in the schema, not in the service, so the API and the client agree on the canonical value that exact-match filtering compares against.

## `.strict()` — and the one place it must not be used

`.strict()` is set on every object schema, so unknown keys are rejected rather than silently stripped. That is right for a request body and for query parsing **on the server**.

It is wrong for parsing the browser's URL. `useTicketListParams()` **picks the keys it knows** out of `useSearchParams()` and parses only those. If it fed the raw params into the strict schema, a shared link carrying `?utm_source=slack` would fail the whole parse and silently reset every filter the recipient was meant to see. Unknown keys are ignored client-side and never forwarded; the server stays strict about what actually arrives.

## Related

- [Error_Handling.md](./Error_Handling.md) — how a failed parse becomes a response
- [../engineering/API_ERROR_CONTRACT.md](../engineering/API_ERROR_CONTRACT.md)
