import { describe, expect, it } from "vitest";
import { TASK_STATUS_NOTE_MAX, TASK_STATUSES, type TaskStatus } from "./task.js";
import {
  addDependencyInputSchema,
  nextTaskInputSchema,
  nextTaskResponseSchema,
  releaseTaskInputSchema,
  transitionInputSchema,
} from "./task-workflow.js";

const decision = {
  question: "Which transport should the MCP server use?",
  options: [{ label: "stdio" }, { label: "http" }],
};

/**
 * The smallest valid payload for each target status. Everything below is
 * phrased as a variation on one of these, so a status whose requirements change
 * shows up as a single edited row rather than a scattering of fixtures.
 */
const MINIMAL: Record<TaskStatus, Record<string, unknown>> = {
  backlog: { to: "backlog" },
  needs_refinement: { to: "needs_refinement", reason: "Which repository is this for?" },
  todo: { to: "todo" },
  in_progress: { to: "in_progress" },
  blocked: { to: "blocked", reason: "Waiting on the staging database." },
  needs_user_decision: { to: "needs_user_decision", decision },
  needs_user_action: { to: "needs_user_action", instructions: "Add ANTHROPIC_API_KEY to CI." },
  needs_qa: { to: "needs_qa", summary: "Added the five MCP tools; run `pnpm test`." },
  done: { to: "done" },
  deferred: { to: "deferred", reason: "Parked until the v2 API lands." },
};

const parse = (payload: Record<string, unknown>) => transitionInputSchema.safeParse(payload);
const issuePaths = (payload: Record<string, unknown>) =>
  parse(payload).error?.issues.map((issue) => issue.path);

