import type { Comment, CreateCommentInput } from "@helpdesk/contracts";

import { commentNotFound, ticketNotFound } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { serializeComment } from "../lib/serialize.js";

/**
 * Comment business logic. Every Prisma call for the resource lives here; nothing
 * in this file knows about `req`, `res`, or HTTP.
 *
 * The resource is deliberately thin — append and remove, no edit and no list.
 * Comments are append-only (`docs/features/Comments.md`), and the thread is
 * loaded with its ticket by `getTicket()`, so a separate list endpoint would be
 * a second way to read the same rows with its own paging semantics to keep in
 * step.
 *
 * **Nothing here writes `Ticket.updatedAt`, and that is a rule, not an
 * oversight.** `updatedAt` means "a ticket field changed"; a busy thread would
 * otherwise float its ticket to the top of an `updatedAt` sort while nothing
 * about the ticket itself moved. If "last activity" ordering is ever wanted it
 * needs its own column.
 */

/**
 * Append a comment to a ticket.
 *
 * **The parent is checked explicitly, and the foreign key is not a substitute
 * for that check.** An insert naming a missing ticket raises Prisma **`P2003`**
 * (foreign key constraint failed), not `P2025` — and `errorHandler`'s Prisma
 * backstop only maps `P2025`. So an unguarded insert returns `INTERNAL_ERROR`
 * 500 where the contract documents `TICKET_NOT_FOUND` 404, and it does so only
 * for the one input nobody tries by hand.
 *
 * Read and write share a transaction for the same reason `updateTicket`'s do:
 * without one, a `DELETE /tickets/42` landing between the check and the insert
 * puts the insert back on the `P2003` → 500 path this function exists to avoid.
 */
export async function addComment(ticketId: number, input: CreateCommentInput): Promise<Comment> {
  const row = await prisma.$transaction(async (tx) => {
    const parent = await tx.ticket.findUnique({ where: { id: ticketId }, select: { id: true } });
    if (parent === null) throw ticketNotFound(ticketId);

    return tx.comment.create({
      data: { ticketId, authorName: input.authorName, body: input.body },
    });
  });

  return serializeComment(row);
}

/**
 * Remove one comment from one ticket.
 *
 * **Scoped by both ids in a single `deleteMany`.** `findUnique(commentId)` then
 * comparing `row.ticketId` would work, but it hands the caller a way to tell
 * "this comment does not exist" from "this comment exists but is not yours" —
 * through the response, through timing, and through the standing temptation to
 * return 403 for the second case. Both are `COMMENT_NOT_FOUND` 404 here, so
 * `DELETE /tickets/1/comments/:id` cannot be walked to enumerate ticket 2's
 * comment ids.
 *
 * A zero count therefore covers three cases at once — no such comment, comment
 * on another ticket, no such ticket — and all three are the same 404.
 */
export async function deleteComment(ticketId: number, commentId: number): Promise<void> {
  const { count } = await prisma.comment.deleteMany({ where: { id: commentId, ticketId } });
  if (count === 0) throw commentNotFound();
}
