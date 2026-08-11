import { createCommentInputSchema } from "@helpdesk/contracts";
import { Router } from "express";

import { asyncHandler } from "../lib/asyncHandler.js";
import { parseCommentId, parseTicketId } from "../lib/params.js";
import { addComment, deleteComment } from "../services/comment.service.js";

/**
 * `/api/v1/tickets/:ticketId/comments` — the HTTP layer for the comment thread.
 *
 * **`mergeParams: true` is required**, not decorative: `:ticketId` is captured by
 * the *mount path* in `app.ts`, and without the flag `req.params.ticketId` is
 * `undefined` inside this router. It would then fail the id parse and every
 * comment request would 404 — which reads as "the ticket does not exist" rather
 * than "the router is misconfigured".
 *
 * There is no `GET` here. The thread ships with its ticket
 * (`GET /tickets/:ticketId` includes `comments`, oldest first), and a second
 * read path would need its own ordering and paging rules to keep in step with
 * the first. There is no `PATCH`/`PUT` either — comments are append-only
 * (`docs/features/Comments.md`).
 */

export const commentsRouter: Router = Router({ mergeParams: true });

/**
 * `POST` — 201 with the created comment and a `Location` header.
 *
 * The 404 for a missing parent comes from the **service**, which checks
 * existence explicitly. It cannot come from the foreign key: a missing parent
 * raises Prisma `P2003`, which no handler maps, so an unguarded insert would be
 * a 500 where the contract documents a 404.
 */
commentsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const ticketId = parseTicketId(req.params.ticketId);
    const input = createCommentInputSchema.parse(req.body);

    const comment = await addComment(ticketId, input);

    res.status(201).location(`${req.baseUrl}/${comment.id}`).json(comment);
  }),
);

/**
 * `DELETE` — 204, no body.
 *
 * Both ids are parsed and both are passed to the service, which scopes its
 * `deleteMany` by the pair. A comment belonging to another ticket is a 404, not
 * a 403 and not a 200 — see `services/comment.service.ts` for why the difference
 * is not surfaced.
 */
commentsRouter.delete(
  "/:commentId",
  asyncHandler(async (req, res) => {
    const ticketId = parseTicketId(req.params.ticketId);
    const commentId = parseCommentId(req.params.commentId);

    await deleteComment(ticketId, commentId);
    res.status(204).end();
  }),
);
