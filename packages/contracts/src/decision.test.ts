import { describe, expect, it } from "vitest";
import {
  answerDecisionInputSchema,
  DECISION_ANSWER_MAX,
  DECISION_OPTIONS_MAX,
  DECISION_OPTIONS_MIN,
  DECISION_STATUSES,
  decisionRequestSchema,
  decisionSchema,
} from "./decision.js";

const options = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ label: `Option ${index + 1}` }));

const validRequest = {
  question: "Which transport should the MCP server use?",
  options: [
    { label: "stdio", description: "Simplest for Claude Code; one process per session." },
    { label: "http", description: "One shared server; needs a port." },
  ],
};

const issuePaths = (payload: unknown) =>
  decisionRequestSchema.safeParse(payload).error?.issues.map((issue) => issue.path);

describe("DECISION_STATUSES", () => {
  it("declares the three decision states", () => {
    expect([...DECISION_STATUSES]).toEqual(["open", "answered", "withdrawn"]);
  });
});

describe("decisionRequestSchema", () => {
  it("accepts a question with two options", () => {
    expect(decisionRequestSchema.parse(validRequest)).toEqual(validRequest);
  });

  it("trims the question, labels, and descriptions", () => {
    const parsed = decisionRequestSchema.parse({
      question: `  ${validRequest.question}  `,
      options: [{ label: " stdio ", description: " Simple. " }, { label: "http" }],
    });
    expect(parsed).toEqual({
      question: validRequest.question,
      options: [{ label: "stdio", description: "Simple." }, { label: "http" }],
    });
  });

  it(`accepts ${DECISION_OPTIONS_MIN} to ${DECISION_OPTIONS_MAX} options`, () => {
    expect(DECISION_OPTIONS_MIN).toBe(2);
    expect(DECISION_OPTIONS_MAX).toBe(6);
    for (let count = DECISION_OPTIONS_MIN; count <= DECISION_OPTIONS_MAX; count++) {
      expect(
        decisionRequestSchema.safeParse({ ...validRequest, options: options(count) }).success,
      ).toBe(true);
    }
  });

  it.each([0, 1, DECISION_OPTIONS_MAX + 1])("rejects %i options, naming the field", (count) => {
    // One option is not a decision, it is a notification.
    expect(issuePaths({ ...validRequest, options: options(count) })).toEqual([["options"]]);
  });

  it("rejects duplicate labels", () => {
    const result = decisionRequestSchema.safeParse({
      ...validRequest,
      options: [{ label: "stdio" }, { label: "http" }, { label: "stdio" }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ["options"],
      message: "Option labels must be unique",
    });
  });

  it("compares labels after trimming, so padding does not make a duplicate unique", () => {
    expect(
      decisionRequestSchema.safeParse({
        ...validRequest,
        options: [{ label: "stdio" }, { label: "  stdio " }],
      }).success,
    ).toBe(false);
  });

  it("accepts a recommendedOption that is one of the labels", () => {
    expect(
      decisionRequestSchema.parse({ ...validRequest, recommendedOption: "  stdio " })
        .recommendedOption,
    ).toBe("stdio");
  });

  it("rejects a recommendedOption the agent did not offer", () => {
    expect(issuePaths({ ...validRequest, recommendedOption: "grpc" })).toEqual([
      ["recommendedOption"],
    ]);
  });

  it("matches recommendedOption case-sensitively, like the answer's choice", () => {
    expect(issuePaths({ ...validRequest, recommendedOption: "STDIO" })).toEqual([
      ["recommendedOption"],
    ]);
  });

  it.each([
    ["question", "Why?"],
    ["question", "   "],
    ["options", [{ label: "" }, { label: "http" }]],
  ])("rejects an invalid %s", (field, value) => {
    const result = decisionRequestSchema.safeParse({ ...validRequest, [field]: value });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path[0]).toBe(field);
  });

  it("rejects unknown keys on the request and on an option", () => {
    expect(decisionRequestSchema.safeParse({ ...validRequest, status: "open" }).success).toBe(
      false,
    );
    expect(
      decisionRequestSchema.safeParse({
        ...validRequest,
        options: [{ label: "stdio", recommended: true }, { label: "http" }],
      }).success,
    ).toBe(false);
  });
});

describe("answerDecisionInputSchema", () => {
  it.each([
    ["a choice", { choice: "stdio" }],
    ["a note", { note: "Neither — use the existing HTTP API directly." }],
    ["both", { choice: "http", note: "But keep stdio working for one release." }],
  ])("accepts %s", (_label, payload) => {
    expect(answerDecisionInputSchema.parse(payload)).toEqual(payload);
  });

  it("rejects an empty answer, putting the error on choice", () => {
    const result = answerDecisionInputSchema.safeParse({});
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["choice"]]);
  });

  it("does not count a whitespace-only choice or note as an answer", () => {
    expect(answerDecisionInputSchema.safeParse({ choice: "  " }).success).toBe(false);
    expect(answerDecisionInputSchema.safeParse({ note: "  " }).success).toBe(false);
  });

  it(`bounds the note at ${DECISION_ANSWER_MAX} characters`, () => {
    expect(
      answerDecisionInputSchema.safeParse({ note: "x".repeat(DECISION_ANSWER_MAX) }).success,
    ).toBe(true);
    expect(
      answerDecisionInputSchema.safeParse({ note: "x".repeat(DECISION_ANSWER_MAX + 1) }).success,
    ).toBe(false);
  });

  it("rejects server-owned keys", () => {
    // `answeredBy` comes from X-Actor, never the body.
    expect(
      answerDecisionInputSchema.safeParse({ choice: "stdio", answeredBy: "human:krisz" }).success,
    ).toBe(false);
  });
});

describe("decisionSchema", () => {
  const open = {
    id: 3,
    taskId: 42,
    status: "open",
    question: validRequest.question,
    options: validRequest.options,
    recommendedOption: "stdio",
    context: null,
    requestedBy: "agent:claude-code",
    choice: null,
    note: null,
    answeredBy: null,
    createdAt: "2026-09-20T10:00:00.000Z",
    answeredAt: null,
  };

  it("accepts an open decision", () => {
    expect(decisionSchema.parse(open)).toEqual(open);
  });

  it("accepts an answered decision", () => {
    const answered = {
      ...open,
      status: "answered",
      choice: "http",
      note: "Keep stdio for one release.",
      answeredBy: "human:krisz",
      answeredAt: "2026-09-20T12:00:00.000Z",
    };
    expect(decisionSchema.parse(answered)).toEqual(answered);
  });

  it("sends absent optionals as null, not as missing keys", () => {
    const { context: _context, ...rest } = open;
    expect(decisionSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects an unknown status and extra keys", () => {
    expect(decisionSchema.safeParse({ ...open, status: "pending" }).success).toBe(false);
    expect(decisionSchema.safeParse({ ...open, updatedAt: open.createdAt }).success).toBe(false);
  });
});
