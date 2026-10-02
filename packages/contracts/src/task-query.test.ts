import { describe, expect, it } from "vitest";
import {
  DEFAULT_TASK_SORT,
  dropEmptyQueryValues,
  formatTaskSort,
  paginatedTasksSchema,
  TASK_SORT_FIELDS,
  taskListQuerySchema,
  taskStatsQuerySchema,
  parseSearchTerms,
  TASK_Q_MAX_TERMS,
} from "./task-query.js";
import { buildPaginationMeta, MAX_PAGE, MAX_PAGE_SIZE } from "./pagination.js";
import { TASK_STATUSES } from "./task.js";

const parse = (query: Record<string, unknown>) => taskListQuerySchema.safeParse(query);
const fieldErrors = (query: Record<string, unknown>) =>
  new Set(parse(query).error?.issues.map((issue) => issue.path[0]));

describe("defaults", () => {
  it("fills page, pageSize, and sort from an empty query", () => {
    expect(taskListQuerySchema.parse({})).toEqual({
      page: 1,
      pageSize: 20,
      sort: { field: "createdAt", direction: "desc" },
    });
  });

  it("exposes the default sort in its wire form", () => {
    expect(DEFAULT_TASK_SORT).toBe("createdAt:desc");
    expect(formatTaskSort({ field: "createdAt", direction: "desc" })).toBe(DEFAULT_TASK_SORT);
  });
});

// --- behavior 3: empty values are absent, not malformed ---------------------

describe("empty query values", () => {
  it("treats ?page=&pageSize= as absent and falls back to the defaults", () => {
    // Without the preprocessor, z.coerce.number() turns "" into 0, which fails
    // min(1) and 422s a request the user never meant to make.
    const parsed = taskListQuerySchema.parse({ page: "", pageSize: "" });
    expect(parsed).toMatchObject({ page: 1, pageSize: 20 });
  });

  it("makes ?page=&status=&q=&sort= behave exactly like ?", () => {
    expect(
      taskListQuerySchema.parse({
        page: "",
        status: "",
        q: "",
        sort: "",
        assignee: "",
        createdFrom: "",
        project: "",
        createdBy: "",
        parentId: "",
      }),
    ).toEqual(taskListQuerySchema.parse({}));
  });

  it("drops empty entries from a repeated param and the param itself when none remain", () => {
    expect(taskListQuerySchema.parse({ status: ["", "todo", ""] }).status).toEqual(["todo"]);
    expect(taskListQuerySchema.parse({ status: ["", ""] }).status).toBeUndefined();
  });

  it("does not mutate the input object", () => {
    const input = { page: "", status: "todo" };
    dropEmptyQueryValues(input);
    expect(input).toEqual({ page: "", status: "todo" });
  });

  it("treats a whitespace-only value as absent, exactly like an empty one", () => {
    // ?q=%20 is what typing a single space into the search box produces. It
    // carries as little intent as ?q=, and 422ing one but not the other is a
    // distinction the user cannot see.
    expect(taskListQuerySchema.parse({ q: " " })).toEqual(taskListQuerySchema.parse({}));
    expect(parse({ assignee: "   " }).success).toBe(true);
    expect(taskListQuerySchema.parse({ status: [" ", "todo"] }).status).toEqual(["todo"]);
  });
});

describe("paging", () => {
  it("coerces numeric strings", () => {
    expect(taskListQuerySchema.parse({ page: "3", pageSize: "50" })).toMatchObject({
      page: 3,
      pageSize: 50,
    });
  });

  it.each([
    ["page", "0"],
    ["page", "-1"],
    ["page", "abc"],
    ["page", "1.5"],
    ["pageSize", "0"],
    ["pageSize", "101"],
  ])("rejects %s=%s", (field, value) => {
    const result = parse({ [field]: value });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([field]);
  });

  it("rejects pageSize=101 rather than clamping it to 100 — clamping hides a client bug", () => {
    expect(parse({ pageSize: "101" }).success).toBe(false);
    expect(taskListQuerySchema.parse({ pageSize: "100" }).pageSize).toBe(100);
  });

  it("bounds page, so an absurd one is a 422 and not an Int32 overflow in the service", () => {
    // skip = (page - 1) * pageSize is an Int32 in Prisma's query engine. Left
    // unbounded, ?page=99999999999 overflows and 500s instead of returning the
    // documented empty page with correct meta.
    expect(parse({ page: "99999999999" }).success).toBe(false);
    expect(taskListQuerySchema.parse({ page: String(MAX_PAGE) }).page).toBe(MAX_PAGE);
    expect((MAX_PAGE - 1) * MAX_PAGE_SIZE).toBeLessThan(2 ** 31 - 1);
  });
});

