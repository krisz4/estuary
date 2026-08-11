import { describe, expect, it } from "vitest";
import {
  createTicketInputSchema,
  hasAtLeastOneField,
  TICKET_CATEGORIES,
  TICKET_DESCRIPTION_MAX,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TITLE_MAX,
  ticketFacetsSchema,
  ticketIdParamSchema,
  ticketSchema,
  ticketSummarySchema,
  updateTicketInputSchema,
} from "./ticket.js";
import { parseReference } from "./reference.js";

const validCreate = {
  title: "Laptop won't connect to the VPN",
  description: "Fails with error 809 since the Tuesday update. Tried rebooting.",
  requesterName: "Dana Whitfield",
  requesterEmail: "dana.whitfield@example.com",
};

describe("enums", () => {
  it("declares statuses in lifecycle order (the index is statusRank)", () => {
    expect([...TICKET_STATUSES]).toEqual(["open", "in_progress", "resolved", "closed"]);
  });

  it("declares priorities in ascending severity order (the index is priorityRank)", () => {
    expect([...TICKET_PRIORITIES]).toEqual(["low", "medium", "high", "urgent"]);
  });

  it("declares the six categories", () => {
    expect([...TICKET_CATEGORIES]).toEqual([
      "hardware",
      "software",
      "network",
      "access",
      "email",
      "other",
    ]);
  });
});

describe("createTicketInputSchema", () => {
  it("accepts the documented payload and defaults priority to medium", () => {
    const parsed = createTicketInputSchema.parse(validCreate);
    expect(parsed.priority).toBe("medium");
  });

  it("trims title and description", () => {
    const parsed = createTicketInputSchema.parse({
      ...validCreate,
      title: `   ${validCreate.title}   `,
    });
    expect(parsed.title).toBe(validCreate.title);
  });

  it("lowercases and trims requesterEmail in the schema, not the service", () => {
    const parsed = createTicketInputSchema.parse({
      ...validCreate,
      requesterEmail: "  Dana.Whitfield@Example.COM ",
    });
    expect(parsed.requesterEmail).toBe("dana.whitfield@example.com");
  });

  // --- behavior 1: .strict() ------------------------------------------------

  it.each(["id", "createdAt", "updatedAt", "resolvedAt", "closedAt", "status", "reference"])(
    "rejects a client-supplied %s instead of silently stripping it",
    (field) => {
      const result = createTicketInputSchema.safeParse({ ...validCreate, [field]: 1 });
      expect(result.success).toBe(false);
    },
  );

  // --- behavior 2: "" → null ------------------------------------------------

  it("stores an empty assignee as null, not as an empty string", () => {
    const parsed = createTicketInputSchema.parse({ ...validCreate, assignee: "" });
    expect(parsed.assignee).toBeNull();
  });

  it("treats a whitespace-only assignee as null too", () => {
    expect(createTicketInputSchema.parse({ ...validCreate, assignee: "   " }).assignee).toBeNull();
  });

  it("stores an empty category as null, not as an empty string", () => {
    expect(createTicketInputSchema.parse({ ...validCreate, category: "" }).category).toBeNull();
  });

  it("accepts an explicit null for assignee and category", () => {
    const parsed = createTicketInputSchema.parse({
      ...validCreate,
      assignee: null,
      category: null,
    });
    expect(parsed).toMatchObject({ assignee: null, category: null });
  });

  it("trims a non-empty assignee", () => {
    expect(
      createTicketInputSchema.parse({ ...validCreate, assignee: "  Marcus Feld " }).assignee,
    ).toBe("Marcus Feld");
  });

  it("still enforces the length bound on a non-empty assignee", () => {
    expect(createTicketInputSchema.safeParse({ ...validCreate, assignee: "M" }).success).toBe(
      false,
    );
  });

  // --- field validation -----------------------------------------------------

  it.each([
    ["title", "abc"],
    ["title", "x".repeat(TICKET_TITLE_MAX + 1)],
    ["description", "short"],
    ["description", "x".repeat(TICKET_DESCRIPTION_MAX + 1)],
    ["requesterName", "D"],
    ["requesterEmail", "not-an-email"],
    ["priority", "critical"],
    ["category", "hardwear"],
  ])("names %s in the issue path when it is invalid", (field, value) => {
    const result = createTicketInputSchema.safeParse({ ...validCreate, [field]: value });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([field]);
  });

  it("requires the mandatory fields", () => {
    const result = createTicketInputSchema.safeParse({});
    expect(result.success).toBe(false);
    const fields = new Set(result.error?.issues.map((issue) => issue.path[0]));
    expect(fields).toEqual(new Set(["title", "description", "requesterName", "requesterEmail"]));
  });
});

