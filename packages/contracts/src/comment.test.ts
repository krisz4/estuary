import { describe, expect, it } from "vitest";
import {
  COMMENT_BODY_MAX,
  commentIdParamSchema,
  commentSchema,
  createCommentInputSchema,
} from "./comment.js";
import { parseReference, TICKET_ID_MAX_DIGITS } from "./reference.js";
import { ticketIdParamSchema } from "./ticket.js";

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

describe("commentIdParamSchema", () => {
  it("accepts a decimal id and yields the number", () => {
    expect(commentIdParamSchema.parse("42")).toBe(42);
  });
});

/**
 * **The three parsers that turn user input into a ticket id, compared against
 * one another over one table.**
 *
 * They are `ticketIdParamSchema` (a path segment), `commentIdParamSchema` (the
 * same, for the child resource), and `parseReference` (a `q` search term). A
 * disagreement between any two of them is a URL that resolves one way through a
 * path and another way through search — which is exactly the bug this table
 * caught: with a bare `\d+` bound on the param schemas,
 * `/tickets/0000000000000000042` returned ticket 42 while
 * `?q=0000000000000000042` matched nothing, because `parseReference` caps its
 * digit run at 15 and the schemas did not.
 *
 * An earlier version of this test compared the two param schemas **only to each
 * other**, which is why it passed while they both disagreed with the third.
 */
describe("every parser that turns input into a ticket id agrees", () => {
  const INPUTS = [
    "42",
    "1",
    "0",
    "042",
    "007",
    "0000000000000000042",
    "999999999999999",
    "9999999999999999",
    "-1",
    "1.5",
    "0x2a",
    "1e3",
    " 12 ",
    "",
    "abc",
    "9007199254740993",
  ];

  it.each(INPUTS)("ticketIdParamSchema and commentIdParamSchema agree on %j", (input) => {
    const asTicket = ticketIdParamSchema.safeParse(input);
    const asComment = commentIdParamSchema.safeParse(input);

    expect(asComment.success).toBe(asTicket.success);
    expect(asComment.data).toBe(asTicket.data);
  });

  /**
   * `parseReference` additionally accepts the `HD-` and `#` prefixes, so the
   * comparison is only meaningful for a bare digit string — which is precisely
   * the overlap where a path segment and a search term mean the same thing.
   *
   * **Whitespace is the one deliberate divergence and is excluded here**, then
   * pinned by name below.
   */
  const TRIMMED = INPUTS.filter((input) => input === input.trim());

  it("has an untrimmed input in the table, so the filter above is not a no-op", () => {
    expect(TRIMMED.length).toBeLessThan(INPUTS.length);
  });

  it.each(TRIMMED)("ticketIdParamSchema and parseReference agree on %j", (input) => {
    const fromParam = ticketIdParamSchema.safeParse(input);
    const fromReference = parseReference(input);

    expect(
      fromParam.success,
      `param schema ${fromParam.success ? "accepted" : "rejected"} ${JSON.stringify(input)} ` +
        `but parseReference returned ${JSON.stringify(fromReference)}`,
    ).toBe(fromReference !== null);

    if (fromParam.success) expect(fromParam.data).toBe(fromReference);
  });

  /**
   * The divergence, stated rather than hidden: `parseReference` trims because a
   * user pastes a search term with stray whitespace and means the number inside
   * it. A **path segment** carries no such intent — `/tickets/%2012%20` is not a
   * URL any client builds on purpose, and accepting it would hand ticket 12 a
   * third alias URL for nothing. So the param schema is deliberately the
   * stricter of the two, and only in this direction.
   */
  it("diverges only on surrounding whitespace, with the param schema stricter", () => {
    expect(parseReference(" 12 ")).toBe(12);
    expect(ticketIdParamSchema.safeParse(" 12 ").success).toBe(false);
    expect(commentIdParamSchema.safeParse(" 12 ").success).toBe(false);

    // …and they agree again the moment the whitespace is gone.
    expect(ticketIdParamSchema.parse("12")).toBe(parseReference("12"));
  });

  it("caps all three at the same digit count, taken from one constant", () => {
    const widest = "9".repeat(TICKET_ID_MAX_DIGITS);
    const tooWide = "9".repeat(TICKET_ID_MAX_DIGITS + 1);

    expect(ticketIdParamSchema.safeParse(widest).success).toBe(true);
    expect(commentIdParamSchema.safeParse(widest).success).toBe(true);
    expect(parseReference(widest)).toBe(Number(widest));

    expect(ticketIdParamSchema.safeParse(tooWide).success).toBe(false);
    expect(commentIdParamSchema.safeParse(tooWide).success).toBe(false);
    expect(parseReference(tooWide)).toBeNull();
  });
});