describe("created date range", () => {
  it("accepts a well-ordered range and a single open-ended bound", () => {
    expect(parse({ createdFrom: "2026-01-01", createdTo: "2026-08-11" }).success).toBe(true);
    expect(parse({ createdFrom: "2026-01-01" }).success).toBe(true);
    expect(parse({ createdTo: "2026-08-11" }).success).toBe(true);
  });

  it("accepts an equal from/to — a single named day is a valid range", () => {
    expect(parse({ createdFrom: "2026-08-11", createdTo: "2026-08-11" }).success).toBe(true);
  });

  it("rejects an inverted range instead of silently returning nothing", () => {
    // An empty list with no explanation reads as "no tasks exist", not as
    // "your two date pickers disagree".
    const result = parse({ createdFrom: "2026-08-11", createdTo: "2026-01-01" });
    expect(result.success).toBe(false);
    expect(fieldErrors({ createdFrom: "2026-08-11", createdTo: "2026-01-01" })).toEqual(
      new Set(["createdTo"]),
    );
  });
});

describe("sorting", () => {
  it.each(TASK_SORT_FIELDS)("accepts %s in both directions", (field) => {
    expect(taskListQuerySchema.parse({ sort: `${field}:asc` }).sort).toEqual({
      field,
      direction: "asc",
    });
    expect(taskListQuerySchema.parse({ sort: `${field}:desc` }).sort).toEqual({
      field,
      direction: "desc",
    });
  });

  it.each(["assignee:asc", "createdAt", "createdAt:sideways", "createdAt:asc:desc", ":asc"])(
    "rejects %s",
    (sort) => {
      const result = parse({ sort });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["sort"]);
    },
  );

  it("names the allowed fields in the message for an unknown sort field", () => {
    const message = parse({ sort: "assignee:asc" }).error?.issues[0]?.message ?? "";
    expect(message).toContain("createdAt");
  });
});

