# API error contract

Every failure from `/api/v1/*` returns this shape. Behavior around it: [../features/Error_Handling.md](../features/Error_Handling.md).

## Envelope

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": { "title": ["Title must be at least 5 characters"] },
    "requestId": "8f2c1e44-9b3a-4d51-9f0e-2b7c5a1d3e88"
  }
}
```

| Field | Required | Notes |
| ----- | -------- | ----- |
| `code` | yes | `SCREAMING_SNAKE`. **Clients branch on this**, not on HTTP status |
| `message` | yes | Human-readable, English, safe to log. Never contains a stack trace or SQL |
| `details` | no | Structured context, shaped per code (see the table below). Field errors for validation; `{ expected, current }` for a version conflict; `{ claimedBy, expiresAt }` for claims; `{ path }` for a dependency cycle |
| `requestId` | yes | Also on the `x-request-id` response header. Correlates with server logs |

Success responses never contain an `error` key. A single resource returns the object; a list returns `{ data, meta }`.

## Code table

In the order of `API_ERROR_CODES` in `packages/contracts/src/errors.ts`. The `details` shapes marked with a schema name are exported from contracts so a client can narrow after branching on `code`.

| Code | Status | When | `details` |
| ---- | ------ | ---- | --------- |
| `VALIDATION_ERROR` | 422 | zod rejected the body, query, or `X-Actor` header; or a check that needs the stored row failed on a named field — `todo` without acceptance criteria, a `parentId` / `dependsOnId` / `blockedBy` that is the task itself or does not exist, a parent that would be its own ancestor, a decision `choice` that is not one of the options, `status` sent to PATCH | `Record<field, string[]>` (`validationErrorDetailsSchema`); a malformed header is `details["X-Actor"]`; an unrecognised key has an empty path and is filed under `_` |
| `AT_LEAST_ONE_FIELD` | 422 | PATCH body was empty, or carried only `expectedVersion` | — |
| `UNAUTHORIZED` | 401 | The server runs with `API_TOKEN` and an `/api/v1` request had no `Authorization: Bearer <token>`, or the wrong one. Never returned without `API_TOKEN`; never on `/health` or `/docs` | — |
| `ACTOR_NOT_PERMITTED` | 403 | An `agent:` actor transitioned a task to `done` while `AGENTS_MAY_COMPLETE` is off | — |
| `TASK_NOT_FOUND` | 404 | No task with that id, or an id segment (`:taskId`, `:dependsOnId`) that is not decimal digits | — |
| `COMMENT_NOT_FOUND` | 404 | No such comment, or it belongs to another task | — |
| `VERSION_CONFLICT` | 409 | `expectedVersion` did not match the task's `version`, or a concurrent write landed between a write's read and its conditional update | `{ expected, current }` (`versionConflictDetailsSchema`) |
| `TASK_ALREADY_CLAIMED` | 409 | An agent other than the holder wrote a task (PATCH, DELETE, transition, claim, dependencies) while a live claim exists. Humans are never refused this way | `{ claimedBy, expiresAt }` (`claimConflictDetailsSchema`) |
| `NOT_CLAIM_HOLDER` | 409 | `heartbeat` by anyone but the holder, `release` by an agent that does not hold the claim, or either on a task that is not `in_progress` | `{ claimedBy, expiresAt }` when someone holds a live claim; absent otherwise |
| `DEPENDENCY_CYCLE` | 409 | A new dependency (`POST …/dependencies`, or `blockedBy` on a transition) would close a loop | `{ path: number[] }` — the loop, starting and ending at the task being changed (`dependencyCycleDetailsSchema`) |
| `NO_OPEN_DECISION` | 409 | `POST …/decision/answer` on a task that is not in `needs_user_decision` or has no open decision | — |
| `INTEGRATION_NOT_CONFIGURED` | 404 | A GitHub integration route while neither `GITHUB_TOKEN` nor `GITHUB_WEBHOOK_SECRET` is set (the webhook route needs the secret specifically) | — |
| `INVALID_WEBHOOK_SIGNATURE` | 401 | `POST /integrations/github/webhook` with a missing or wrong `X-Hub-Signature-256` | — |
| `GITHUB_NOT_FOUND` | 404 | Issue import: GitHub has no such issue, or it is private and the token cannot see it | — |
| `GITHUB_UNAVAILABLE` | 502 | Issue import: GitHub did not answer, answered with an error, or rate-limited the request | — |
| `MALFORMED_JSON` | 400 | Body is not parseable JSON (`entity.parse.failed`) | — |
| `PAYLOAD_TOO_LARGE` | 413 | Body over `BODY_LIMIT` (`entity.too.large`) | — |
| `NOT_FOUND` | 404 | Unknown route or verb, or a resource missing on a path that did not check explicitly | — |
| `INTERNAL_ERROR` | 500 | Anything unhandled | never present |

**Retired:** `INVALID_STATUS_TRANSITION` (409, `{ from, to, allowed }`) went with the helpdesk lifecycle. There is no from→to table any more; what a target status requires is the shape of the transition payload, so a missing reason or question is an ordinary `VALIDATION_ERROR` on that field. Do not reuse the code.

The union lives in `packages/contracts/src/errors.ts` as `ApiErrorCode`, so a typo in a code string is a type error on both sides. **Adding a code means adding it there and to this table.**

Every code above is reachable, and there is a test that produces each one. Two codes were removed for failing that bar:

- **`METHOD_NOT_ALLOWED` (405)** — Express does not generate it; an unmatched verb falls through to the `notFound` middleware as a 404. Implementing it would mean an `.all()` handler per route for no practical gain.
- **`CONFLICT` (409)** — every 409 names *what* conflicted (`VERSION_CONFLICT`, `TASK_ALREADY_CLAIMED`, …). The one client-supplied unique column, `idempotencyKey`, never conflicts: a repeated key returns the original task with 200, and a concurrent duplicate's `P2002` is turned back into that replay.

## Status conventions

- **422, not 400,** for semantic validation failures. **400 is only** `MALFORMED_JSON` — the body was not parseable at all, so there are no fields to report on.
- **404, not 403,** for a comment id that belongs to another task. Distinguishing them turns the path into a probe.
- **404, not 422,** for a non-numeric `:taskId`. A malformed id and a missing task are indistinguishable to a caller.
- **409** for state conflicts (stale version, someone else's claim, a dependency cycle, no open decision) — the request was well-formed but the current state forbids it. Re-read, then retry or back off.
- **401** only from the optional `API_TOKEN` gate, and **403** only for an actor-based rule (`ACTOR_NOT_PERMITTED`). `X-Actor` is attribution, not identity, so a malformed one is a 422, never a 401.
- **204, no body,** for successful `DELETE`. A JSON body on a 204 is a protocol violation some clients choke on.
- **201 + `Location`** for successful `POST`.

## Never

- No stack traces, SQL, file paths, or Prisma error text in `message` — 500s use a generic message and lean on `requestId`.
- No error responses built outside `middleware/errorHandler.ts`.
- No 200 with an `error` key inside.
- No changing an existing code's meaning. Add a new one.

## Client mapping

`apps/web/src/api/http.ts` turns any non-2xx into `ApiClientError { code, message, details, requestId, status }`. UI copy is keyed off `code` in `src/lib/errorMessages.ts`; an unrecognized code falls back to the generic message rather than rendering the raw server text.

The client adds **two codes of its own**, exported as `CLIENT_ERROR_CODES` from `http.ts`. They are deliberately *not* in `API_ERROR_CODES` — no server response ever carries them, and widening the API union would let a handler throw one:

| Code | `status` | When |
| ---- | -------- | ---- |
| `NETWORK_ERROR` | `0` | The `fetch` itself failed — API down, DNS, connection refused, a blocked preflight. There is no response to read a code off |
| `MALFORMED_RESPONSE` | the real status | A 2xx whose body did not parse, or an error response that was not the envelope |

Both are `retryable` in `errorMessages.ts`, and `NETWORK_ERROR` is half of the query retry predicate in `api/queryClient.ts` (`code === "NETWORK_ERROR" || status >= 500`). `errorCopy()` therefore keys off seventeen codes: the fifteen above plus these two.

## Related

- [../features/Error_Handling.md](../features/Error_Handling.md)
- [../features/Validation_And_Contracts.md](../features/Validation_And_Contracts.md)
- [../features/API_Documentation.md](../features/API_Documentation.md) — codes are documented per endpoint in the OpenAPI spec
