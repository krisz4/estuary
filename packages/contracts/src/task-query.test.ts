import { describe, expect, it } from "vitest";
import {
  DEFAULT_TICKET_SORT,
  dropEmptyQueryValues,
  formatTicketSort,
  paginatedTicketsSchema,
  TICKET_SORT_FIELDS,
  ticketListQuerySchema,
} from "./ticket-query.js";
import { buildPaginationMeta, MAX_PAGE, MAX_PAGE_SIZE } from "./pagination.js";

const parse = (query: Record<string, unknown>) => ticketListQuerySchema.safeParse(query);
const fieldErrors = (query: Record<string, unknown>) =>
  new Set(parse(query).error?.issues.map((issue) => issue.path[0]));

describe("defaults", () => {
  it("fills page, pageSize, and sort from an empty query", () => {
    expect(ticketListQuerySchema.parse({})).toEqual({
      page: 1,
      pageSize: 20,
      sort: { field: "createdAt", direction: "desc" },
    });
  });

  it("exposes the default sort in its wire form", () => {
    expect(DEFAULT_TICKET_SORT).toBe("createdAt:desc");
    expect(formatTicketSort({ field: "createdAt", direction: "desc" })).toBe(DEFAULT_TICKET_SORT);
  });
});

// --- behavior 3: empty values are absent, not malformed ---------------------

describe("empty query values", () => {
  it("treats ?page=&pageSize= as absent and falls back to the defaults", () => {
    // Without the preprocessor, z.coerce.number() turns "" into 0, which fails
    // min(1) and 422s a request the user never meant to make.
    const parsed = ticketListQuerySchema.parse({ page: "", pageSize: "" });
    expect(parsed).toMatchObject({ page: 1, pageSize: 20 });
  });

  it("makes ?page=&status=&q=&sort= behave exactly like ?", () => {
    expect(
      ticketListQuerySchema.parse({
        page: "",
        status: "",
        q: "",
        sort: "",
        assignee: "",
        createdFrom: "",
        requesterEmail: "",
      }),
    ).toEqual(ticketListQuerySchema.parse({}));
  });

  it("drops empty entries from a repeated param and the param itself when none remain", () => {
    expect(ticketListQuerySchema.parse({ status: ["", "open", ""] }).status).toEqual(["open"]);
    expect(ticketListQuerySchema.parse({ status: ["", ""] }).status).toBeUndefined();
  });

  it("does not mutate the input object", () => {
    const input = { page: "", status: "open" };
    dropEmptyQueryValues(input);
    expect(input).toEqual({ page: "", status: "open" });
  });

  it("treats a whitespace-only value as absent, exactly like an empty one", () => {
    // ?q=%20 is what typing a single space into the search box produces. It
    // carries as little intent as ?q=, and 422ing one but not the other is a
    // distinction the user cannot see.
    expect(ticketListQuerySchema.parse({ q: " " })).toEqual(ticketListQuerySchema.parse({}));
    expect(parse({ assignee: "   " }).success).toBe(true);
    expect(ticketListQuerySchema.parse({ status: [" ", "open"] }).status).toEqual(["open"]);
  });
});

