import { describe, expect, it } from "vitest";
import { COMMENT_BODY_MAX, commentSchema, createCommentInputSchema } from "./comment.js";

describe("createCommentInputSchema", () => {
  it("accepts and trims a valid comment", () => {
    expect(
      createCommentInputSchema.parse({
        authorName: "  Marcus Feld  ",
        body: "  Reissued the VPN certificate.  ",
      }),
    ).toEqual({ authorName: "Marcus Feld", body: "Reissued the VPN certificate." });
  });

  it("rejects an empty body, including whitespace-only", () => {
    expect(createCommentInputSchema.safeParse({ authorName: "Marcus", body: "" }).success).toBe(
      false,
    );
    expect(createCommentInputSchema.safeParse({ authorName: "Marcus", body: "   " }).success).toBe(
      false,
    );
  });

  it("rejects an over-length body", () => {
    const result = createCommentInputSchema.safeParse({
      authorName: "Marcus",
      body: "x".repeat(COMMENT_BODY_MAX + 1),
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["body"]);
  });

  it("rejects a missing author", () => {
    const result = createCommentInputSchema.safeParse({ body: "hello there" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["authorName"]);
  });

  it("rejects server-owned keys rather than stripping them", () => {
    const result = createCommentInputSchema.safeParse({
      id: 7,
      ticketId: 42,
      createdAt: "2026-08-11T00:00:00.000Z",
      authorName: "Marcus",
      body: "hello there",
    });
    expect(result.success).toBe(false);
  });
});

describe("commentSchema", () => {
  const comment = {
    id: 7,
    ticketId: 42,
    authorName: "Marcus Feld",
    body: "Reissued the VPN certificate.",
    createdAt: "2026-08-11T09:14:22.000Z",
  };

  it("accepts a serialized comment", () => {
    expect(commentSchema.parse(comment)).toEqual(comment);
  });

  it("requires createdAt to be an ISO 8601 string, not a Date", () => {
    expect(commentSchema.safeParse({ ...comment, createdAt: new Date() }).success).toBe(false);
  });

  it("has no updatedAt — comments are append-only", () => {
    expect(commentSchema.safeParse({ ...comment, updatedAt: comment.createdAt }).success).toBe(
      false,
    );
  });
});
