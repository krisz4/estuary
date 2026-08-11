import {
  commentIdParamSchema,
  createCommentInputSchema,
  ticketIdParamSchema,
} from "@helpdesk/contracts";
import { z } from "zod";

import {
  CommentComponent,
  INTERNAL_ERROR_RESPONSE,
  bodyParserResponses,
  defaultErrorResponse,
  errorResponse,
  registry,
} from "../lib/openapi.js";

/**
 * OpenAPI definitions for `routes/comments.route.ts`.
 *
 * The resource is deliberately thin: append and remove, no edit and no list.
 * The thread ships with its ticket, so a `GET` here would be a second read path
 * with its own ordering and paging rules to keep in step — and there is no
 * `PATCH`/`PUT` because comments are append-only.
 *
 * Registration is a function rather than an import side effect, for the reason
 * given at the top of `tickets.openapi.ts`: nothing in the spec layer may run
 * while `app.ts` is still loading its import graph.
 */

const ticketIdParam = () =>
  ticketIdParamSchema.meta({ description: "Id of the parent ticket.", example: 42 });

/** Registers both comment operations. Called once, by `getOpenApiDocument()`. */
export function registerCommentPaths(): void {
  registry.registerPath({
    method: "post",
    path: "/api/v1/tickets/{ticketId}/comments",
    tags: ["Comments"],
    summary: "Add a comment",
    description:
      "The body is validated **before** the parent ticket is looked up, so a bad payload against a missing ticket is a 422 rather than a 404. Adding a comment does not touch the ticket's updatedAt.",
    request: {
      params: z.object({ ticketId: ticketIdParam() }),
      body: {
        required: true,
        content: { "application/json": { schema: createCommentInputSchema } },
      },
    },
    responses: {
      201: {
        description: "Created. The Location header points at the new comment.",
        headers: {
          Location: {
            description: "URL of the created comment.",
            schema: { type: "string", example: "/api/v1/tickets/42/comments/191" },
          },
        },
        content: { "application/json": { schema: CommentComponent } },
      },
      ...bodyParserResponses(),
      404: errorResponse(
        "No such parent ticket. Checked explicitly rather than left to the foreign key, which would surface as a 500.",
        ["TICKET_NOT_FOUND"],
      ),
      422: errorResponse("A field failed validation. `details` maps field name to messages.", [
        "VALIDATION_ERROR",
      ]),
      500: INTERNAL_ERROR_RESPONSE,
      default: defaultErrorResponse,
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/tickets/{ticketId}/comments/{commentId}",
    tags: ["Comments"],
    summary: "Delete a comment",
    description:
      "Scoped by both ids. A comment belonging to a different ticket is a 404, identical to one that does not exist — so this path cannot be walked to enumerate another ticket's comment ids.",
    request: {
      params: z.object({
        ticketId: ticketIdParam(),
        commentId: commentIdParamSchema.meta({
          description: "Id of the comment, which must belong to this ticket.",
          example: 191,
        }),
      }),
    },
    responses: {
      204: { description: "Deleted. No body." },
      404: errorResponse(
        "No such comment, the comment belongs to another ticket, or no such ticket — all three are the same 404 on purpose.",
        ["COMMENT_NOT_FOUND"],
      ),
      500: INTERNAL_ERROR_RESPONSE,
      default: defaultErrorResponse,
    },
  });
}
