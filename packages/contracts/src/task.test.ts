import { describe, expect, it } from "vitest";
import {
  CREATABLE_TASK_STATUSES,
  createTaskInputSchema,
  DEFAULT_TASK_PRIORITY,
  DEFAULT_TASK_STATUS,
  hasAtLeastOneField,
  HUMAN_ATTENTION_STATUSES,
  TASK_DESCRIPTION_MAX,
  TASK_IDEMPOTENCY_KEY_MAX,
  TASK_LINKS_MAX,
  TASK_PRIORITIES,
  TASK_PROJECT_MAX,
  TASK_STATUS_LANES,
  TASK_STATUSES,
  TASK_TITLE_MAX,
  taskFacetsSchema,
  taskIdParamSchema,
  taskSchema,
  taskStatsSchema,
  taskSummarySchema,
  TERMINAL_TASK_STATUSES,
  updateTaskInputSchema,
} from "./task.js";
import { parseReference } from "./reference.js";

const validCreate = {
  title: "Wire the MCP server to the task API",
  description: "Expose list, next, transition and comment as MCP tools for Claude Code.",
};

const link = { label: "PR #12", url: "https://github.com/acme/helpdesk/pull/12" };

describe("enums", () => {
  it("declares statuses in lifecycle order (the index is statusRank)", () => {
    expect([...TASK_STATUSES]).toEqual([
      "backlog",
      "needs_refinement",
      "todo",
      "in_progress",
      "blocked",
      "needs_user_decision",
      "needs_user_action",
      "needs_qa",
      "done",
      "deferred",
    ]);
  });

  it("declares priorities in ascending severity order (the index is priorityRank)", () => {
    expect([...TASK_PRIORITIES]).toEqual(["low", "medium", "high", "urgent"]);
  });

  it("defaults a new task to backlog / medium", () => {
    expect(DEFAULT_TASK_STATUS).toBe("backlog");
    expect(DEFAULT_TASK_PRIORITY).toBe("medium");
  });
});

describe("status sets", () => {
  it("declares the four board lanes in order", () => {
    expect(Object.keys(TASK_STATUS_LANES)).toEqual(["plan", "doing", "waiting", "closed"]);
  });

  it("puts every status in exactly one lane", () => {
    // A status in no lane never renders on the board; a status in two renders
    // twice. Comparing the flattened lanes to the status list catches both.
    const laned = Object.values(TASK_STATUS_LANES).flat();
    expect(laned).toHaveLength(TASK_STATUSES.length);
    expect(new Set(laned)).toEqual(new Set(TASK_STATUSES));
  });

  it("makes the inbox exactly the three statuses waiting on a human", () => {
    expect([...HUMAN_ATTENTION_STATUSES]).toEqual([
      "needs_user_decision",
      "needs_user_action",
      "needs_qa",
    ]);
  });

  it("lets a task be created only in the plan lane", () => {
    expect([...CREATABLE_TASK_STATUSES]).toEqual(["backlog", "needs_refinement", "todo"]);
    expect([...CREATABLE_TASK_STATUSES]).toEqual([...TASK_STATUS_LANES.plan]);
  });

  it("makes the terminal statuses exactly the closed lane", () => {
    expect([...TERMINAL_TASK_STATUSES]).toEqual(["done", "deferred"]);
    expect([...TERMINAL_TASK_STATUSES]).toEqual([...TASK_STATUS_LANES.closed]);
  });

  it("includes the default status among the creatable ones", () => {
    expect(CREATABLE_TASK_STATUSES).toContain(DEFAULT_TASK_STATUS);
  });
});

