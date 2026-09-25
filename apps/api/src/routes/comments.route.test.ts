import { apiErrorResponseSchema, commentSchema } from "@helpdesk/contracts";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { claimedBy, eventsFor, makeComment, makeTask } from "../test/factories.js";

/**
 * `/api/v1/tasks/:taskId/comments` route integration tests —
 * `docs/engineering/TESTING.md` § Comments.
 *
 * Three of these exist because of a specific failure mode rather than for
 * coverage: the missing-parent 404 (which is a 500 without the service's
 * explicit check), the cross-task delete 404 (which is a 200 without the
 * two-id scope), and the `updatedAt` assertion (which is what stops a comment
 * from floating its task to the top of an `updatedAt` sort).
 */

const app = createApp();

const commentsUrl = (taskId: number | string) => `/api/v1/tasks/${taskId}/comments`;

const validComment = {
  body: "Reissued the webhook signing secret — try again and let me know.",
};

const expectEnvelope = (body: unknown, code: string) => {
  const parsed = apiErrorResponseSchema.safeParse(body);
  expect(parsed.success, `not a valid error envelope: ${JSON.stringify(body)}`).toBe(true);
  expect(parsed.data?.error.code).toBe(code);
  expect(parsed.data?.error.requestId.length).toBeGreaterThan(0);
};

/* ------------------------------------------------------------------ *
 * POST
 * ------------------------------------------------------------------ */

describe("POST /api/v1/tasks/:taskId/comments", () => {
  it("returns 201 with the created comment and a Location header", async () => {
    const task = await makeTask();

    const res = await request(app).post(commentsUrl(task.id)).send(validComment);

    expect(res.status).toBe(201);
    expect(commentSchema.safeParse(res.body).success, JSON.stringify(res.body)).toBe(true);
    expect(res.body.taskId).toBe(task.id);
    expect(res.headers.location).toBe(`${commentsUrl(task.id)}/${res.body.id}`);
  });

  it("appends the comment to the task's thread, in order", async () => {
    const task = await makeTask();

    await request(app)
      .post(commentsUrl(task.id))
      .send({ ...validComment, body: "first comment" });
    await request(app)
      .post(commentsUrl(task.id))
      .send({ ...validComment, body: "second comment" });

    const detail = await request(app).get(`/api/v1/tasks/${task.id}`);

    expect(detail.body.comments.map((c: { body: string }) => c.body)).toEqual([
      "first comment",
      "second comment",
    ]);
    expect(detail.body.commentCount).toBe(2);
  });

  /**
   * Without the service's explicit `findUnique` on the parent this is a Prisma
   * `P2003` (foreign key constraint failed), which no handler maps — so it
   * surfaces as `INTERNAL_ERROR` 500 where the contract documents a 404.
   */
  it("returns 404 TASK_NOT_FOUND, not 500, when the parent task does not exist", async () => {
    const res = await request(app).post(commentsUrl(999999)).send(validComment);

    expect(res.status).toBe(404);
    expectEnvelope(res.body, "TASK_NOT_FOUND");
    expect(await prisma.comment.count()).toBe(0);
  });

  it("returns 404 for a non-numeric :taskId", async () => {
    const res = await request(app).post(commentsUrl("abc")).send(validComment);

    expect(res.status).toBe(404);
    expectEnvelope(res.body, "TASK_NOT_FOUND");
  });

  /**
   * `updatedAt` means "a task field changed". A busy thread must not keep
   * bumping its task to the top of an `updatedAt` sort.
   */
  it("does not change the task's updatedAt or version", async () => {
    const task = await makeTask();

    await request(app).post(commentsUrl(task.id)).send(validComment);

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.updatedAt.getTime()).toBe(task.updatedAt.getTime());
    expect(after.version).toBe(task.version);
  });

  it.each([
    ["an empty body", { body: "" }, "body"],
    ["a whitespace-only body", { body: "   " }, "body"],
    ["an over-length body", { body: "x".repeat(5001) }, "body"],
    ["a missing body", { kind: "note" }, "body"],
    ["an unknown kind", { body: "Something happened.", kind: "rant" }, "kind"],
  ])("returns 422 VALIDATION_ERROR for %s", async (_label, payload, field) => {
    const task = await makeTask();

    const res = await request(app).post(commentsUrl(task.id)).send(payload);

    expect(res.status).toBe(422);
    expectEnvelope(res.body, "VALIDATION_ERROR");
    expect(Object.keys(res.body.error.details)).toContain(field);
  });

  it("takes the author from X-Actor and defaults kind to note", async () => {
    const task = await makeTask();

    const res = await request(app)
      .post(commentsUrl(task.id))
      .set("X-Actor", "agent:claude-code")
      .send(validComment);

    expect(res.body).toMatchObject({ author: "agent:claude-code", kind: "note" });
    expect(await eventsFor(task.id)).toEqual([
      {
        type: "comment.created",
        actor: "agent:claude-code",
        payload: { commentId: res.body.id, kind: "note" },
      },
    ]);
  });

  it.each(["note", "progress", "qa_feedback"])("accepts kind %s", async (kind) => {
    const task = await makeTask();

    const res = await request(app)
      .post(commentsUrl(task.id))
      .send({ ...validComment, kind });

    expect(res.status).toBe(201);
    expect(res.body.kind).toBe(kind);
  });

  /**
   * Comments are open to everyone, claim or no claim — and the one comment that
   * does touch the task is the holder's, which renews its lease.
   */
  it("lets another agent comment on a claimed task, and renews the lease only for the holder", async () => {
    const task = await makeTask(claimedBy("agent:claude-code", 1));

    const other = await request(app)
      .post(commentsUrl(task.id))
      .set("X-Actor", "agent:codex")
      .send(validComment);
    const afterOther = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });

    const holder = await request(app)
      .post(commentsUrl(task.id))
      .set("X-Actor", "agent:claude-code")
      .send({ body: "Tests are green locally.", kind: "progress" });
    const afterHolder = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });

    expect(other.status).toBe(201);
    expect(afterOther.claimExpiresAt?.getTime()).toBe(task.claimExpiresAt?.getTime());
    expect(holder.status).toBe(201);
    expect(afterHolder.claimExpiresAt!.getTime()).toBeGreaterThan(
      task.claimExpiresAt!.getTime() + 60_000,
    );
    expect(afterHolder.version).toBe(task.version);
  });

  it("rejects server-owned keys rather than stripping them", async () => {
    const task = await makeTask();

    const res = await request(app)
      .post(commentsUrl(task.id))
      .send({ ...validComment, id: 7, taskId: 99, author: "human:someone-else" });

    expect(res.status).toBe(422);
    expect(await prisma.comment.count()).toBe(0);
  });

  it("validates the body before checking the parent, so a bad payload is still 422", async () => {
    const res = await request(app).post(commentsUrl(999999)).send({ body: "" });

    // The parent is missing *and* the payload is invalid. Either answer is
    // defensible; this pins which one the API actually gives so a reordering of
    // the handler is a visible change rather than a silent one.
    expect(res.status).toBe(422);
    expectEnvelope(res.body, "VALIDATION_ERROR");
  });
});