describe("filters", () => {
  it("wraps a single value into an array (OR within one param)", () => {
    expect(taskListQuerySchema.parse({ status: "todo" }).status).toEqual(["todo"]);
  });

  it("keeps repeated values as an array", () => {
    expect(taskListQuerySchema.parse({ status: ["todo", "in_progress"] }).status).toEqual([
      "todo",
      "in_progress",
    ]);
  });

  it("accepts every one of the ten statuses", () => {
    expect(taskListQuerySchema.parse({ status: [...TASK_STATUSES] }).status).toEqual([
      ...TASK_STATUSES,
    ]);
  });

  it("combines different params (AND across params)", () => {
    const parsed = taskListQuerySchema.parse({
      status: ["todo", "blocked"],
      priority: "urgent",
      project: "estuary",
    });
    expect(parsed).toMatchObject({
      status: ["todo", "blocked"],
      priority: ["urgent"],
      project: ["estuary"],
    });
  });

  it("rejects a value outside the enum, including the retired helpdesk statuses", () => {
    expect(parse({ status: "open" }).success).toBe(false);
    expect(parse({ status: ["todo", "resolved"] }).success).toBe(false);
  });

  it("rejects the retired category and requesterEmail filters as unknown params", () => {
    expect(parse({ category: "network" }).success).toBe(false);
    expect(parse({ requesterEmail: "dana@example.com" }).success).toBe(false);
  });

  // --- project --------------------------------------------------------------

  it("lowercases project to match how it is stored, one value or several", () => {
    expect(taskListQuerySchema.parse({ project: " Estuary " }).project).toEqual(["estuary"]);
    expect(taskListQuerySchema.parse({ project: ["Estuary", "INFRA"] }).project).toEqual([
      "estuary",
      "infra",
    ]);
  });

  it("rejects a project that is not a slug, naming the field", () => {
    const result = parse({ project: ["estuary", "my project"] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path[0]).toBe("project");
  });

  // --- createdBy ------------------------------------------------------------

  it("lowercases createdBy to match how actors are stored", () => {
    expect(taskListQuerySchema.parse({ createdBy: " Agent:Claude-Code " }).createdBy).toBe(
      "agent:claude-code",
    );
  });

  it("accepts system:taskmanager as a creator — it is a stored actor, not a wire one", () => {
    expect(taskListQuerySchema.parse({ createdBy: "system:taskmanager" }).createdBy).toBe(
      "system:taskmanager",
    );
  });

  it("bounds createdBy", () => {
    expect(parse({ createdBy: `agent:${"a".repeat(200)}` }).success).toBe(false);
  });

  // --- parentId -------------------------------------------------------------

  it("parses parentId from the query string", () => {
    expect(taskListQuerySchema.parse({ parentId: "7" }).parentId).toBe(7);
  });

  it.each(["0", "-1", "1.5", "abc"])("rejects parentId=%s", (parentId) => {
    const result = parse({ parentId });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["parentId"]);
  });

  // --- assignee -------------------------------------------------------------

  it("keeps assignee exactly as sent — matching is case-sensitive by design", () => {
    expect(taskListQuerySchema.parse({ assignee: "Marcus Feld" }).assignee).toBe("Marcus Feld");
  });

  it("accepts an assignee literally named None, which a sentinel value would have broken", () => {
    expect(taskListQuerySchema.parse({ assignee: "None" }).assignee).toBe("None");
  });

  it.each([
    ["true", true],
    ["1", true],
    ["false", false],
    ["0", false],
  ])("parses assigneeIsNull=%s as %s", (input, expected) => {
    expect(taskListQuerySchema.parse({ assigneeIsNull: input }).assigneeIsNull).toBe(expected);
  });

  it("rejects an ambiguous boolean instead of silently inverting the filter", () => {
    // z.coerce.boolean() would read "no" as true.
    expect(parse({ assigneeIsNull: "no" }).success).toBe(false);
  });

  it("accepts q up to 120 characters and rejects longer", () => {
    expect(taskListQuerySchema.parse({ q: "mcp" }).q).toBe("mcp");
    expect(parse({ q: "x".repeat(121) }).success).toBe(false);
  });

  it("accepts YYYY-MM-DD date bounds and rejects anything else", () => {
    expect(
      taskListQuerySchema.parse({ createdFrom: "2026-08-01", createdTo: "2026-08-11" }),
    ).toMatchObject({ createdFrom: "2026-08-01", createdTo: "2026-08-11" });

    for (const bad of ["11-08-2026", "2026-08-11T00:00:00Z", "2026-02-30", "yesterday"]) {
      expect(parse({ createdFrom: bad }).success).toBe(false);
    }
  });
});

// --- behavior 4: assignee + assigneeIsNull is a VALIDATION_ERROR -------------

describe("assignee / assigneeIsNull mutual exclusion", () => {
  it("rejects sending both, naming both fields", () => {
    const result = parse({ assignee: "Marcus Feld", assigneeIsNull: "true" });
    expect(result.success).toBe(false);
    expect(fieldErrors({ assignee: "Marcus Feld", assigneeIsNull: "true" })).toEqual(
      new Set(["assignee", "assigneeIsNull"]),
    );
  });

  it("rejects them together even when assigneeIsNull is false", () => {
    expect(parse({ assignee: "Marcus Feld", assigneeIsNull: "false" }).success).toBe(false);
  });

  it("accepts either one alone", () => {
    expect(parse({ assignee: "Marcus Feld" }).success).toBe(true);
    expect(parse({ assigneeIsNull: "true" }).success).toBe(true);
  });

  it("accepts assignee with an empty assigneeIsNull, since empty means absent", () => {
    expect(parse({ assignee: "Marcus Feld", assigneeIsNull: "" }).success).toBe(true);
  });
});

describe("unknown parameters", () => {
  it("rejects a typo'd filter rather than silently returning everything", () => {
    expect(parse({ statuses: "todo" }).success).toBe(false);
    expect(parse({ utm_source: "slack" }).success).toBe(false);
  });

  it("ignores an unknown parameter with an empty value — it carries no intent", () => {
    expect(parse({ utm_source: "" }).success).toBe(true);
  });
});