describe("createTaskInputSchema", () => {
  it("accepts the minimal payload and fills status and priority defaults", () => {
    // `toEqual`, not `toMatchObject`: an optional field must stay absent, not
    // come back as an `undefined` key the service would then write.
    expect(createTaskInputSchema.parse(validCreate)).toEqual({
      ...validCreate,
      status: "backlog",
      priority: "medium",
    });
  });

  it("trims title and description", () => {
    const parsed = createTaskInputSchema.parse({
      title: `   ${validCreate.title}   `,
      description: `\n${validCreate.description}\n`,
    });
    expect(parsed).toMatchObject(validCreate);
  });

  it("requires the mandatory fields", () => {
    const result = createTaskInputSchema.safeParse({});
    expect(result.success).toBe(false);
    const fields = new Set(result.error?.issues.map((issue) => issue.path[0]));
    expect(fields).toEqual(new Set(["title", "description"]));
  });

  // --- behavior 1: .strict() ------------------------------------------------

  it.each([
    "id",
    "reference",
    "createdAt",
    "updatedAt",
    "startedAt",
    "completedAt",
    "createdBy",
    "version",
    "claim",
    "statusNote",
    "openDependencyCount",
    "commentCount",
  ])("rejects a client-supplied %s instead of silently stripping it", (field) => {
    const result = createTaskInputSchema.safeParse({ ...validCreate, [field]: 1 });
    expect(result.success).toBe(false);
  });

  it("rejects the retired helpdesk fields rather than ignoring them", () => {
    for (const field of ["category", "requesterName", "requesterEmail"]) {
      expect(createTaskInputSchema.safeParse({ ...validCreate, [field]: "x" }).success).toBe(false);
    }
  });

  // --- status ---------------------------------------------------------------

  it.each(
    TASK_STATUSES.filter(
      (status) => !(CREATABLE_TASK_STATUSES as readonly string[]).includes(status),
    ),
  )("rejects creating a task directly in %s — that is reached by a transition", (status) => {
    const result = createTaskInputSchema.safeParse({ ...validCreate, status });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["status"]);
  });

  it("accepts backlog and needs_refinement without acceptance criteria", () => {
    expect(createTaskInputSchema.parse({ ...validCreate, status: "backlog" }).status).toBe(
      "backlog",
    );
    expect(createTaskInputSchema.parse({ ...validCreate, status: "needs_refinement" }).status).toBe(
      "needs_refinement",
    );
  });

  it("accepts todo when acceptance criteria are present", () => {
    const parsed = createTaskInputSchema.parse({
      ...validCreate,
      status: "todo",
      acceptanceCriteria: "  All five tools callable from Claude Code.  ",
    });
    expect(parsed).toMatchObject({
      status: "todo",
      acceptanceCriteria: "All five tools callable from Claude Code.",
    });
  });

  it.each([
    ["missing", {}],
    ["empty", { acceptanceCriteria: "" }],
    ["whitespace-only", { acceptanceCriteria: "   " }],
    ["null", { acceptanceCriteria: null }],
  ])("rejects todo with %s acceptance criteria, naming the field", (_label, extra) => {
    // The error lands on `acceptanceCriteria`, not on `status` — the form
    // highlights the field the user has to fill in, not the one they chose.
    const result = createTaskInputSchema.safeParse({ ...validCreate, status: "todo", ...extra });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["acceptanceCriteria"]]);
  });

  it("reports the missing criteria alongside other field errors, not instead of them", () => {
    const result = createTaskInputSchema.safeParse({ ...validCreate, title: "x", status: "todo" });
    const fields = new Set(result.error?.issues.map((issue) => issue.path[0]));
    expect(fields).toEqual(new Set(["title", "acceptanceCriteria"]));
  });

  // --- project --------------------------------------------------------------

  it("lowercases and trims project in the schema, not the service", () => {
    // An exact-match filter on a case-sensitive column: `Helpdesk` and
    // `helpdesk` must not become two projects.
    expect(createTaskInputSchema.parse({ ...validCreate, project: "  Helpdesk " }).project).toBe(
      "helpdesk",
    );
  });

  it.each(["api.v2_next-1", "7", "x".repeat(TASK_PROJECT_MAX)])(
    "accepts the project slug %j",
    (project) => {
      expect(createTaskInputSchema.parse({ ...validCreate, project }).project).toBe(project);
    },
  );

  it.each([
    "my project",
    "-leading-dash",
    ".hidden",
    "acme/helpdesk",
    "café",
    "x".repeat(TASK_PROJECT_MAX + 1),
  ])("rejects the project %j, naming the field", (project) => {
    const result = createTaskInputSchema.safeParse({ ...validCreate, project });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["project"]);
  });

  // --- behavior 2: "" → null ------------------------------------------------

  it.each(["project", "assignee", "acceptanceCriteria"])(
    "stores an empty %s as null, not as an empty string",
    (field) => {
      expect(
        createTaskInputSchema.parse({ ...validCreate, [field]: "" })[field as "project"],
      ).toBeNull();
    },
  );

  it.each(["project", "assignee", "acceptanceCriteria"])(
    "treats a whitespace-only %s as null too",
    (field) => {
      expect(
        createTaskInputSchema.parse({ ...validCreate, [field]: "   " })[field as "project"],
      ).toBeNull();
    },
  );

  it("accepts an explicit null for project, assignee, and acceptance criteria", () => {
    const parsed = createTaskInputSchema.parse({
      ...validCreate,
      project: null,
      assignee: null,
      acceptanceCriteria: null,
    });
    expect(parsed).toMatchObject({ project: null, assignee: null, acceptanceCriteria: null });
  });

  it("trims a non-empty assignee", () => {
    expect(
      createTaskInputSchema.parse({ ...validCreate, assignee: "  agent:claude-code " }).assignee,
    ).toBe("agent:claude-code");
  });

  it("still enforces the length bound on a non-empty assignee", () => {
    expect(createTaskInputSchema.safeParse({ ...validCreate, assignee: "M" }).success).toBe(false);
  });

  // --- links ----------------------------------------------------------------

  it("accepts links and trims their labels", () => {
    const parsed = createTaskInputSchema.parse({
      ...validCreate,
      links: [{ ...link, label: "  PR #12 " }],
    });
    expect(parsed.links).toEqual([link]);
  });

  it("rejects a link with an invalid URL, naming the entry", () => {
    const result = createTaskInputSchema.safeParse({
      ...validCreate,
      links: [link, { label: "Branch", url: "not a url" }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["links", 1, "url"]);
  });

  it("rejects a link with an empty label or an extra key", () => {
    expect(
      createTaskInputSchema.safeParse({ ...validCreate, links: [{ ...link, label: "  " }] })
        .success,
    ).toBe(false);
    expect(
      createTaskInputSchema.safeParse({ ...validCreate, links: [{ ...link, kind: "pr" }] }).success,
    ).toBe(false);
  });

  it(`accepts ${TASK_LINKS_MAX} links and rejects one more`, () => {
    const links = Array.from({ length: TASK_LINKS_MAX }, () => link);
    expect(createTaskInputSchema.safeParse({ ...validCreate, links }).success).toBe(true);

    const result = createTaskInputSchema.safeParse({ ...validCreate, links: [...links, link] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["links"]);
  });

  // --- parentId -------------------------------------------------------------

  it("accepts a parent task id, or null for a top-level task", () => {
    expect(createTaskInputSchema.parse({ ...validCreate, parentId: 7 }).parentId).toBe(7);
    expect(createTaskInputSchema.parse({ ...validCreate, parentId: null }).parentId).toBeNull();
  });

  it.each([0, -1, 1.5, "7"])("rejects parentId %j", (parentId) => {
    const result = createTaskInputSchema.safeParse({ ...validCreate, parentId });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["parentId"]);
  });

  // --- idempotencyKey -------------------------------------------------------

  it("accepts and trims an idempotency key", () => {
    expect(
      createTaskInputSchema.parse({ ...validCreate, idempotencyKey: " claude-code:helpdesk:mcp " })
        .idempotencyKey,
    ).toBe("claude-code:helpdesk:mcp");
  });

  it(`bounds the idempotency key to 1..${TASK_IDEMPOTENCY_KEY_MAX} characters`, () => {
    const at = (idempotencyKey: string) =>
      createTaskInputSchema.safeParse({ ...validCreate, idempotencyKey }).success;

    expect(at("k")).toBe(true);
    expect(at("k".repeat(TASK_IDEMPOTENCY_KEY_MAX))).toBe(true);
    expect(at("k".repeat(TASK_IDEMPOTENCY_KEY_MAX + 1))).toBe(false);
    // An empty key would make every keyless retry collide on "".
    expect(at("")).toBe(false);
    expect(at("   ")).toBe(false);
  });

  // --- field validation -----------------------------------------------------

  it.each([
    ["title", "abc"],
    ["title", "x".repeat(TASK_TITLE_MAX + 1)],
    ["description", "short"],
    ["description", "x".repeat(TASK_DESCRIPTION_MAX + 1)],
    ["priority", "critical"],
    ["status", "open"],
    ["project", "not a slug"],
  ])("names %s in the issue path when it is invalid", (field, value) => {
    const result = createTaskInputSchema.safeParse({ ...validCreate, [field]: value });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([field]);
  });
});

