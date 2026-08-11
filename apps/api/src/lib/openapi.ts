import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import {
  apiErrorResponseSchema,
  apiErrorSchema,
  commentSchema,
  paginatedTicketsSchema,
  ticketFacetsSchema,
  ticketSchema,
  type ApiErrorCode,
} from "@helpdesk/contracts";
import { z } from "zod";

/**
 * The OpenAPI document, **generated from the zod contracts** rather than
 * maintained beside them. Spec: `docs/features/API_Documentation.md`.
 *
 * The point of generating is not convenience. A hand-written spec can describe a
 * response the code does not actually return and nothing catches it; here the
 * schema in `components.schemas.Ticket` *is* the object `ticketSchema.parse()`
 * enforces, so the two cannot disagree.
 *
 * ## Why the metadata lives here and not in `packages/contracts`
 *
 * That package's hard constraint is "zod and nothing else" — it is bundled into
 * browser code. `@asteasolutions/zod-to-openapi` peers `zod ^4`, which means the
 * contract schemas can be annotated **from this side of the boundary** with no
 * runtime dependency added over there. This file plus `routes/*.openapi.ts` is
 * the whole of that annotation layer. (Deferred item D5 in the build log.)
 *
 * ## Why `.meta()` and not `.openapi()`
 *
 * The library's `.openapi()` method arrives by monkey-patching
 * `ZodType.prototype` in `extendZodWithOpenApi()`, and in zod 4 a schema
 * constructed **before** that call does not pick it up — every contract schema is
 * constructed at import time, so `registry.register()` fails with
 * `zodSchema.openapi is not a function` wherever the extension call is placed.
 * zod 4's native `.meta({ id })` is read by the generator as the same thing, needs
 * no patching, and returns a clone instead of mutating a schema the validators
 * share. Both were tried; this is the one that works.
 *
 * A consequence worth knowing: a schema becomes a **named component** only when
 * it is the schema handed to `registerPath` at a request or response boundary. An
 * id on a schema that only ever appears nested (`TicketSummary` inside
 * `PaginatedTickets`) is inlined. That is cosmetic — the shape is still exact.
 */

/* ------------------------------------------------------------------ *
 * Named components
 * ------------------------------------------------------------------ */

export const CommentComponent = commentSchema.meta({
  id: "Comment",
  description: "A comment on a ticket. Comments are append-only, so there is no updatedAt.",
});

export const TicketComponent = ticketSchema.meta({
  id: "Ticket",
  description: "A single ticket with its full comment thread, oldest comment first.",
});

export const PaginatedTicketsComponent = paginatedTicketsSchema.meta({
  id: "PaginatedTickets",
  description:
    "The list envelope. List responses are always { data, meta }; single resources are returned directly.",
});

export const TicketFacetsComponent = ticketFacetsSchema.meta({
  id: "TicketFacets",
  description:
    "Distinct non-null values actually present in the table. The assignee filter sends values from here, which is what makes case-sensitive exact matching safe.",
});

export const ErrorResponseComponent = apiErrorResponseSchema.meta({
  id: "ErrorResponse",
  description: "The error envelope. Clients branch on error.code, never on the HTTP status alone.",
});

/* ------------------------------------------------------------------ *
 * Error responses
 * ------------------------------------------------------------------ */

/**
 * An error response narrowed to the codes **that operation can actually emit**.
 *
 * `docs/features/API_Documentation.md` requires this rather than a generic
 * "500 Error" entry: someone reading `PATCH /tickets/{ticketId}` should find
 * `INVALID_STATUS_TRANSITION` there and nowhere else, because that is the only
 * operation that produces it.
 *
 * The narrowing is `.extend()` on the contract's own envelope, so the
 * message / details / requestId half of the shape still has exactly one source.
 */
export const errorResponse = (
  description: string,
  codes: readonly [ApiErrorCode, ...ApiErrorCode[]],
) => ({
  description,
  content: {
    "application/json": {
      schema: z.object({ error: apiErrorSchema.extend({ code: z.enum(codes) }) }),
    },
  },
});

/**
 * The `default` response every operation carries.
 *
 * Two jobs. It is honest — any failure at all uses this envelope, including ones
 * no operation enumerates (a malformed request line, a verb the router does not
 * implement). And it is what gives `ErrorResponse` a use at a registerPath
 * boundary, which is the only way it becomes a named component rather than being
 * inlined into nine narrowed copies.
 */
export const defaultErrorResponse = {
  description:
    "Any other failure. Every error response in this API uses the ErrorResponse envelope.",
  content: { "application/json": { schema: ErrorResponseComponent } },
};

/**
 * The two failures the **body parser** produces rather than any route, spread
 * into every operation that accepts a body.
 *
 * Shared rather than spelled out four times: they are identical by construction
 * — `express.json()` is mounted once in `app.ts` and every write endpoint sits
 * behind it — so four copies would be four places for the wording to drift from
 * `BODY_LIMIT`'s actual behaviour.
 */
export const bodyParserResponses = () => ({
  400: errorResponse("The request body is not valid JSON.", ["MALFORMED_JSON"]),
  413: errorResponse("The request body is larger than BODY_LIMIT.", ["PAYLOAD_TOO_LARGE"]),
});

