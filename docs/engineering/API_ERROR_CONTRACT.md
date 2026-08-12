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
| `details` | no | Structured context. Field errors for validation; `{ from, to, allowed }` for transitions |
| `requestId` | yes | Also on the `x-request-id` response header. Correlates with server logs |

Success responses never contain an `error` key. A single resource returns the object; a list returns `{ data, meta }`.

## Code table

| Code | Status | Meaning | `details` |
| ---- | ------ | ------- | --------- |
| `VALIDATION_ERROR` | 422 | zod rejected the body, query, or params | `Record<field, string[]>` |
| `AT_LEAST_ONE_FIELD` | 422 | PATCH body was empty | — |
| `TICKET_NOT_FOUND` | 404 | No ticket with that id, or the id is not a positive integer | — |
| `COMMENT_NOT_FOUND` | 404 | No such comment, or it belongs to another ticket | — |
| `INVALID_STATUS_TRANSITION` | 409 | Illegal status change | `{ from, to, allowed: string[] }` |
| `MALFORMED_JSON` | 400 | Body is not parseable JSON (`entity.parse.failed`) | — |
| `PAYLOAD_TOO_LARGE` | 413 | Body over `BODY_LIMIT` (`entity.too.large`) | — |
| `NOT_FOUND` | 404 | Unknown route, or a resource missing on a path that did not check explicitly | — |
| `INTERNAL_ERROR` | 500 | Anything unhandled | never present |

The union lives in `packages/contracts/src/errors.ts` as `ApiErrorCode`, so a typo in a code string is a type error on both sides. **Adding a code means adding it there and to this table.**

Every code above is reachable, and there is a test that produces each one. Two codes were removed for failing that bar:

- **`METHOD_NOT_ALLOWED` (405)** — Express does not generate it; an unmatched verb falls through to the `notFound` middleware as a 404. Implementing it would mean an `.all()` handler per route for no practical gain.
- **`CONFLICT` (409)** — the only unique columns are server-generated primary keys, so no client request can violate one. A `P2002` here would be a server bug and correctly surfaces as `INTERNAL_ERROR`. Reintroduce the code if a user-settable unique column is ever added.

## Status conventions

- **422, not 400,** for semantic validation failures. **400 is only** `MALFORMED_JSON` — the body was not parseable at all, so there are no fields to report on.
- **404, not 403,** for a comment id that belongs to another ticket. Distinguishing them turns the path into a probe.
- **404, not 422,** for a non-numeric `:ticketId`. A malformed id and a missing ticket are indistinguishable to a caller.
- **409** for state conflicts (illegal transition, unique violation) — the request was well-formed but the current state forbids it.
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

Both are `retryable` in `errorMessages.ts`, and `NETWORK_ERROR` is half of the query retry predicate in `api/queryClient.ts` (`code === "NETWORK_ERROR" || status >= 500`). `errorCopy()` therefore keys off all eleven codes: the nine above plus these two.

## Related

- [../features/Error_Handling.md](../features/Error_Handling.md)
- [../features/Validation_And_Contracts.md](../features/Validation_And_Contracts.md)
- [../features/API_Documentation.md](../features/API_Documentation.md) — codes are documented per endpoint in the OpenAPI spec
