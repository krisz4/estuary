import { createCommentInputSchema } from "@estuary/contracts";
import { describe, expect, it } from "vitest";

import { ApiError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { claimedBy, eventsFor, makeComment, makeTask } from "../test/factories.js";
import { addComment, deleteComment } from "./comment.service.js";

/**
 * Comment service against a real (temp) SQLite file —
 * `docs/engineering/TESTING.md` § Comments, plus the two claim rules that touch
 * comments: they are open to every actor, and the holder's comment renews its
 * lease (`docs/features/Task_Workflow_API.md` § Claims).
 */

const HUMAN = "human:krisz";
const AGENT = "agent:claude-code";
const OTHER_AGENT = "agent:codex";

const input = (raw: Record<string, unknown> = {}) =>
  createCommentInputSchema.parse({ body: "Reproduced on staging.", ...raw });

const LONG_AGO = new Date("2026-01-01T00:00:00.000Z");

describe("addComment", () => {
  it("records the actor as author, defaults kind to note, and writes comment.created", async () => {
    const task = await makeTask();

    const comment = await addComment(task.id, input(), AGENT);

    expect(comment).toMatchObject({ taskId: task.id, author: AGENT, kind: "note" });
    expect(await eventsFor(task.id)).toEqual([
      { type: "comment.created", actor: AGENT, payload: { commentId: comment.id, kind: "note" } },
    ]);
  });

  it("keeps the kind it is given", async () => {
    const task = await makeTask();

    expect((await addComment(task.id, input({ kind: "progress" }), AGENT)).kind).toBe("progress");
  });

  it("does not bump the version or move updatedAt for a non-holder", async () => {
    const task = await makeTask({ updatedAt: LONG_AGO });

    await addComment(task.id, input(), HUMAN);

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.version).toBe(1);
    expect(after.updatedAt.toISOString()).toBe(LONG_AGO.toISOString());
  });

  it("lets an agent comment on a task another agent holds — comments are open to everyone", async () => {
    const task = await makeTask(claimedBy(AGENT));

    const comment = await addComment(task.id, input(), OTHER_AGENT);

    expect(comment.author).toBe(OTHER_AGENT);
    // …without touching the holder's lease.
    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.claimExpiresAt?.getTime()).toBe(task.claimExpiresAt?.getTime());
  });

  it("renews the holder's lease — a progress note is proof of life — without a version bump", async () => {
    const task = await makeTask(claimedBy(AGENT, 1));

    await addComment(task.id, input({ kind: "progress" }), AGENT);

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.claimExpiresAt!.getTime()).toBeGreaterThan(
      task.claimExpiresAt!.getTime() + 60_000,
    );
    expect(after.version).toBe(1);
  });

  it("throws TASK_NOT_FOUND rather than a foreign-key error for a missing task", async () => {
    await expect(addComment(999, input(), HUMAN)).rejects.toMatchObject({
      code: "TASK_NOT_FOUND",
      status: 404,
    });
    expect(await prisma.comment.count()).toBe(0);
  });
});

describe("deleteComment", () => {
  it("removes the comment and writes comment.deleted", async () => {
    const task = await makeTask();
    const comment = await makeComment({ taskId: task.id });

    await deleteComment(task.id, comment.id, HUMAN);

    expect(await prisma.comment.count()).toBe(0);
    expect(await eventsFor(task.id)).toEqual([
      { type: "comment.deleted", actor: HUMAN, payload: { commentId: comment.id } },
    ]);
  });

  it("throws COMMENT_NOT_FOUND for a comment on another task, deleting nothing", async () => {
    const mine = await makeTask();
    const theirs = await makeTask();
    const comment = await makeComment({ taskId: theirs.id });

    const thrown = await deleteComment(mine.id, comment.id, HUMAN).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).code).toBe("COMMENT_NOT_FOUND");
    expect(await prisma.comment.count()).toBe(1);
    expect(await prisma.taskEvent.count()).toBe(0);
  });
});
