---
type: Feature
title: API documentation (OpenAPI)
description: Generating the OpenAPI spec from the zod contracts and serving Swagger UI at /docs.
resource: apps/api/src/lib/openapi.ts
tags: [api, docs, openapi, bonus]
status: canonical
---
# API documentation (OpenAPI)

Bonus item 1 of the brief.

## Overview

| Concern | Location |
| ------- | -------- |
| Registry + document builder | `apps/api/src/lib/openapi.ts` |
| Schema registration | `apps/api/src/routes/*.openapi.ts` (one per router) |
| Generated artifact | `apps/api/openapi.json` — **committed** |
| Generator script | `pnpm --filter @helpdesk/api openapi:gen` |
| Swagger UI | `GET /docs` |
| Raw spec | `GET /docs/openapi.json` |

## How it works

`@asteasolutions/zod-to-openapi` extends the zod schemas in `packages/contracts` with `.openapi()` metadata (descriptions, examples, format hints). Route modules register their path definitions into a shared `OpenAPIRegistry`, and the generator walks it into an OpenAPI 3.1 document.

The point of generating rather than hand-writing: the spec cannot describe a response shape the code does not actually return, because both come from the same schema object.

## Rules

- **Every route is registered.** A new endpoint without a registry entry fails the `openapi:contract` test, which asserts that the set of Express routes equals the set of documented paths.
- **`openapi.json` is committed and must be regenerated** in the same change set as any contract change. CI runs the generator and fails if the working tree is dirty afterwards.
- Examples in the spec use the same fixture data as the seed, so what a reader sees in Swagger matches what they see running the app.
- Error responses are documented per endpoint with the concrete `code` values that endpoint can emit — a generic "500 Error" entry is not sufficient.

## What the spec covers

- All five ticket endpoints, both comment endpoints, and `GET /health`.
- Every list query parameter with type, default, bounds, and enum values.
- The pagination envelope and the error envelope as named components (`PaginatedTickets`, `ErrorResponse`).
- Status codes per endpoint including the failure ones.

## Swagger UI

Served from the API at `/docs`, no auth (there is no auth in this product). It is enabled in all environments; `DOCS_ENABLED=false` turns it off if that is ever wanted. The README links to it as the API reference rather than duplicating endpoint tables in prose.

## Related

- [Validation_And_Contracts.md](./Validation_And_Contracts.md) — where the schemas live
- [Tickets.md](./Tickets.md), [Comments.md](./Comments.md) — the endpoints themselves
- [../engineering/API_ERROR_CONTRACT.md](../engineering/API_ERROR_CONTRACT.md)