describe("taskStatsQuerySchema", () => {
  it("accepts an empty query — count every project", () => {
    expect(taskStatsQuerySchema.parse({})).toEqual({});
  });

  it("takes a repeatable, lowercased project filter", () => {
    expect(taskStatsQuerySchema.parse({ project: "Estuary" })).toEqual({ project: ["estuary"] });
    expect(taskStatsQuerySchema.parse({ project: ["estuary", "", "Infra"] })).toEqual({
      project: ["estuary", "infra"],
    });
  });

  it("treats an empty project as absent", () => {
    expect(taskStatsQuerySchema.parse({ project: "" })).toEqual({});
  });

  it("rejects every other list filter — a per-status count cannot be filtered by status", () => {
    for (const key of ["status", "priority", "assignee", "page", "q"]) {
      expect(taskStatsQuerySchema.safeParse({ [key]: "x" }).success, key).toBe(false);
    }
  });

  it("rejects a project that is not a slug", () => {
    expect(taskStatsQuerySchema.safeParse({ project: "my project" }).success).toBe(false);
  });
});

describe("paginatedTasksSchema", () => {
  it("envelopes task summaries with pagination meta", () => {
    const payload = {
      data: [
        {
          id: 42,
          reference: "TASK-000042",
          title: "Wire the MCP server to the task API",
          description: "Expose list, next, transition and comment as MCP tools.",
          status: "in_progress",
          statusNote: null,
          concerns: null,
          needsTriage: false,
          priority: "high",
          project: "estuary",
          assignee: null,
          acceptanceCriteria: "All five tools callable from Claude Code.",
          links: [],
          labels: [],
          parentId: null,
          childCount: 0,
          createdBy: "human:krisz",
          claim: { actor: "agent:claude-code", expiresAt: "2026-09-20T10:30:00.000Z" },
          version: 3,
          openDependencyCount: 0,
          openDecision: null,
          createdAt: "2026-09-18T09:14:22.000Z",
          updatedAt: "2026-09-20T10:00:00.000Z",
          startedAt: "2026-09-20T10:00:00.000Z",
          completedAt: null,
          commentCount: 3,
        },
      ],
      meta: buildPaginationMeta({ page: 1, pageSize: 20, total: 1 }),
    };
    expect(paginatedTasksSchema.parse(payload)).toEqual(payload);
  });

  it("rejects rows carrying comments — the list must not fan out into N queries", () => {
    const result = paginatedTasksSchema.safeParse({
      data: [{ id: 1, comments: [] }],
      meta: buildPaginationMeta({ page: 1, pageSize: 20, total: 1 }),
    });
    expect(result.success).toBe(false);
  });
});

describe("parseSearchTerms", () => {
  it("splits on whitespace and keeps quoted phrases whole", () => {
    expect(parseSearchTerms('"page resets" board')).toEqual(["page resets", "board"]);
    expect(parseSearchTerms("pagination  reset")).toEqual(["pagination", "reset"]);
  });

  it("dedupes case-insensitively, runs an unterminated quote to the end, and caps the count", () => {
    expect(parseSearchTerms("Board board")).toEqual(["Board"]);
    expect(parseSearchTerms('"open ended')).toEqual(["open ended"]);
    expect(parseSearchTerms("a b c d e f g h i j")).toHaveLength(TASK_Q_MAX_TERMS);
  });
});

describe("taskListQuerySchema — relation filters", () => {
  it("parses parentIsNull, dependsOn, dependencyOf, and label", () => {
    const parsed = taskListQuerySchema.parse({
      parentIsNull: "true",
      dependsOn: "4",
      dependencyOf: "18",
      label: ["Web", "api"],
    });
    expect(parsed).toMatchObject({
      parentIsNull: true,
      dependsOn: 4,
      dependencyOf: 18,
      label: ["web", "api"],
    });
  });

  it("refuses parentId together with parentIsNull", () => {
    expect(taskListQuerySchema.safeParse({ parentId: "3", parentIsNull: "false" }).success).toBe(
      false,
    );
  });
});