/** Every operation can fail this way; `errorHandler` is the only thing that writes it. */
export const INTERNAL_ERROR_RESPONSE = errorResponse(
  "Unexpected server error. The body carries a requestId and never a stack trace.",
  ["INTERNAL_ERROR"],
);

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

/**
 * One registry per process. The `routes/*.openapi.ts` modules push their path
 * definitions into it as an import side effect; `buildOpenApiDocument()` reads
 * it. `registerOpenApiPaths()` below is what makes the import order irrelevant.
 */
export const registry: OpenAPIRegistry = new OpenAPIRegistry();

/**
 * Unwraps a `z.preprocess(...)`-wrapped object back to the object carrying the
 * field definitions.
 *
 * `ticketListQuerySchema` is a preprocessed schema — a `ZodPipe` — so its twelve
 * query parameters live on the output side. Unwrapping is the difference between
 * a spec that tracks the validator and a spec that tracks whoever last remembered
 * to edit it. It throws rather than degrading: a silent fallback would document
 * zero parameters, and a `GET /tickets` with no documented filters looks
 * plausible enough to ship. `routes/openapi.contract.test.ts` additionally
 * asserts the documented parameter names equal this object's keys.
 */
export const unwrapPreprocessedObject = (schema: z.ZodType): z.ZodObject => {
  const out = (schema as unknown as { _zod?: { def?: { out?: unknown } } })._zod?.def?.out;

  if (!(out instanceof z.ZodObject)) {
    throw new Error(
      "Expected a z.preprocess()-wrapped object schema. If zod changed how z.preprocess " +
        "is represented internally, fix this unwrap — do not hand-copy the parameter list, " +
        "which is precisely the drift it exists to prevent.",
    );
  }

  return out;
};

/**
 * Attaches prose to the fields of a query-parameter object **without retyping
 * them**.
 *
 * A spec whose parameters carry no descriptions is barely worth generating, and
 * the obvious way to add them — writing out twelve `z.string()` parameters with
 * text attached — throws away the bounds, defaults, and enums that came from the
 * validator, which is the entire reason for generating. So the shape is walked
 * and each field is *annotated in place*.
 *
 * `overrides` is the escape hatch for the one field whose validated type is not
 * its wire type (`sort` parses `"createdAt:desc"` into `{ field, direction }`,
 * and documenting the parsed object would tell a reader to send JSON). Both maps
 * are asserted against the real shape's keys in
 * `routes/openapi.contract.test.ts`, so a renamed parameter fails the run rather
 * than quietly losing its description.
 */
export const describeQueryParams = (
  object: z.ZodObject,
  descriptions: Record<string, string>,
  overrides: Record<string, z.ZodType> = {},
): z.ZodObject => {
  const shape = Object.fromEntries(
    Object.entries(object.shape).map(([key, field]) => {
      const base = overrides[key] ?? (field as z.ZodType);
      const description = descriptions[key];
      return [key, description === undefined ? base : base.meta({ description })];
    }),
  );

  return z.object(shape);
};

/* ------------------------------------------------------------------ *
 * The document
 * ------------------------------------------------------------------ */

/**
 * The generated document's type, taken from the generator rather than by adding
 * `openapi3-ts` as a direct dependency. It is a transitive dependency of
 * `@asteasolutions/zod-to-openapi`, and importing a package this workspace does
 * not declare would break the day pnpm's strict resolution is what it already is.
 */
export type OpenApiDocument = ReturnType<OpenApiGeneratorV31["generateDocument"]>;

export const OPENAPI_TITLE = "Helpdesk API";
export const OPENAPI_VERSION = "1.0.0";

/**
 * Paths are written in full (`/api/v1/tickets`) with the server at the origin
 * root, rather than as `/tickets` under a `/api/v1` server entry. `GET /health`
 * sits **outside** the version prefix on purpose — a Docker healthcheck should
 * not move the day the version does — and a spec whose server URL was `/api/v1`
 * could not describe it without a second server entry covering exactly one path.
 */
export function buildOpenApiDocument(): OpenApiDocument {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: {
      title: OPENAPI_TITLE,
      version: OPENAPI_VERSION,
      description: [
        "REST API for the helpdesk ticketing system.",
        "",
        "**There is no authentication.** That is a deliberate scope decision from the brief, not an omission.",
        "",
        "- List responses are enveloped as `{ data, meta }`; single resources are returned directly.",
        "- Failures always use the `ErrorResponse` envelope with a `SCREAMING_SNAKE` `code`. Branch on the code, not on the status alone.",
        "- Dates are ISO 8601 UTC strings.",
        "- Ticket ids are also ticket numbers: ticket `42` renders as `HD-000042`.",
      ].join("\n"),
    },
    servers: [{ url: "/", description: "This server" }],
    tags: [
      { name: "Tickets", description: "Create, read, update, delete, filter, sort, and page" },
      { name: "Comments", description: "Append-only comment threads on a ticket" },
      { name: "System", description: "Liveness, and what happens to an unmatched request" },
    ],
  });
}
