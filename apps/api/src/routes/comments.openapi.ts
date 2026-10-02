import {
  commentIdParamSchema,
  createCommentInputSchema,
  taskIdParamSchema,
} from "@estuary/contracts";
import { z } from "zod";

import {
  ACTOR_422_NOTE,
  CommentComponent,
  bodyParserResponses,
  errorResponse,
  registerV1Path,
} from "../lib/openapi.js";

/**
 * OpenAPI definitions for `routes/comments.route.ts`.
 *
 * The resource is deliberately thin: append and remove, no edit and no list.
 * The thread ships with its task, so a `GET` here would be a second read path
 * with its own ordering and paging rules to keep in step — and there is no
 * `PATCH`/`PUT` because comments are append-only.
 *
 * Registration is a function rather than an import side effect, for the reason
 * given at the top of `tasks.openapi.ts`: nothing in the spec layer may run
 * while `app.ts` is still loading its import graph.
 */

const taskIdParam = () =>
  taskIdParamSchema.meta({ description: "Id of the parent task.", example: 42 });

/** Registers both comment operations. Called once, by `getOpenApiDocument()`. */
export function registerCommentPaths(): void {
  registerV1Path({
    method: "post",
    path: "/api/v1/tasks/{taskId}/comments",
    tags: ["Comments"],
    summary: "Add a comment",
    description:
      "`author` is the X-Actor header. Comments are open to every actor, even on a task another agent has claimed — and a comment from the claim holder renews its lease. Otherwise adding a comment touches neither the task's version nor its updatedAt. The body is validated **before** the parent task is looked up, so a bad payload against a missing task is a 422 rather than a 404.",
    request: {
      params: z.object({ taskId: taskIdParam() }),
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
            schema: { type: "string", example: "/api/v1/tasks/42/comments/191" },
          },
        },
        content: { "application/json": { schema: CommentComponent } },
      },
      ...bodyParserResponses(),
      404: errorResponse(
        "No such parent task. Checked explicitly rather than left to the foreign key, which would surface as a 500.",
        ["TASK_NOT_FOUND"],
      ),
      422: errorResponse(
        `A field failed validation. \`details\` maps field name to messages. ${ACTOR_422_NOTE}`,
        ["VALIDATION_ERROR"],
      ),
    },
  });

  registerV1Path({
    method: "delete",
    path: "/api/v1/tasks/{taskId}/comments/{commentId}",
    tags: ["Comments"],
    summary: "Delete a comment",
    description:
      "Scoped by both ids. A comment belonging to a different task is a 404, identical to one that does not exist — so this path cannot be walked to enumerate another task's comment ids.",
    request: {
      params: z.object({
        taskId: taskIdParam(),
        commentId: commentIdParamSchema.meta({
          description: "Id of the comment, which must belong to this task.",
          example: 191,
        }),
      }),
    },
    responses: {
      204: { description: "Deleted. No body." },
      404: errorResponse(
        "No such comment, the comment belongs to another task, or no such task — all three are the same 404 on purpose.",
        ["COMMENT_NOT_FOUND"],
      ),
      422: errorResponse(`Only the X-Actor header can fail here. ${ACTOR_422_NOTE}`, [
        "VALIDATION_ERROR",
      ]),
    },
  });
}
