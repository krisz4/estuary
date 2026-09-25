import {
  DEFAULT_TICKET_SORT,
  MAX_PAGE_SIZE,
  SORT_DIRECTIONS,
  TICKET_SORT_FIELDS,
  createTicketInputSchema,
  ticketIdParamSchema,
  ticketListQuerySchema,
  updateTicketInputSchema,
} from "@helpdesk/contracts";
import { z } from "zod";

import {
  PaginatedTicketsComponent,
  TicketComponent,
  TicketFacetsComponent,
  INTERNAL_ERROR_RESPONSE,
  bodyParserResponses,
  defaultErrorResponse,
  describeQueryParams,
  errorResponse,
  registry,
  unwrapPreprocessedObject,
} from "../lib/openapi.js";

/**
 * OpenAPI definitions for `routes/tickets.route.ts`.
 *
 * One registration module per router, per `docs/features/API_Documentation.md`.
 * Nothing here is imported by the router itself — a spec that the handlers
 * depended on would be a spec that could not be wrong, but only because it would
 * have become the implementation. The link between the two is asserted instead,
 * by `routes/openapi.contract.test.ts`, which compares the documented paths
 * against the routes actually mounted on the app.
 *
 * **Everything is exported as a function, and nothing runs at import time.**
 * Building the query parameters means calling `unwrapPreprocessedObject()`,
 * which reads zod internals and throws by design when they change shape. At
 * module scope that throw happens while `app.ts`'s import graph is still
 * loading, so a `zod ^4` patch bump would take down **process startup** — on
 * deployments that set `DOCS_ENABLED=false` and never wanted a spec at all. As a
 * function it can only throw inside `getOpenApiDocument()`, which is reached
 * from the `/docs` router and the generator script and nowhere else.
 */

/** Shared by four operations; `ticketIdParamSchema` is the parser the route uses. */
const ticketIdParam = (): z.ZodObject =>
  z.object({
    ticketId: ticketIdParamSchema.meta({
      description:
        "Ticket id, which is also the ticket number: 42 is HD-000042. Decimal digits only — a non-numeric segment is a 404, never a 422.",
      example: 42,
    }),
  });

/* ------------------------------------------------------------------ *
 * Query parameters
 * ------------------------------------------------------------------ */

export const QUERY_DESCRIPTIONS: Record<string, string> = {
  page: "1-based page number.",
  pageSize: `Rows per page. Values above ${MAX_PAGE_SIZE} are **rejected with a 422, not clamped** — a client asking for 500 rows has a bug worth surfacing.`,
  sort: `Sort clause, "field:direction". Sorting by status or priority orders by lifecycle and severity, not alphabetically.`,
  status: "Repeatable. Values within one parameter OR together; different parameters AND together.",
  priority: "Repeatable, same OR/AND rule as status.",
  category: "Repeatable, same OR/AND rule as status.",
  assignee:
    "Exact, case-sensitive match. Send a value from GET /tickets/facets rather than something a user typed. Mutually exclusive with assigneeIsNull.",
  assigneeIsNull: "true returns unassigned tickets only. Mutually exclusive with assignee.",
  requesterEmail: "Exact match against the stored (lowercased) address.",
  q: "Free-text search over title and description, case-insensitive, ANDed with every other filter rather than widening past it.",
  createdFrom: "Inclusive lower bound, YYYY-MM-DD, UTC.",
  createdTo: "Inclusive upper bound, YYYY-MM-DD, UTC — the named day is included.",
};

/**
 * `sort` is the one parameter whose validated type is not its wire type: the
 * schema transforms `"createdAt:desc"` into `{ field, direction }`, and
 * documenting the parsed object would tell a reader to send JSON in a query
 * string. Everything else is documented straight off the real schema.
 */
export const QUERY_OVERRIDES: Record<string, z.ZodType> = {
  sort: z
    .enum(
      TICKET_SORT_FIELDS.flatMap((field) =>
        SORT_DIRECTIONS.map((direction) => `${field}:${direction}` as const),
      ) as unknown as [string, ...string[]],
    )
    .default(DEFAULT_TICKET_SORT),
};

/**
 * A function, not a constant. See the note at the top of the file: the unwrap it
 * performs is the one operation in this module that can throw, and it must not
 * be able to throw during module evaluation.
 */
export const buildTicketListQueryParams = (): z.ZodObject =>
  describeQueryParams(
    unwrapPreprocessedObject(ticketListQuerySchema),
    QUERY_DESCRIPTIONS,
    QUERY_OVERRIDES,
  );

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

