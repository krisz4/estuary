import { apiErrorResponseSchema, commentSchema } from "@helpdesk/contracts";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { makeComment, makeTicket } from "../test/factories.js";

/**
 * `/api/v1/tickets/:ticketId/comments` route integration tests —
 * `docs/engineering/TESTING.md` § Comments.
 *
 * Three of these exist because of a specific failure mode rather than for
 * coverage: the missing-parent 404 (which is a 500 without the service's
 * explicit check), the cross-ticket delete 404 (which is a 200 without the
 * two-id scope), and the `updatedAt` assertion (which is what stops a comment
 * from floating its ticket to the top of an `updatedAt` sort).
 */

const app = createApp();

const commentsUrl = (ticketId: number | string) => `/api/v1/tickets/${ticketId}/comments`;

const validComment = {
  authorName: "Marcus Feld",
  body: "Reissued the VPN certificate — try again and let me know.",
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

describe("POST /api/v1/tickets/:ticketId/comments", () => {
  it("returns 201 with the created comment and a Location header", async () => {
    const ticket = await makeTicket();

    const res = await request(app).post(commentsUrl(ticket.id)).send(validComment);

    expect(res.status).toBe(201);
    expect(commentSchema.safeParse(res.body).success, JSON.stringify(res.body)).toBe(true);
    expect(res.body.ticketId).toBe(ticket.id);
    expect(res.headers.location).toBe(`${commentsUrl(ticket.id)}/${res.body.id}`);
  });

  it("appends the comment to the ticket's thread, in order", async () => {
    const ticket = await makeTicket();

    await request(app)
      .post(commentsUrl(ticket.id))
      .send({ ...validComment, body: "first comment" });
    await request(app)
      .post(commentsUrl(ticket.id))
      .send({ ...validComment, body: "second comment" });

    const detail = await request(app).get(`/api/v1/tickets/${ticket.id}`);

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
  it("returns 404 TICKET_NOT_FOUND, not 500, when the parent ticket does not exist", async () => {
    const res = await request(app).post(commentsUrl(999999)).send(validComment);

    expect(res.status).toBe(404);
    expectEnvelope(res.body, "TICKET_NOT_FOUND");
    expect(await prisma.comment.count()).toBe(0);
  });

  it("returns 404 for a non-numeric :ticketId", async () => {
    const res = await request(app).post(commentsUrl("abc")).send(validComment);

    expect(res.status).toBe(404);
    expectEnvelope(res.body, "TICKET_NOT_FOUND");
  });

  /**
   * `updatedAt` means "a ticket field changed". A busy thread must not keep
   * bumping its ticket to the top of an `updatedAt` sort.
   */
  it("does not change the ticket's updatedAt", async () => {
    const ticket = await makeTicket();

    await request(app).post(commentsUrl(ticket.id)).send(validComment);

    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.updatedAt.getTime()).toBe(ticket.updatedAt.getTime());
  });

  it.each([
    ["an empty body", { authorName: "Marcus Feld", body: "" }, "body"],
    ["a whitespace-only body", { authorName: "Marcus Feld", body: "   " }, "body"],
    ["an over-length body", { authorName: "Marcus Feld", body: "x".repeat(2001) }, "body"],
    ["a missing author", { body: "Something happened." }, "authorName"],
    ["a one-character author", { authorName: "M", body: "Something happened." }, "authorName"],
  ])("returns 422 VALIDATION_ERROR for %s", async (_label, payload, field) => {
    const ticket = await makeTicket();

    const res = await request(app).post(commentsUrl(ticket.id)).send(payload);

    expect(res.status).toBe(422);
    expectEnvelope(res.body, "VALIDATION_ERROR");
    expect(Object.keys(res.body.error.details)).toContain(field);
  });

  it("rejects server-owned keys rather than stripping them", async () => {
    const ticket = await makeTicket();

    const res = await request(app)
      .post(commentsUrl(ticket.id))
      .send({ ...validComment, id: 7, ticketId: 99 });

    expect(res.status).toBe(422);
    expect(await prisma.comment.count()).toBe(0);
  });

  it("validates the body before checking the parent, so a bad payload is still 422", async () => {
    const res = await request(app).post(commentsUrl(999999)).send({ authorName: "M", body: "" });

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

describe("DELETE /api/v1/tickets/:ticketId/comments/:commentId", () => {
  it("returns 204 with no body and removes the comment from the thread", async () => {
    const ticket = await makeTicket();
    const comment = await makeComment({ ticketId: ticket.id });

    const res = await request(app).delete(`${commentsUrl(ticket.id)}/${comment.id}`);

    expect(res.status).toBe(204);
    expect(res.text).toBe("");

    const detail = await request(app).get(`/api/v1/tickets/${ticket.id}`);
    expect(detail.body.comments).toEqual([]);
  });

  /**
   * The regression test for the two-id scope. With `deleteMany({ where: { id } })`
   * — or a `findUnique` that forgets to compare — this deletes another ticket's
   * comment and returns 204, which is both a data-loss bug and an enumeration
   * oracle.
   */
  it("returns 404 and deletes nothing when the comment belongs to another ticket", async () => {
    const mine = await makeTicket();
    const theirs = await makeTicket();
    const comment = await makeComment({ ticketId: theirs.id });

    const res = await request(app).delete(`${commentsUrl(mine.id)}/${comment.id}`);

    expect(res.status).toBe(404);
    expectEnvelope(res.body, "COMMENT_NOT_FOUND");
    expect(await prisma.comment.findUnique({ where: { id: comment.id } })).not.toBeNull();
  });

  it("returns 404 COMMENT_NOT_FOUND, not 403, so the path cannot be used as a probe", async () => {
    const mine = await makeTicket();
    const theirs = await makeTicket();
    const existing = await makeComment({ ticketId: theirs.id });

    const wrongOwner = await request(app).delete(`${commentsUrl(mine.id)}/${existing.id}`);
    const neverExisted = await request(app).delete(`${commentsUrl(mine.id)}/999999`);

    // Identical answers — that is the point.
    expect(wrongOwner.status).toBe(neverExisted.status);
    expect(wrongOwner.body.error.code).toBe(neverExisted.body.error.code);
    expect(wrongOwner.body.error.message).toBe(neverExisted.body.error.message);
  });

  it("returns 404, not 500, when the same comment is deleted twice", async () => {
    const ticket = await makeTicket();
    const comment = await makeComment({ ticketId: ticket.id });

    expect((await request(app).delete(`${commentsUrl(ticket.id)}/${comment.id}`)).status).toBe(204);

    const second = await request(app).delete(`${commentsUrl(ticket.id)}/${comment.id}`);
    expect(second.status).toBe(404);
    expectEnvelope(second.body, "COMMENT_NOT_FOUND");
  });

  it("returns 404 for a non-numeric :commentId", async () => {
    const ticket = await makeTicket();

    const res = await request(app).delete(`${commentsUrl(ticket.id)}/abc`);

    expect(res.status).toBe(404);
    expectEnvelope(res.body, "COMMENT_NOT_FOUND");
  });
});

/* ------------------------------------------------------------------ *
 * Absent verbs
 * ------------------------------------------------------------------ */

describe("comment verbs that are deliberately not implemented", () => {
  it("has no PUT — comments are append-only, so it falls through to NOT_FOUND", async () => {
    const ticket = await makeTicket();
    const comment = await makeComment({ ticketId: ticket.id });

    const res = await request(app)
      .put(`${commentsUrl(ticket.id)}/${comment.id}`)
      .send({ body: "edited" });

    expect(res.status).toBe(404);
    expectEnvelope(res.body, "NOT_FOUND");
  });

  it("has no GET list — the thread ships with the ticket", async () => {
    const ticket = await makeTicket();

    const res = await request(app).get(commentsUrl(ticket.id));

    expect(res.status).toBe(404);
    expectEnvelope(res.body, "NOT_FOUND");
  });
});