describe("updateTaskInputSchema", () => {
  it("accepts a single field", () => {
    expect(updateTaskInputSchema.parse({ priority: "high" })).toEqual({ priority: "high" });
  });

  it("parses an empty body successfully — AT_LEAST_ONE_FIELD is its own code, not a zod issue", () => {
    const parsed = updateTaskInputSchema.parse({});
    expect(parsed).toEqual({});
    expect(hasAtLeastOneField(parsed)).toBe(false);
    expect(hasAtLeastOneField({ priority: "low" })).toBe(true);
  });

  it("does not count expectedVersion as a field", () => {
    // `{ expectedVersion: 3 }` changes nothing; it must still be
    // AT_LEAST_ONE_FIELD rather than a write that only bumps the version.
    const parsed = updateTaskInputSchema.parse({ expectedVersion: 3 });
    expect(parsed).toEqual({ expectedVersion: 3 });
    expect(hasAtLeastOneField(parsed)).toBe(false);
    expect(hasAtLeastOneField({ expectedVersion: 3, title: "Rename the thing" })).toBe(true);
  });

  it.each(TASK_STATUSES)("rejects status=%s — status changes go through /transition", (status) => {
    const result = updateTaskInputSchema.safeParse({ status });
    expect(result.success).toBe(false);
  });

  it.each([1, 42])("accepts expectedVersion %j", (expectedVersion) => {
    expect(updateTaskInputSchema.parse({ expectedVersion }).expectedVersion).toBe(expectedVersion);
  });

  it.each([0, -1, 1.5, "3"])("rejects expectedVersion %j", (expectedVersion) => {
    const result = updateTaskInputSchema.safeParse({ expectedVersion });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["expectedVersion"]);
  });

  it.each(["assignee", "project", "acceptanceCriteria"])(
    "clears %s to null when the edit form posts an empty string",
    (field) => {
      // The regression test for the empty-string-vs-null trap: stored as "", the
      // task would match neither the is-null filter nor any value filter.
      expect(updateTaskInputSchema.parse({ [field]: "" })[field as "assignee"]).toBeNull();
    },
  );

  it("lowercases project on edit exactly as on create", () => {
    expect(updateTaskInputSchema.parse({ project: "Helpdesk" }).project).toBe("helpdesk");
  });

  it("accepts parentId, including null to detach a subtask", () => {
    expect(updateTaskInputSchema.parse({ parentId: 7 })).toEqual({ parentId: 7 });
    expect(updateTaskInputSchema.parse({ parentId: null })).toEqual({ parentId: null });
  });

  it("lets acceptance criteria be cleared — the todo gate is not the schema's job here", () => {
    // The gate lives on create and on the transition; a PATCH carries no status
    // to check against, and only the service can see the stored one.
    expect(updateTaskInputSchema.parse({ acceptanceCriteria: null })).toEqual({
      acceptanceCriteria: null,
    });
  });

  it("rejects immutable, derived, and create-only fields", () => {
    for (const field of [
      "id",
      "reference",
      "createdAt",
      "updatedAt",
      "startedAt",
      "completedAt",
      "createdBy",
      "version",
      "claim",
      "statusNote",
      "openDependencyCount",
      "commentCount",
      "idempotencyKey",
    ]) {
      expect(updateTaskInputSchema.safeParse({ [field]: 1 }).success, field).toBe(false);
    }
  });

  it("does not coerce — a JSON body is not a query string", () => {
    expect(updateTaskInputSchema.safeParse({ title: 12345 }).success).toBe(false);
    expect(updateTaskInputSchema.safeParse({ parentId: "7" }).success).toBe(false);
  });
});

