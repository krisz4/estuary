import { describe, expect, it } from "vitest";
import {
  COMMENT_BODY_MAX,
  COMMENT_KINDS,
  commentIdParamSchema,
  commentSchema,
  createCommentInputSchema,
} from "./comment.js";
import { parseReference, TASK_ID_MAX_DIGITS } from "./reference.js";
import { taskIdParamSchema } from "./task.js";

describe("createCommentInputSchema", () => {
  it("accepts and trims a valid comment, defaulting kind to note", () => {
    expect(
      createCommentInputSchema.parse({ body: "  Reproduced on main; the lease never expires.  " }),
    ).toEqual({ body: "Reproduced on main; the lease never expires.", kind: "note" });
  });

  it.each(COMMENT_KINDS)("accepts kind=%s", (kind) => {
    expect(createCommentInputSchema.parse({ body: "hello there", kind }).kind).toBe(kind);
  });

  it("declares the three comment kinds", () => {
    expect([...COMMENT_KINDS]).toEqual(["note", "progress", "qa_feedback"]);
  });

  it("rejects an unknown kind, naming the field", () => {
    const result = createCommentInputSchema.safeParse({ body: "hello there", kind: "log" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["kind"]);
  });

  it("rejects an empty body, including whitespace-only", () => {
    expect(createCommentInputSchema.safeParse({ body: "" }).success).toBe(false);
    expect(createCommentInputSchema.safeParse({ body: "   " }).success).toBe(false);
  });

  it("rejects an over-length body", () => {
    const result = createCommentInputSchema.safeParse({
      body: "x".repeat(COMMENT_BODY_MAX + 1),
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["body"]);
  });

  it("rejects a missing body", () => {
    const result = createCommentInputSchema.safeParse({ kind: "note" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["body"]);
  });

  it.each(["id", "taskId", "createdAt", "author", "authorName"])(
    "rejects a client-supplied %s rather than stripping it",
    (field) => {
      // `author` comes from the X-Actor header and `taskId` from the path; a
      // body carrying either is a client bug, not a spoofing opportunity.
      const result = createCommentInputSchema.safeParse({ body: "hello there", [field]: "x" });
      expect(result.success).toBe(false);
    },
  );
});

describe("commentSchema", () => {
  const comment = {
    id: 7,
    taskId: 42,
    author: "agent:claude-code",
    kind: "progress",
    body: "Tools registered; wiring transitions next.",
    createdAt: "2026-09-20T09:14:22.000Z",
  };

  it("accepts a serialized comment", () => {
    expect(commentSchema.parse(comment)).toEqual(comment);
  });

  it("accepts a system: author — stored actors are not limited to what the wire accepts", () => {
    expect(commentSchema.safeParse({ ...comment, author: "system:taskmanager" }).success).toBe(
      true,
    );
  });

  it("requires author and kind, and has no authorName", () => {
    const { author: _author, ...withoutAuthor } = comment;
    const { kind: _kind, ...withoutKind } = comment;
    expect(commentSchema.safeParse(withoutAuthor).success).toBe(false);
    expect(commentSchema.safeParse(withoutKind).success).toBe(false);
    expect(commentSchema.safeParse({ ...comment, authorName: "Marcus" }).success).toBe(false);
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
 * **The three parsers that turn user input into a task id, compared against
 * one another over one table.**
 *
 * They are `taskIdParamSchema` (a path segment), `commentIdParamSchema` (the
 * same, for the child resource), and `parseReference` (a `q` search term). A
 * disagreement between any two of them is a URL that resolves one way through a
 * path and another way through search — which is exactly the bug this table
 * caught: with a bare `\d+` bound on the param schemas,
 * `/tasks/0000000000000000042` returned task 42 while
 * `?q=0000000000000000042` matched nothing, because `parseReference` caps its
 * digit run at 15 and the schemas did not.
 *
 * An earlier version of this test compared the two param schemas **only to each
 * other**, which is why it passed while they both disagreed with the third.
 */
describe("every parser that turns input into a task id agrees", () => {
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

  it.each(INPUTS)("taskIdParamSchema and commentIdParamSchema agree on %j", (input) => {
    const asTask = taskIdParamSchema.safeParse(input);
    const asComment = commentIdParamSchema.safeParse(input);

    expect(asComment.success).toBe(asTask.success);
    expect(asComment.data).toBe(asTask.data);
  });

  /**
   * `parseReference` additionally accepts the `TASK-` and `#` prefixes, so the
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

  it.each(TRIMMED)("taskIdParamSchema and parseReference agree on %j", (input) => {
    const fromParam = taskIdParamSchema.safeParse(input);
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
   * it. A **path segment** carries no such intent — `/tasks/%2012%20` is not a
   * URL any client builds on purpose, and accepting it would hand task 12 a
   * third alias URL for nothing. So the param schema is deliberately the
   * stricter of the two, and only in this direction.
   */
  it("diverges only on surrounding whitespace, with the param schema stricter", () => {
    expect(parseReference(" 12 ")).toBe(12);
    expect(taskIdParamSchema.safeParse(" 12 ").success).toBe(false);
    expect(commentIdParamSchema.safeParse(" 12 ").success).toBe(false);

    // …and they agree again the moment the whitespace is gone.
    expect(taskIdParamSchema.parse("12")).toBe(parseReference("12"));
  });

  it("caps all three at the same digit count, taken from one constant", () => {
    const widest = "9".repeat(TASK_ID_MAX_DIGITS);
    const tooWide = "9".repeat(TASK_ID_MAX_DIGITS + 1);

    expect(taskIdParamSchema.safeParse(widest).success).toBe(true);
    expect(commentIdParamSchema.safeParse(widest).success).toBe(true);
    expect(parseReference(widest)).toBe(Number(widest));

    expect(taskIdParamSchema.safeParse(tooWide).success).toBe(false);
    expect(commentIdParamSchema.safeParse(tooWide).success).toBe(false);
    expect(parseReference(tooWide)).toBeNull();
  });
});
