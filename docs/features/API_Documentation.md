---
type: Feature
title: API documentation (OpenAPI)
description: Generating the OpenAPI spec from the zod contracts and serving Swagger UI at /docs.
resource: apps/api/src/lib/openapi.ts
tags: [api, docs, openapi]
status: canonical
---
# API documentation (OpenAPI)

## Overview

| Concern | Location |
| ------- | -------- |
| Registry, components, error responses, `X-Actor` header, bearer scheme | `apps/api/src/lib/openapi.ts` |
| Path registration | `apps/api/src/routes/{tasks,comments,system}.openapi.ts` |
| Composition (the one place those are imported) | `apps/api/src/openapi.ts` |
| `/docs` router | `apps/api/src/routes/docs.route.ts` |
| Generated artifact | `apps/api/openapi.json` — **committed** |
| Generator script | `pnpm --filter @helpdesk/api openapi:gen` |
| Swagger UI | `GET /docs` |
| Raw spec | `GET /docs/openapi.json` |

## How it works

`@asteasolutions/zod-to-openapi` annotates the zod schemas in `packages/contracts` from **`apps/api`** — it peers `zod ^4`, so nothing is added to the contracts package, whose hard constraint is "zod and nothing else". Route modules register their path definitions into a shared `OpenAPIRegistry`, and the generator walks it into an OpenAPI 3.1 document.

The point of generating rather than hand-writing: the spec cannot describe a response shape the code does not actually return, because both come from the same schema object.

**Metadata is attached with zod 4's native `.meta({ id, description })`, not the library's `.openapi()`.** `.openapi()` arrives by monkey-patching `ZodType.prototype` in `extendZodWithOpenApi()`, and in zod 4 a schema constructed *before* that call never picks the method up — every contract schema is constructed at import time, so `registry.register()` fails with `zodSchema.openapi is not a function` wherever the extension call is placed. The library documents `.meta()` as equivalent, and it returns a clone rather than mutating a schema the validators share.

A schema becomes a **named component** only where it is the schema handed to `registerPath` at a request or response boundary. `TaskSummary` appears inlined inside `PaginatedTasks` for that reason. The shape is still exact; only the `$ref` is missing.

The list query's parameters are read off `taskListQuerySchema` itself — it is a `z.preprocess(...)`, so the parameter definitions live on its output side and are unwrapped rather than retyped. Descriptions are attached *in place*, field by field, so the bounds, defaults, and enums the validator enforces survive into the spec. `sort` is the single exception: its validated type (`{ field, direction }`) is not its wire type (`"createdAt:desc"`), so it is overridden explicitly.

## Request headers and security

**Every `/api/v1` operation documents `X-Actor`** (optional, defaults to `human:anonymous`) and an **optional** `bearerAuth` security requirement — `{}` is listed as an alternative, so the spec is honest that the token is only enforced when `API_TOKEN` is set. See [Actors.md](./Actors.md). A 401 `UNAUTHORIZED` response is attached to every operation for the same reason, and every 422 description notes that a malformed `X-Actor` is checked before the rest of the body.

## Tags

`Tasks` (CRUD, filter, sort, page), `Workflow` (transitions, claims/leases, `next`, decisions, dependencies), `Comments`, `Events` (the cursor-paged change feed), `System` (health, the unmatched-route synthetic path).

## Rules

- **Every route is registered.** A new endpoint without a registry entry fails `apps/api/src/routes/openapi.contract.test.ts`, which asserts that the set of mounted Express operations equals the set of documented ones, in both directions. Express 5 does not expose a mounted router's prefix, so `app.ts` exports `ROUTER_MOUNTS` as data and the test walks that.
- **`openapi.json` is committed and must be regenerated** in the same change set as any contract change. CI runs the generator and fails if the working tree is dirty afterwards.
- Examples in the spec use the same fixture data as the seed, so what a reader sees in Swagger matches what they see running the app.
- Error responses are documented per endpoint with the concrete `code` values that endpoint can emit — a generic "500 Error" entry is not sufficient. Every operation also carries a `default` response referencing the full `ErrorResponse` envelope; the coverage test ignores it deliberately, since counting it would make the check pass no matter what the per-operation responses said.
- **`NOT_FOUND` has no operation to belong to.** It comes from the `notFound` middleware rather than any handler, so it is documented on a synthetic path, `GET /api/v1/{unmatchedPath}`, describing what the API does with a request that matches nothing. The contract test knows that one path is synthetic and excludes it from the route comparison; anything else appearing in that exclusion list is a bug.

## What the spec covers

- Every task and workflow endpoint, both comment endpoints, `GET /events`, `GET /health`, and the catch-all — 17 paths, 20 operations, 12 named components (regenerate and check `apps/api/openapi.json` for the current count; it moves as endpoints are added).
- Paths are written in **full** (`/api/v1/tasks`) with the server at the origin root, rather than relative to a `/api/v1` server entry: `GET /health` sits outside the version prefix and a `/api/v1` server URL could not describe it.
- Every list query parameter with type, default, bounds, and enum values.
- The pagination envelope and the error envelope as named components (`PaginatedTasks`, `ErrorResponse`).
- Status codes per endpoint including the failure ones.

## Swagger UI

Served from the API at `/docs`, which is **always open** regardless of `API_TOKEN` — the gate applies only to `/api/v1`. "Try it out" against a token-protected server still needs the bearer token entered in Swagger UI's Authorize dialog. It is enabled in all environments; `DOCS_ENABLED=false` turns it off, and when it is off the document is never generated and `/docs` is an ordinary 404 `NOT_FOUND`. The README links to it as the API reference rather than duplicating endpoint tables in prose.

The page serves the document **generated at runtime**, not the committed `openapi.json` — that keeps "the spec cannot describe a shape the code does not return" true of the page a reader is actually looking at, and avoids resolving a repo-relative path from inside `dist/`. The contract test asserts the committed file still matches, so the two cannot drift apart unnoticed.

Swagger UI's assets are bundled (`swagger-ui-dist`, ~11 MB) rather than loaded from a CDN: a container has no guarantee of outbound network access, and a docs page that renders blank offline is worse than no docs page. `swagger-ui-express` and `@asteasolutions/zod-to-openapi` are therefore **runtime** dependencies — noted for the Docker image in stage 14.

## Related

- [Validation_And_Contracts.md](./Validation_And_Contracts.md) — where the schemas live
- [Tasks.md](./Tasks.md), [Comments.md](./Comments.md) — the endpoints themselves
- [../engineering/API_ERROR_CONTRACT.md](../engineering/API_ERROR_CONTRACT.md)