describe("taskIdParamSchema", () => {
  it("coerces a numeric path segment", () => {
    expect(taskIdParamSchema.parse("42")).toBe(42);
  });

  it.each(["abc", "-1", "0", "4.5", "facets", "next", "stats"])("rejects %s", (value) => {
    expect(taskIdParamSchema.safeParse(value).success).toBe(false);
  });

  // `z.coerce.number()` accepts all of these and resolves every one of them
  // to a task, giving the same task several URLs. Decimal digits only.
  it.each(["0x2a", "1e3", " 12 ", "+7", "12\n"])("rejects the alias spelling %j", (value) => {
    expect(taskIdParamSchema.safeParse(value).success).toBe(false);
  });

  it("agrees with parseReference on what is a valid id", () => {
    // Two parsers for the same concept must not disagree, or `q=1e3` and
    // `/tasks/1e3` resolve differently.
    expect(parseReference("1e3")).toBeNull();
    expect(taskIdParamSchema.safeParse("1e3").success).toBe(false);
  });
});

describe("task response schemas", () => {
  const decision = {
    id: 3,
    taskId: 42,
    status: "open",
    question: "Which transport should the MCP server use?",
    options: [{ label: "stdio", description: "Simplest for Claude Code." }, { label: "http" }],
    recommendedOption: "stdio",
    context: null,
    requestedBy: "agent:claude-code",
    choice: null,
    note: null,
    answeredBy: null,
    createdAt: "2026-09-20T10:00:00.000Z",
    answeredAt: null,
  };

  const summary = {
    id: 42,
    reference: "TASK-000042",
    title: "Wire the MCP server to the task API",
    description: "Expose list, next, transition and comment as MCP tools.",
    status: "needs_user_decision",
    statusNote: null,
    priority: "high",
    project: "helpdesk",
    assignee: null,
    acceptanceCriteria: "All five tools callable from Claude Code.",
    links: [link],
    labels: ["mcp"],
    parentId: null,
    childCount: 1,
    createdBy: "human:krisz",
    claim: null,
    version: 4,
    openDependencyCount: 0,
    openDecision: decision,
    createdAt: "2026-09-18T09:14:22.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z",
    startedAt: "2026-09-19T08:00:00.000Z",
    completedAt: null,
    commentCount: 3,
  };

  const ref = {
    id: 43,
    reference: "TASK-000043",
    title: "Write the tool schemas",
    status: "todo",
    project: "helpdesk",
  };

  const task = {
    ...summary,
    comments: [],
    decisions: [decision],
    parent: null,
    children: [ref],
    dependencies: [],
    dependents: [],
  };

  it("accepts a full summary", () => {
    expect(taskSummarySchema.parse(summary)).toEqual(summary);
  });

  it("accepts a live claim and a stored system: actor", () => {
    // `system:` is refused on input but is a legitimate author on output — the
    // server writes auto-unblocks as `system:taskmanager`.
    const claimed = {
      ...summary,
      status: "in_progress",
      openDecision: null,
      createdBy: "system:taskmanager",
      claim: { actor: "agent:claude-code", expiresAt: "2026-09-20T10:30:00.000Z" },
    };
    expect(taskSummarySchema.parse(claimed)).toEqual(claimed);
  });

  it("rejects a claim with extra keys or a non-ISO expiry", () => {
    const claim = { actor: "agent:claude-code", expiresAt: "2026-09-20T10:30:00.000Z" };
    expect(
      taskSummarySchema.safeParse({ ...summary, claim: { ...claim, version: 1 } }).success,
    ).toBe(false);
    expect(
      taskSummarySchema.safeParse({ ...summary, claim: { ...claim, expiresAt: "in 30 minutes" } })
        .success,
    ).toBe(false);
  });

  it("requires every summary field", () => {
    for (const key of Object.keys(summary)) {
      const { [key as keyof typeof summary]: _dropped, ...rest } = summary;
      expect(taskSummarySchema.safeParse(rest).success, key).toBe(false);
    }
  });

  it("accepts the documented detail shape", () => {
    expect(taskSchema.parse(task)).toEqual(task);
  });

  it("never carries the DB-only columns", () => {
    for (const extra of [
      { statusRank: 1 },
      { priorityRank: 2 },
      { claimedBy: "agent:claude-code" },
      { claimExpiresAt: "2026-09-20T10:30:00.000Z" },
      { idempotencyKey: "claude-code:helpdesk:mcp" },
    ]) {
      expect(taskSchema.safeParse({ ...task, ...extra }).success, Object.keys(extra)[0]).toBe(
        false,
      );
      expect(taskSummarySchema.safeParse({ ...summary, ...extra }).success).toBe(false);
    }
  });

  it("keeps the thread and relations off the summary, keeping commentCount", () => {
    for (const key of [
      "comments",
      "decisions",
      "parent",
      "children",
      "dependencies",
      "dependents",
    ]) {
      expect(
        taskSummarySchema.safeParse({ ...summary, [key]: task[key as keyof typeof task] }).success,
        key,
      ).toBe(false);
    }
  });

  it("rejects a relation ref with an unknown status or extra keys", () => {
    expect(taskSchema.safeParse({ ...task, children: [{ ...ref, status: "open" }] }).success).toBe(
      false,
    );
    expect(taskSchema.safeParse({ ...task, parent: { ...ref, priority: "low" } }).success).toBe(
      false,
    );
  });
});