describe("transitionInputSchema", () => {
  it("has a minimal payload for every status, so the table below covers them all", () => {
    expect(Object.keys(MINIMAL)).toEqual([...TASK_STATUSES]);
  });

  it.each(TASK_STATUSES)("accepts the minimal payload for %s", (status) => {
    expect(transitionInputSchema.parse(MINIMAL[status])).toEqual(MINIMAL[status]);
  });

  it.each(TASK_STATUSES)("accepts expectedVersion on a transition to %s", (status) => {
    const parsed = transitionInputSchema.parse({ ...MINIMAL[status], expectedVersion: 5 });
    expect(parsed.expectedVersion).toBe(5);
  });

  it.each(TASK_STATUSES)("rejects an unknown key on a transition to %s", (status) => {
    expect(parse({ ...MINIMAL[status], bogus: true }).success).toBe(false);
  });

  // --- required payloads ----------------------------------------------------

  /**
   * What a status requires **is** the shape of its payload. A missing one is an
   * ordinary `VALIDATION_ERROR` naming the field, which an agent already knows
   * how to read and fix, rather than a bespoke transition error.
   */
  it.each([
    ["needs_refinement", "reason"],
    ["needs_user_decision", "decision"],
    ["needs_user_action", "instructions"],
    ["needs_qa", "summary"],
    ["deferred", "reason"],
  ] as const)("requires %s to carry %s, naming the field", (status, field) => {
    const { [field]: _dropped, ...rest } = MINIMAL[status];
    expect(issuePaths(rest)).toEqual([[field]]);
  });

  it.each([
    ["needs_refinement", "reason"],
    ["needs_user_action", "instructions"],
    ["needs_qa", "summary"],
    ["deferred", "reason"],
  ] as const)(
    "rejects a whitespace-only %s %s — it would become an empty statusNote",
    (status, field) => {
      expect(issuePaths({ ...MINIMAL[status], [field]: "   " })).toEqual([[field]]);
    },
  );

  it("trims the note that becomes the statusNote", () => {
    expect(transitionInputSchema.parse({ to: "deferred", reason: "  Later.  " })).toEqual({
      to: "deferred",
      reason: "Later.",
    });
  });

  it(`bounds a note at ${TASK_STATUS_NOTE_MAX} characters`, () => {
    expect(parse({ to: "deferred", reason: "x".repeat(TASK_STATUS_NOTE_MAX) }).success).toBe(true);
    expect(issuePaths({ to: "deferred", reason: "x".repeat(TASK_STATUS_NOTE_MAX + 1) })).toEqual([
      ["reason"],
    ]);
  });

  it("validates the decision request in place, with the path under decision", () => {
    const result = parse({
      to: "needs_user_decision",
      decision: { ...decision, options: [{ label: "stdio" }] },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["decision", "options"]);
  });

  // --- blocked: a reason, or the tasks it waits on --------------------------

  describe("to blocked", () => {
    it("accepts blockedBy alone — the dependencies explain the block", () => {
      expect(transitionInputSchema.parse({ to: "blocked", blockedBy: [7, 9] })).toEqual({
        to: "blocked",
        blockedBy: [7, 9],
      });
    });

    it("accepts a reason and blockedBy together", () => {
      expect(
        parse({ to: "blocked", reason: "Needs the schema first.", blockedBy: [7] }).success,
      ).toBe(true);
    });

    it.each([
      ["neither", {}],
      ["an empty blockedBy", { blockedBy: [] }],
    ])("rejects %s, putting the error on reason", (_label, extra) => {
      // One field to highlight, not two: `reason` is the one a human fills in.
      expect(issuePaths({ to: "blocked", ...extra })).toEqual([["reason"]]);
    });

    it.each([0, -1, 1.5, "7"])("rejects %j as a blocking task id", (id) => {
      const result = parse({ to: "blocked", blockedBy: [id] });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["blockedBy", 0]);
    });

    it("bounds blockedBy at 20 tasks", () => {
      const ids = Array.from({ length: 20 }, (_, index) => index + 1);
      expect(parse({ to: "blocked", blockedBy: ids }).success).toBe(true);
      expect(parse({ to: "blocked", blockedBy: [...ids, 21] }).success).toBe(false);
    });
  });

  // --- optional payloads ----------------------------------------------------

  it.each([
    ["backlog", { reason: "Not this sprint." }],
    ["todo", { reason: "Refined with the user." }],
    ["todo", { acceptanceCriteria: "All five tools callable from Claude Code." }],
    ["in_progress", { reason: "Picking this up." }],
    ["needs_qa", { links: [{ label: "PR #12", url: "https://github.com/acme/estuary/pull/12" }] }],
    ["done", { reason: "Verified on staging." }],
    ["needs_user_decision", { decision: { ...decision, recommendedOption: "stdio" } }],
  ] as const)("accepts the optional payload on %s: %j", (status, extra) => {
    expect(transitionInputSchema.parse({ ...MINIMAL[status], ...extra })).toMatchObject(extra);
  });

  it("turns an empty acceptanceCriteria on a todo transition into null", () => {
    // Null means "keep the stored criteria"; the service decides whether that is
    // enough for todo, since only it can see the stored value.
    expect(transitionInputSchema.parse({ to: "todo", acceptanceCriteria: "  " })).toEqual({
      to: "todo",
      acceptanceCriteria: null,
    });
  });

  it("rejects an invalid link on a needs_qa hand-off, naming the entry", () => {
    const result = parse({ ...MINIMAL.needs_qa, links: [{ label: "PR", url: "not a url" }] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["links", 0, "url"]);
  });

  // --- strictness per branch ------------------------------------------------

  it.each([
    ["done", { instructions: "Merge it." }],
    ["backlog", { summary: "Nothing to see." }],
    ["needs_qa", { decision }],
    ["in_progress", { blockedBy: [7] }],
    ["deferred", { acceptanceCriteria: "Later." }],
    ["needs_user_action", { reason: "Because." }],
  ] as const)("rejects a %s transition carrying another status's field %j", (status, extra) => {
    // Each branch is strict on its own: a field that means something for a
    // different target is a mistake worth a 422, not a silent strip.
    expect(parse({ ...MINIMAL[status], ...extra }).success).toBe(false);
  });

  // --- the discriminator ----------------------------------------------------

  it.each(["open", "resolved", "closed", "DONE", ""])("rejects the unknown status %j", (to) => {
    expect(issuePaths({ to })).toEqual([["to"]]);
  });

  it("rejects a payload with no to at all", () => {
    expect(issuePaths({ reason: "Just because." })).toEqual([["to"]]);
  });

  it.each([0, -1, 1.5, "3"])("rejects expectedVersion %j", (expectedVersion) => {
    expect(issuePaths({ to: "done", expectedVersion })).toEqual([["expectedVersion"]]);
  });
});

describe("nextTaskInputSchema", () => {
  it("accepts an empty body — any project, any priority", () => {
    expect(nextTaskInputSchema.parse({})).toEqual({});
  });

  it("lowercases the project filter, matching how projects are stored", () => {
    expect(nextTaskInputSchema.parse({ project: ["Estuary", " infra "] })).toEqual({
      project: ["estuary", "infra"],
    });
  });

  it("rejects an empty project list, a bare string, and a malformed slug", () => {
    // An empty list would read as "no project matches" and never return a task.
    expect(nextTaskInputSchema.safeParse({ project: [] }).success).toBe(false);
    expect(nextTaskInputSchema.safeParse({ project: "estuary" }).success).toBe(false);
    expect(nextTaskInputSchema.safeParse({ project: ["not a slug"] }).success).toBe(false);
  });

  it("accepts a known minPriority and rejects anything else", () => {
    expect(nextTaskInputSchema.parse({ minPriority: "high" })).toEqual({ minPriority: "high" });
    expect(nextTaskInputSchema.safeParse({ minPriority: "critical" }).success).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(nextTaskInputSchema.safeParse({ status: "todo" }).success).toBe(false);
  });
});

describe("nextTaskResponseSchema", () => {
  it("accepts { task: null } — nothing to do is not a 404", () => {
    expect(nextTaskResponseSchema.parse({ task: null })).toEqual({ task: null });
  });

  it("requires the task key and rejects extras", () => {
    expect(nextTaskResponseSchema.safeParse({}).success).toBe(false);
    expect(nextTaskResponseSchema.safeParse({ task: null, reason: "empty" }).success).toBe(false);
  });
});

describe("releaseTaskInputSchema", () => {
  it("accepts an empty body", () => {
    expect(releaseTaskInputSchema.parse({})).toEqual({});
  });

  it("accepts and trims a reason, with an expectedVersion", () => {
    expect(
      releaseTaskInputSchema.parse({ reason: "  Out of context.  ", expectedVersion: 2 }),
    ).toEqual({ reason: "Out of context.", expectedVersion: 2 });
  });

  it("rejects a whitespace-only reason, a bad expectedVersion, and unknown keys", () => {
    expect(releaseTaskInputSchema.safeParse({ reason: "  " }).success).toBe(false);
    expect(releaseTaskInputSchema.safeParse({ expectedVersion: 0 }).success).toBe(false);
    expect(releaseTaskInputSchema.safeParse({ to: "todo" }).success).toBe(false);
  });
});

describe("addDependencyInputSchema", () => {
  it("accepts a task id", () => {
    expect(addDependencyInputSchema.parse({ dependsOnId: 7 })).toEqual({ dependsOnId: 7 });
  });

  it.each([0, -1, 1.5, "7", null])("rejects dependsOnId %j", (dependsOnId) => {
    const result = addDependencyInputSchema.safeParse({ dependsOnId });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["dependsOnId"]);
  });

  it("requires dependsOnId and rejects unknown keys", () => {
    expect(addDependencyInputSchema.safeParse({}).success).toBe(false);
    // `taskId` comes from the path, never the body.
    expect(addDependencyInputSchema.safeParse({ dependsOnId: 7, taskId: 3 }).success).toBe(false);
  });
});