/* ------------------------------------------------------------------ *
 * DELETE
 * ------------------------------------------------------------------ */

describe("DELETE /api/v1/tasks/:taskId/comments/:commentId", () => {
  it("returns 204 with no body and removes the comment from the thread", async () => {
    const task = await makeTask();
    const comment = await makeComment({ taskId: task.id });

    const res = await request(app).delete(`${commentsUrl(task.id)}/${comment.id}`);

    expect(res.status).toBe(204);
    expect(res.text).toBe("");

    const detail = await request(app).get(`/api/v1/tasks/${task.id}`);
    expect(detail.body.comments).toEqual([]);
    expect((await eventsFor(task.id)).map((event) => event.type)).toEqual(["comment.deleted"]);
  });

  /**
   * The regression test for the two-id scope. With `deleteMany({ where: { id } })`
   * — or a `findUnique` that forgets to compare — this deletes another task's
   * comment and returns 204, which is both a data-loss bug and an enumeration
   * oracle.
   */
  it("returns 404 and deletes nothing when the comment belongs to another task", async () => {
    const mine = await makeTask();
    const theirs = await makeTask();
    const comment = await makeComment({ taskId: theirs.id });

    const res = await request(app).delete(`${commentsUrl(mine.id)}/${comment.id}`);

    expect(res.status).toBe(404);
    expectEnvelope(res.body, "COMMENT_NOT_FOUND");
    expect(await prisma.comment.findUnique({ where: { id: comment.id } })).not.toBeNull();
  });

  it("returns 404 COMMENT_NOT_FOUND, not 403, so the path cannot be used as a probe", async () => {
    const mine = await makeTask();
    const theirs = await makeTask();
    const existing = await makeComment({ taskId: theirs.id });

    const wrongOwner = await request(app).delete(`${commentsUrl(mine.id)}/${existing.id}`);
    const neverExisted = await request(app).delete(`${commentsUrl(mine.id)}/999999`);

    // Identical answers — that is the point.
    expect(wrongOwner.status).toBe(neverExisted.status);
    expect(wrongOwner.body.error.code).toBe(neverExisted.body.error.code);
    expect(wrongOwner.body.error.message).toBe(neverExisted.body.error.message);
  });

  it("returns 404, not 500, when the same comment is deleted twice", async () => {
    const task = await makeTask();
    const comment = await makeComment({ taskId: task.id });

    expect((await request(app).delete(`${commentsUrl(task.id)}/${comment.id}`)).status).toBe(204);

    const second = await request(app).delete(`${commentsUrl(task.id)}/${comment.id}`);
    expect(second.status).toBe(404);
    expectEnvelope(second.body, "COMMENT_NOT_FOUND");
  });

  it("returns 404 for a non-numeric :commentId", async () => {
    const task = await makeTask();

    const res = await request(app).delete(`${commentsUrl(task.id)}/abc`);

    expect(res.status).toBe(404);
    expectEnvelope(res.body, "COMMENT_NOT_FOUND");
  });
});

/* ------------------------------------------------------------------ *
 * Absent verbs
 * ------------------------------------------------------------------ */

describe("comment verbs that are deliberately not implemented", () => {
  it("has no PUT — comments are append-only, so it falls through to NOT_FOUND", async () => {
    const task = await makeTask();
    const comment = await makeComment({ taskId: task.id });

    const res = await request(app)
      .put(`${commentsUrl(task.id)}/${comment.id}`)
      .send({ body: "edited" });

    expect(res.status).toBe(404);
    expectEnvelope(res.body, "NOT_FOUND");
  });

  it("has no GET list — the thread ships with the task", async () => {
    const task = await makeTask();

    const res = await request(app).get(commentsUrl(task.id));

    expect(res.status).toBe(404);
    expectEnvelope(res.body, "NOT_FOUND");
  });
});
