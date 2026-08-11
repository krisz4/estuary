---
type: Feature
title: Error handling
description: How failures are raised on the server, shaped into the envelope, and surfaced in the UI.
resource: apps/api/src/middleware/errorHandler.ts
tags: [errors, api, ux, reliability]
status: canonical
---
# Error handling

Bonus item 2 of the brief. The contract table lives in [../engineering/API_ERROR_CONTRACT.md](../engineering/API_ERROR_CONTRACT.md); this doc is the behavior around it.

## Overview

| Concern | Location |
| ------- | -------- |
| `ApiError` class + factories | `apps/api/src/lib/errors.ts` |
| Central handler | `apps/api/src/middleware/errorHandler.ts` |
| Request id | `apps/api/src/middleware/requestId.ts` |
| 404 fallthrough | `apps/api/src/middleware/notFound.ts` |
| Client normalizer | `apps/web/src/api/http.ts` (`ApiClientError`) |
| Error boundary | `apps/web/src/components/ErrorBoundary.tsx` |

## Server

**One exit path.** Services and routes `throw` — they never build an error response. `errorHandler` is the single place that turns a thrown value into JSON:

| Thrown | Becomes |
| ------ | ------- |
| `ApiError` | Its own code + status |
| `ZodError` | `VALIDATION_ERROR` 422, `details` = flattened field errors |
| body-parser error, `err.type === "entity.parse.failed"` | `MALFORMED_JSON` 400 |
| body-parser error, `err.type === "entity.too.large"` | `PAYLOAD_TOO_LARGE` 413 |
| `PrismaClientKnownRequestError` `P2025` (record not found) | `NOT_FOUND` 404 — generic fallback |
| Anything else | `INTERNAL_ERROR` 500 |

### Resource-specific 404s come from services, not from Prisma codes

The handler cannot tell whether a `P2025` was a missing ticket or a missing comment — it has no request context — so **services check existence explicitly and throw the specific error**:

- `PATCH`/`DELETE /tickets/:id` → `findUnique` first, throw `TICKET_NOT_FOUND`.
- `POST /tickets/:id/comments` → `findUnique` on the ticket first. A missing parent raises **`P2003`** (foreign key constraint failed), not `P2025`, so without the check this path would return 500 rather than the documented 404.
- `DELETE …/comments/:commentId` → `deleteMany` scoped by both ids, zero count → `COMMENT_NOT_FOUND`.

The `P2025` → `NOT_FOUND` mapping is a backstop for paths that forgot to check, not the intended route to a 404.

Prisma `P2002` (unique constraint) is deliberately **not** mapped to a client-facing code. The only unique columns are server-generated primary keys, so a `P2002` here is a server bug, not a client mistake: it falls through to `INTERNAL_ERROR` and is logged loudly. If a user-settable unique column is ever added, add a `CONFLICT` code at the same time.

**Unknown errors never leak.** For a 500 the response carries a generic message and the `requestId`; the stack goes to the server log, keyed by the same id, so a report of "request 8f2c-… failed" is traceable without exposing internals.

The body-parser rows matter more than they look: without them, posting malformed JSON or an oversized body returns **500** while the error contract advertises 400 and 413. Those errors are `http-errors` instances carrying a `type` string ([body-parser docs](https://github.com/expressjs/body-parser#errors)) — branch on `err.type`, not on the message.

Every request gets a `requestId` (incoming `x-request-id` if present, else a uuid), echoed in the response header and inside `error.requestId`.

`async` route handlers are wrapped in `asyncHandler()` — Express 5 forwards rejected promises, but the wrapper keeps the behavior explicit and survives a downgrade.

### Proving the 500 path

`app.ts` mounts two diagnostic routes, `GET /__test__/boom` (synchronous `throw`) and `GET /__test__/boom-async` (rejected promise), **only when `NODE_ENV=test`**. They are the sole way to exercise the guarantee that matters most here — that an unhandled error returns a generic 500 and leaks no stack trace — without monkey-patching a real route, which would test the patch rather than the chain. Both variants exist because a sync throw and a rejected promise reach the handler by different routes through Express 5. They are absent from a development or production process; a request to either returns the ordinary `NOT_FOUND` 404.

## Client

`http.ts` parses every non-2xx response into an `ApiClientError { code, message, details, requestId, status }`. Components branch on `code`, never on message text.

| Situation | UI response |
| --------- | ----------- |
| `VALIDATION_ERROR` on a form submit | Map `details` onto the form fields; focus the first invalid one. No toast — the errors are already on screen |
| `TICKET_NOT_FOUND` on a detail/edit route | Render the "ticket not found" state with a link back to the list, not a toast over a blank page |
| `INVALID_STATUS_TRANSITION` | Inline message next to the status control, listing the allowed targets from `details.allowed` |
| Any error on a mutation | Destructive toast; **the form keeps its values** |
| Any error on a query | In-place error panel with a Retry button calling `refetch()` — never `window.location.reload()` |
| Network failure / API down | Same error panel, message "Can't reach the server", retry enabled |
| Unexpected render crash | `ErrorBoundary` at the route level with a reload affordance |

Toasts show the `requestId` in small text on 500s so a user can quote it.

## Retries

TanStack Query retries **queries** twice with backoff, and only for network errors and 5xx — a 404 or 422 is not retried. **Mutations are never auto-retried**: a retried `POST /tickets` creates two tickets.

## What must not happen

- No `res.status(500).json({ message })` outside the handler.
- No `catch (e) { console.log(e) }` that swallows a failure and returns 200.
- No error text rendered from a caught exception's raw `message` in the UI — use the mapped copy.

## Related

- [../engineering/API_ERROR_CONTRACT.md](../engineering/API_ERROR_CONTRACT.md) — code table
- [Validation_And_Contracts.md](./Validation_And_Contracts.md)
- Every page doc's **States** section