describe("taskStatsSchema", () => {
  const byStatus = Object.fromEntries(TASK_STATUSES.map((status, index) => [status, index]));

  it("accepts a count for every status", () => {
    const stats = { byStatus, needsAttention: 7 };
    expect(taskStatsSchema.parse(stats)).toEqual(stats);
  });

  it.each(TASK_STATUSES)("requires the %s key — zero counts are sent, not omitted", (status) => {
    // Lane headers read `byStatus[status]` directly; a missing key would render
    // as "undefined" rather than 0.
    const { [status]: _dropped, ...rest } = byStatus;
    expect(taskStatsSchema.safeParse({ byStatus: rest, needsAttention: 0 }).success).toBe(false);
  });

  it("rejects an unknown status key and a negative count", () => {
    expect(
      taskStatsSchema.safeParse({ byStatus: { ...byStatus, open: 1 }, needsAttention: 0 }).success,
    ).toBe(false);
    expect(
      taskStatsSchema.safeParse({ byStatus: { ...byStatus, todo: -1 }, needsAttention: 0 }).success,
    ).toBe(false);
  });
});

describe("taskFacetsSchema", () => {
  it("accepts distinct assignees, projects, and creators", () => {
    const facets = {
      assignees: ["agent:claude-code", "human:krisz"],
      projects: ["helpdesk", "infra"],
      labels: ["api", "web"],
      creators: ["human:krisz", "system:taskmanager"],
    };
    expect(taskFacetsSchema.parse(facets)).toEqual(facets);
  });

  it("requires all three lists and rejects the retired categories facet", () => {
    expect(taskFacetsSchema.safeParse({ assignees: [], projects: [] }).success).toBe(false);
    expect(
      taskFacetsSchema.safeParse({ assignees: [], projects: [], creators: [], categories: [] })
        .success,
    ).toBe(false);
  });
});
