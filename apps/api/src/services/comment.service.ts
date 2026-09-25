import type { Comment, CreateCommentInput } from "@helpdesk/contracts";

import { commentNotFound, taskNotFound } from "../lib/errors.js";
import { writeTransaction } from "../lib/prisma.js";
import { serializeComment } from "../lib/serialize.js";
import { recordEvent } from "./task-events.js";
import { guardedSelect, renewedLease } from "./task-guards.js";

/**
 * Comment business logic. Every Prisma call for the resource lives here; nothing
 * in this file knows about `req`, `res`, or HTTP.
 *
 * The resource is deliberately thin — append and remove, no edit and no list.
 * Comments are append-only (`docs/features/Comments.md`), and the thread is
 * loaded with its task by `getTask()`, so a separate list endpoint would be
 * a second way to read the same rows with its own paging semantics to keep in
 * step.
 *
 * **Nothing here writes `Task.updatedAt` or `Task.version`, and that is a rule,
 * not an oversight.** `updatedAt` means "a task field changed"; a busy thread
 * would otherwise float its task to the top of an `updatedAt` sort while nothing
 * about the task itself moved, and bumping `version` would turn every agent
 * progress note into a `VERSION_CONFLICT` for whoever is editing the task.
 *
 * The one exception is the claim holder's lease: a comment from the agent
 * working the task is proof of life and renews it. That write is an
 * ordinary Prisma `update`, so it does move `updatedAt` — acceptable, since the
 * task is actively in progress.
 *
 * Comments are open to every actor, claim or no claim: an agent that does not
 * hold the task can still leave a note on it.
 */

/**
 * Append a comment to a task.
 *
 * **The parent is checked explicitly, and the foreign key is not a substitute
 * for that check.** An insert naming a missing task raises Prisma **`P2003`**
 * (foreign key constraint failed), not `P2025` — and `errorHandler`'s Prisma
 * backstop only maps `P2025`. So an unguarded insert returns `INTERNAL_ERROR`
 * 500 where the contract documents `TASK_NOT_FOUND` 404, and it does so only
 * for the one input nobody tries by hand.
 *
 * Read and write share a transaction for the same reason `updateTask`'s do:
 * without one, a `DELETE /tasks/42` landing between the check and the insert
 * puts the insert back on the `P2003` → 500 path this function exists to avoid.
 */
export async function addComment(
  taskId: number,
  input: CreateCommentInput,
  actor: string,
): Promise<Comment> {
  const row = await writeTransaction(async (tx) => {
    const parent = await tx.task.findUnique({ where: { id: taskId }, select: guardedSelect });
    if (parent === null) throw taskNotFound(taskId);

    const comment = await tx.comment.create({
      data: { taskId, author: actor, kind: input.kind, body: input.body },
    });
    await recordEvent(tx, {
      taskId,
      type: "comment.created",
      actor,
      payload: { commentId: comment.id, kind: input.kind },
    });

    const lease = renewedLease(parent, actor, new Date());
    if (lease.claimExpiresAt !== undefined) {
      await tx.task.update({ where: { id: taskId }, data: lease });
    }

    return comment;
  });

  return serializeComment(row);
}

/**
 * Remove one comment from one task.
 *
 * **Scoped by both ids in a single `deleteMany`.** `findUnique(commentId)` then
 * comparing `row.taskId` would work, but it hands the caller a way to tell
 * "this comment does not exist" from "this comment exists but is not yours" —
 * through the response, through timing, and through the standing temptation to
 * return 403 for the second case. Both are `COMMENT_NOT_FOUND` 404 here, so
 * `DELETE /tasks/1/comments/:id` cannot be walked to enumerate task 2's
 * comment ids.
 *
 * A zero count therefore covers three cases at once — no such comment, comment
 * on another task, no such task — and all three are the same 404.
 */
export async function deleteComment(
  taskId: number,
  commentId: number,
  actor: string,
): Promise<void> {
  await writeTransaction(async (tx) => {
    const { count } = await tx.comment.deleteMany({ where: { id: commentId, taskId } });
    if (count === 0) throw commentNotFound();

    await recordEvent(tx, {
      taskId,
      type: "comment.deleted",
      actor,
      payload: { commentId },
    });
  });
}