/** Registers every ticket operation. Called once, by `getOpenApiDocument()`. */
export function registerTicketPaths(): void {
  const ticketId = ticketIdParam();
  const query = buildTicketListQueryParams();

  registry.registerPath({
    method: "get",
    path: "/api/v1/tickets",
    tags: ["Tickets"],
    summary: "List tickets",
    description:
      "Filter, sort, and page. Unknown query parameters are rejected rather than ignored — a typo'd filter silently returning everything is worse than an error.",
    request: { query },
    responses: {
      200: {
        description: "A page of tickets and its pagination metadata.",
        content: { "application/json": { schema: PaginatedTicketsComponent } },
      },
      422: errorResponse(
        "A parameter failed validation: an unknown parameter, pageSize above the maximum, an unknown sort field, an inverted date range, or assignee together with assigneeIsNull.",
        ["VALIDATION_ERROR"],
      ),
      500: INTERNAL_ERROR_RESPONSE,
      default: defaultErrorResponse,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/tickets",
    tags: ["Tickets"],
    summary: "Create a ticket",
    description:
      "A new ticket is always `open`; the payload has no status field and a body supplying one is rejected rather than silently stripped.",
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: createTicketInputSchema } },
      },
    },
    responses: {
      201: {
        description: "Created. The Location header points at the new ticket.",
        headers: {
          Location: {
            description: "URL of the created ticket.",
            schema: { type: "string", example: "/api/v1/tickets/64" },
          },
        },
        content: { "application/json": { schema: TicketComponent } },
      },
      ...bodyParserResponses(),
      422: errorResponse(
        "A field failed validation, or the body carried a server-owned field. `details` maps field name to messages.",
        ["VALIDATION_ERROR"],
      ),
      500: INTERNAL_ERROR_RESPONSE,
      default: defaultErrorResponse,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/tickets/facets",
    tags: ["Tickets"],
    summary: "Filter options present in the data",
    description:
      "Declared before /tickets/{ticketId} in the router, so `facets` is not captured as an id. The assignee list is the only safe source of values for the assignee filter, which matches exactly and case-sensitively.",
    responses: {
      200: {
        description: "Distinct non-null assignees and categories, sorted.",
        content: { "application/json": { schema: TicketFacetsComponent } },
      },
      500: INTERNAL_ERROR_RESPONSE,
      default: defaultErrorResponse,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/tickets/{ticketId}",
    tags: ["Tickets"],
    summary: "Get one ticket",
    description: "Includes the full comment thread, oldest first.",
    request: { params: ticketId },
    responses: {
      200: {
        description: "The ticket and its comments.",
        content: { "application/json": { schema: TicketComponent } },
      },
      404: errorResponse(
        "No such ticket — or an id that is not decimal digits, which is deliberately indistinguishable from a missing one.",
        ["TICKET_NOT_FOUND"],
      ),
      500: INTERNAL_ERROR_RESPONSE,
      default: defaultErrorResponse,
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/v1/tickets/{ticketId}",
    tags: ["Tickets"],
    summary: "Update a ticket",
    description: [
      "Partial update; PUT is deliberately not implemented.",
      "",
      "Setting `status` to its current value is a success that performs **no write**, so `updatedAt` does not move.",
      "The only forbidden transition is `closed` to `resolved`.",
      "Clearing `assignee` or `category` is done by sending an empty string or null.",
    ].join("\n"),
    request: {
      params: ticketId,
      body: {
        required: true,
        content: { "application/json": { schema: updateTicketInputSchema } },
      },
    },
    responses: {
      200: {
        description: "The updated ticket.",
        content: { "application/json": { schema: TicketComponent } },
      },
      ...bodyParserResponses(),
      404: errorResponse("No such ticket.", ["TICKET_NOT_FOUND"]),
      409: errorResponse(
        "The status change is not allowed. `details` carries { from, to, allowed } so the client can render the legal options without a second round trip.",
        ["INVALID_STATUS_TRANSITION"],
      ),
      422: errorResponse(
        "A field failed validation, or the body was empty. An empty body is AT_LEAST_ONE_FIELD, which carries no field details — there is no field to point at.",
        ["VALIDATION_ERROR", "AT_LEAST_ONE_FIELD"],
      ),
      500: INTERNAL_ERROR_RESPONSE,
      default: defaultErrorResponse,
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/tickets/{ticketId}",
    tags: ["Tickets"],
    summary: "Delete a ticket",
    description: "Hard delete. Comments cascade at the database level.",
    request: { params: ticketId },
    responses: {
      204: { description: "Deleted. No body." },
      404: errorResponse("No such ticket. Deleting twice is a 404, not a 500.", [
        "TICKET_NOT_FOUND",
      ]),
      500: INTERNAL_ERROR_RESPONSE,
      default: defaultErrorResponse,
    },
  });
}