describe("paging", () => {
  it("coerces numeric strings", () => {
    expect(ticketListQuerySchema.parse({ page: "3", pageSize: "50" })).toMatchObject({
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
    expect(ticketListQuerySchema.parse({ pageSize: "100" }).pageSize).toBe(100);
  });

  it("bounds page, so an absurd one is a 422 and not an Int32 overflow in the service", () => {
    // skip = (page - 1) * pageSize is an Int32 in Prisma's query engine. Left
    // unbounded, ?page=99999999999 overflows and 500s instead of returning the
    // documented empty page with correct meta.
    expect(parse({ page: "99999999999" }).success).toBe(false);
    expect(ticketListQuerySchema.parse({ page: String(MAX_PAGE) }).page).toBe(MAX_PAGE);
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
    // An empty list with no explanation reads as "no tickets exist", not as
    // "your two date pickers disagree".
    const result = parse({ createdFrom: "2026-08-11", createdTo: "2026-01-01" });
    expect(result.success).toBe(false);
    expect(fieldErrors({ createdFrom: "2026-08-11", createdTo: "2026-01-01" })).toEqual(
      new Set(["createdTo"]),
    );
  });
});

describe("sorting", () => {
  it.each(TICKET_SORT_FIELDS)("accepts %s in both directions", (field) => {
    expect(ticketListQuerySchema.parse({ sort: `${field}:asc` }).sort).toEqual({
      field,
      direction: "asc",
    });
    expect(ticketListQuerySchema.parse({ sort: `${field}:desc` }).sort).toEqual({
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
    expect(ticketListQuerySchema.parse({ status: "open" }).status).toEqual(["open"]);
  });

  it("keeps repeated values as an array", () => {
    expect(ticketListQuerySchema.parse({ status: ["open", "in_progress"] }).status).toEqual([
      "open",
      "in_progress",
    ]);
  });

  it("combines different params (AND across params)", () => {
    const parsed = ticketListQuerySchema.parse({
      status: ["open", "resolved"],
      priority: "urgent",
      category: "network",
    });
    expect(parsed).toMatchObject({
      status: ["open", "resolved"],
      priority: ["urgent"],
      category: ["network"],
    });
  });

  it("rejects a value outside the enum", () => {
    expect(parse({ status: "backlog" }).success).toBe(false);
    expect(parse({ status: ["open", "backlog"] }).success).toBe(false);
  });

  it("lowercases requesterEmail to match how it is stored", () => {
    expect(
      ticketListQuerySchema.parse({ requesterEmail: " Dana@Example.COM " }).requesterEmail,
    ).toBe("dana@example.com");
  });

  it("keeps assignee exactly as sent — matching is case-sensitive by design", () => {
    expect(ticketListQuerySchema.parse({ assignee: "Marcus Feld" }).assignee).toBe("Marcus Feld");
  });

  it("accepts an assignee literally named None, which a sentinel value would have broken", () => {
    expect(ticketListQuerySchema.parse({ assignee: "None" }).assignee).toBe("None");
  });

  it.each([
    ["true", true],
    ["1", true],
    ["false", false],
    ["0", false],
  ])("parses assigneeIsNull=%s as %s", (input, expected) => {
    expect(ticketListQuerySchema.parse({ assigneeIsNull: input }).assigneeIsNull).toBe(expected);
  });

  it("rejects an ambiguous boolean instead of silently inverting the filter", () => {
    // z.coerce.boolean() would read "no" as true.
    expect(parse({ assigneeIsNull: "no" }).success).toBe(false);
  });

  it("accepts q up to 120 characters and rejects longer", () => {
    expect(ticketListQuerySchema.parse({ q: "vpn" }).q).toBe("vpn");
    expect(parse({ q: "x".repeat(121) }).success).toBe(false);
  });

  it("accepts YYYY-MM-DD date bounds and rejects anything else", () => {
    expect(
      ticketListQuerySchema.parse({ createdFrom: "2026-08-01", createdTo: "2026-08-11" }),
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
    expect(parse({ statuses: "open" }).success).toBe(false);
    expect(parse({ utm_source: "slack" }).success).toBe(false);
  });

  it("ignores an unknown parameter with an empty value — it carries no intent", () => {
    expect(parse({ utm_source: "" }).success).toBe(true);
  });
});

describe("paginatedTicketsSchema", () => {
  it("envelopes ticket summaries with pagination meta", () => {
    const payload = {
      data: [
        {
          id: 42,
          reference: "HD-000042",
          title: "Laptop won't connect to the VPN",
          description: "Fails with error 809.",
          status: "open",
          priority: "high",
          category: "network",
          requesterName: "Dana Whitfield",
          requesterEmail: "dana.whitfield@example.com",
          assignee: null,
          createdAt: "2026-08-03T09:14:22.000Z",
          updatedAt: "2026-08-04T11:02:41.000Z",
          resolvedAt: null,
          closedAt: null,
          commentCount: 3,
        },
      ],
      meta: buildPaginationMeta({ page: 1, pageSize: 20, total: 1 }),
    };
    expect(paginatedTicketsSchema.parse(payload)).toEqual(payload);
  });

  it("rejects rows carrying comments — the list must not fan out into N queries", () => {
    const result = paginatedTicketsSchema.safeParse({
      data: [{ id: 1, comments: [] }],
      meta: buildPaginationMeta({ page: 1, pageSize: 20, total: 1 }),
    });
    expect(result.success).toBe(false);
  });
});