describe("updateTicketInputSchema", () => {
  it("accepts a single field", () => {
    expect(updateTicketInputSchema.parse({ status: "resolved" })).toEqual({ status: "resolved" });
  });

  it("parses an empty body successfully — AT_LEAST_ONE_FIELD is its own code, not a zod issue", () => {
    const parsed = updateTicketInputSchema.parse({});
    expect(parsed).toEqual({});
    expect(hasAtLeastOneField(parsed)).toBe(false);
    expect(hasAtLeastOneField({ status: "open" })).toBe(true);
  });

  it("clears assignee to null when the edit form posts an empty string", () => {
    // The regression test for the empty-string-vs-null trap: stored as "", the
    // ticket would match neither assigneeIsNull=true nor any name filter.
    expect(updateTicketInputSchema.parse({ assignee: "" }).assignee).toBeNull();
  });

  it("clears category to null when the edit form posts an empty string", () => {
    expect(updateTicketInputSchema.parse({ category: "" }).category).toBeNull();
  });

  it("rejects immutable and derived fields", () => {
    for (const field of [
      "id",
      "createdAt",
      "reference",
      "resolvedAt",
      "closedAt",
      "commentCount",
    ]) {
      expect(updateTicketInputSchema.safeParse({ [field]: 1 }).success).toBe(false);
    }
  });

  it("does not coerce — a JSON body is not a query string", () => {
    expect(updateTicketInputSchema.safeParse({ title: 12345 }).success).toBe(false);
  });
});

describe("ticketIdParamSchema", () => {
  it("coerces a numeric path segment", () => {
    expect(ticketIdParamSchema.parse("42")).toBe(42);
  });

  it.each(["abc", "-1", "0", "4.5", "facets"])("rejects %s", (value) => {
    expect(ticketIdParamSchema.safeParse(value).success).toBe(false);
  });

  // `z.coerce.number()` accepts all three of these and resolves every one of
  // them to ticket 42, giving the same ticket four URLs. Decimal digits only.
  it.each(["0x2a", "1e3", " 12 ", "+7", "12\n"])("rejects the alias spelling %j", (value) => {
    expect(ticketIdParamSchema.safeParse(value).success).toBe(false);
  });

  it("agrees with parseReference on what is a valid id", () => {
    // Two parsers for the same concept must not disagree, or `q=1e3` and
    // `/tickets/1e3` resolve differently.
    expect(parseReference("1e3")).toBeNull();
    expect(ticketIdParamSchema.safeParse("1e3").success).toBe(false);
  });
});

describe("ticket response schemas", () => {
  const ticket = {
    id: 42,
    reference: "HD-000042",
    title: "Laptop won't connect to the VPN",
    description: "Fails with error 809 since the Tuesday update.",
    status: "in_progress",
    priority: "high",
    category: "network",
    requesterName: "Dana Whitfield",
    requesterEmail: "dana.whitfield@example.com",
    assignee: "Marcus Feld",
    createdAt: "2026-08-03T09:14:22.000Z",
    updatedAt: "2026-08-04T11:02:41.000Z",
    resolvedAt: null,
    closedAt: null,
    commentCount: 3,
    comments: [],
  };

  it("accepts the documented detail shape", () => {
    expect(ticketSchema.parse(ticket)).toEqual(ticket);
  });

  it("never carries the DB-only rank columns", () => {
    expect(ticketSchema.safeParse({ ...ticket, statusRank: 1, priorityRank: 2 }).success).toBe(
      false,
    );
  });

  it("derives the summary by omitting comments, keeping commentCount", () => {
    const { comments: _comments, ...summary } = ticket;
    expect(ticketSummarySchema.parse(summary)).toEqual(summary);
    expect(ticketSummarySchema.safeParse(ticket).success).toBe(false);
  });
});

describe("ticketFacetsSchema", () => {
  it("accepts distinct assignees and categories", () => {
    const facets = { assignees: ["Marcus Feld", "Priya Raman"], categories: ["access", "network"] };
    expect(ticketFacetsSchema.parse(facets)).toEqual(facets);
  });

  it("rejects a category outside the enum", () => {
    expect(ticketFacetsSchema.safeParse({ assignees: [], categories: ["misc"] }).success).toBe(
      false,
    );
  });
});
