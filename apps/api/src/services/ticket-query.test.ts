import { formatReference, ticketListQuerySchema, type TicketListQuery } from "@helpdesk/contracts";
import { describe, expect, it } from "vitest";

import { prisma } from "../lib/prisma.js";
import { makeTicket, makeTickets } from "../test/factories.js";
import {
  buildOrderBy,
  buildWhere,
  escapeLikePattern,
  listTickets,
  needsEscapedSearch,
  resolveTextSearch,
} from "./ticket-query.js";

/**
 * The list query, against a real (temp) SQLite file. Required cases come from
 * `docs/engineering/TESTING.md` § List query — the longest list in that
 * document, and the reason stage 7 exists as its own stage.
 *
 * Conventions that make these tests able to fail:
 *
 * 1. **Params go through `ticketListQuerySchema`**, never hand-built objects.
 *    Defaulting, `""`-dropping, coercion, and the mutual-exclusion refinement
 *    are all schema behaviour; a test that handed `listTickets` a pre-cooked
 *    object would assert nothing about the path a client actually takes.
 * 2. **Validation failures are asserted at the schema**, because routes do not
 *    exist yet (stage 8). Every "→ 422" bullet in TESTING.md is a
 *    `ticketListQuerySchema` rejection here; the HTTP status is the route's half
 *    of the same assertion.
 * 3. **Ordering is asserted as an exact id sequence**, not just as a set. A
 *    "page 1 and page 2 are disjoint" assertion alone passes on SQLite even with
 *    no tiebreaker, because the same plan runs for both offsets — the sequence
 *    is what actually pins the `{ id: "desc" }` clause.
 */

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Parse raw query params exactly as the route will. */
const query = (raw: Record<string, unknown> = {}): TicketListQuery =>
  ticketListQuerySchema.parse(raw);

/** Assert the schema rejects these params, naming the field it blamed. */
const expectRejected = (raw: Record<string, unknown>, path: string): void => {
  const result = ticketListQuerySchema.safeParse(raw);
  expect(result.success).toBe(false);
  const paths = result.error?.issues.map((issue) => issue.path.join(".")) ?? [];
  expect(paths).toContain(path);
};

/** Ids of the returned page, in the order the service returned them. */
const listIds = async (raw: Record<string, unknown> = {}): Promise<number[]> => {
  const page = await listTickets(query(raw));
  return page.data.map((ticket) => ticket.id);
};

/* ------------------------------------------------------------------ *
 * Defaults
 * ------------------------------------------------------------------ */

describe("defaults", () => {
  it("returns page 1 at size 20 sorted by createdAt descending when no params are sent", async () => {
    const [oldest, middle, newest] = await makeTickets(3, (index) => ({
      createdAt: new Date(Date.UTC(2026, 0, index + 1)),
    }));

    const page = await listTickets(query());

    expect(page.meta).toEqual({
      page: 1,
      pageSize: 20,
      total: 3,
      totalPages: 1,
      hasNextPage: false,
      hasPrevPage: false,
    });
    expect(page.data.map((ticket) => ticket.id)).toEqual([newest?.id, middle?.id, oldest?.id]);
  });

  it("returns summaries carrying commentCount rather than a comment array", async () => {
    const ticket = await makeTicket();

    const page = await listTickets(query());

    expect(page.data[0]).toMatchObject({
      id: ticket.id,
      reference: formatReference(ticket.id),
      commentCount: 0,
    });
    expect(page.data[0]).not.toHaveProperty("comments");
  });
});

/* ------------------------------------------------------------------ *
 * Paging
 * ------------------------------------------------------------------ */

describe("paging", () => {
  it("reports total, totalPages, and both page flags for a middle page", async () => {
    await makeTickets(5);

    const page = await listTickets(query({ page: "2", pageSize: "2" }));

    expect(page.meta).toEqual({
      page: 2,
      pageSize: 2,
      total: 5,
      totalPages: 3,
      hasNextPage: true,
      hasPrevPage: true,
    });
    expect(page.data).toHaveLength(2);
  });

  it("returns an empty page with correct meta beyond the end, not an error", async () => {
    await makeTickets(5);

    const page = await listTickets(query({ page: "9", pageSize: "2" }));

    expect(page.data).toEqual([]);
    expect(page.meta).toMatchObject({
      total: 5,
      totalPages: 3,
      // `page < totalPages`, so an over-the-end page says "no more", not "maybe".
      hasNextPage: false,
      hasPrevPage: true,
    });
  });

  it("reports one page rather than zero when nothing matches", async () => {
    await makeTicket({ status: "open" });

    const page = await listTickets(query({ status: "closed" }));

    expect(page.data).toEqual([]);
    // `Math.max(1, …)`. Zero would render as "Page 1 of 0" in the pager.
    expect(page.meta).toMatchObject({ total: 0, totalPages: 1, hasNextPage: false });
  });

  it("splits tied rows across pages without repeating or dropping one", async () => {
    // Every row shares a createdAt, so the default sort is entirely ties and the
    // `{ id: "desc" }` tiebreaker is the only thing making the order total.
    const createdAt = new Date(Date.UTC(2026, 4, 20));
    const tickets = await makeTickets(6, () => ({ createdAt }));
    const ids = tickets.map((ticket) => ticket.id);

    const first = await listIds({ page: "1", pageSize: "3" });
    const second = await listIds({ page: "2", pageSize: "3" });

    expect(first).toEqual([...ids].reverse().slice(0, 3));
    expect(second).toEqual([...ids].reverse().slice(3));
    expect(first.filter((id) => second.includes(id))).toEqual([]);
    expect([...first, ...second].sort((a, b) => a - b)).toEqual(ids);
  });
});

/* ------------------------------------------------------------------ *
 * Parameter validation
 * ------------------------------------------------------------------ */

describe("parameter validation", () => {
  it("rejects pageSize=0", () => {
    expectRejected({ pageSize: "0" }, "pageSize");
  });

  it("rejects pageSize=101 rather than clamping it to 100", () => {
    // Clamping would hide a client bug: the caller asked for 101 rows and would
    // be handed 100 with no indication the request was altered.
    expectRejected({ pageSize: "101" }, "pageSize");
    expect(ticketListQuerySchema.safeParse({ pageSize: "100" }).success).toBe(true);
  });

  it("rejects page=0", () => {
    expectRejected({ page: "0" }, "page");
  });

  it("falls back to defaults for empty values instead of rejecting them", () => {
    expect(query({ page: "", pageSize: "", status: "", sort: "", q: "" })).toMatchObject({
      page: 1,
      pageSize: 20,
      sort: { field: "createdAt", direction: "desc" },
    });
  });

  it("rejects an unknown sort field", () => {
    expectRejected({ sort: "requesterName:asc" }, "sort");
  });

  it("rejects an unknown query parameter", () => {
    const result = ticketListQuerySchema.safeParse({ utm_source: "slack" });

    expect(result.success).toBe(false);
    // `.strict()` reports unrecognised keys against the object itself, naming
    // them in `keys` rather than in `path` — a typo'd filter silently returning
    // everything is worse than an error.
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({ code: "unrecognized_keys", keys: ["utm_source"] }),
    );
  });

  it("rejects assignee together with assigneeIsNull", () => {
    expectRejected({ assignee: "Ada Chen", assigneeIsNull: "true" }, "assignee");
    expectRejected({ assignee: "Ada Chen", assigneeIsNull: "true" }, "assigneeIsNull");
  });
});

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

describe("filters", () => {
  it("matches a single value", async () => {
    const open = await makeTicket({ status: "open" });
    await makeTicket({ status: "closed" });

    expect(await listIds({ status: "open" })).toEqual([open.id]);
  });

  it("ORs repeated values within one parameter", async () => {
    const open = await makeTicket({ status: "open" });
    const inProgress = await makeTicket({ status: "in_progress" });
    await makeTicket({ status: "closed" });

    const ids = await listIds({ status: ["open", "in_progress"] });

    expect(ids.sort((a, b) => a - b)).toEqual([open.id, inProgress.id]);
  });

  it("ANDs across different parameters", async () => {
    const match = await makeTicket({ status: "open", priority: "urgent", category: "network" });
    await makeTicket({ status: "open", priority: "low", category: "network" });
    await makeTicket({ status: "closed", priority: "urgent", category: "network" });
    await makeTicket({ status: "open", priority: "urgent", category: "hardware" });

    expect(await listIds({ status: "open", priority: "urgent", category: "network" })).toEqual([
      match.id,
    ]);
  });

  it("does not return a rank-drifted row under the status it no longer has", async () => {
    // `statusRank` defaults to 0 and only `applyTicketRanks()` maintains it, so a
    // row written by raw SQL, a seed, or a service that forgot the helper can
    // hold `status='archived'` with `statusRank=0` — the rank meaning `open`.
    // Filtering on the rank alone would return it for `?status=open`, making the
    // drift a wrong result set and a wrong `meta.total`, not merely a wrong sort.
    const drifted = await makeTicket({ status: "open" });
    await prisma.$executeRawUnsafe(
      `UPDATE "Ticket" SET status = 'archived' WHERE id = ?`,
      drifted.id,
    );

    const page = await listTickets(query({ status: "open" }));

    expect(page.data.map((ticket) => ticket.id)).not.toContain(drifted.id);
    expect(page.meta.total).toBe(0);
  });

  it("matches requesterEmail case-insensitively by lowercasing the input to match storage", async () => {
    const ticket = await makeTicket({ requesterEmail: "dana.whitfield@example.com" });
    await makeTicket({ requesterEmail: "other@example.com" });

    expect(await listIds({ requesterEmail: "Dana.Whitfield@Example.COM" })).toEqual([ticket.id]);
  });

  it("matches assignee exactly and case-sensitively", async () => {
    const ticket = await makeTicket({ assignee: "Ada Chen" });
    await makeTicket({ assignee: "ada chen" });

    expect(await listIds({ assignee: "Ada Chen" })).toEqual([ticket.id]);
  });
});

/* ------------------------------------------------------------------ *
 * assigneeIsNull
 * ------------------------------------------------------------------ */

describe("assigneeIsNull", () => {
  it("returns only unassigned tickets when true", async () => {
    const unassigned = await makeTicket({ assignee: null });
    await makeTicket({ assignee: "Ada Chen" });

    expect(await listIds({ assigneeIsNull: "true" })).toEqual([unassigned.id]);
  });

  it("returns only assigned tickets when false", async () => {
    const assigned = await makeTicket({ assignee: "Ada Chen" });
    await makeTicket({ assignee: null });

    expect(await listIds({ assigneeIsNull: "false" })).toEqual([assigned.id]);
  });

  it("treats an assignee literally named None as a person, not a sentinel", async () => {
    // The test that would have caught the rejected `assignee=none` design.
    const none = await makeTicket({ assignee: "None" });
    const unassigned = await makeTicket({ assignee: null });

    expect(await listIds({ assignee: "None" })).toEqual([none.id]);
    expect(await listIds({ assigneeIsNull: "true" })).toEqual([unassigned.id]);
  });
});

/* ------------------------------------------------------------------ *
 * q
 * ------------------------------------------------------------------ */

describe("q", () => {
  it("matches the title", async () => {
    const ticket = await makeTicket({ title: "VPN drops every morning" });
    await makeTicket({ title: "Printer jam", description: "Tray two" });

    expect(await listIds({ q: "vpn" })).toEqual([ticket.id]);
  });

  it("matches the description", async () => {
    const ticket = await makeTicket({ title: "Laptop issue", description: "Fails with error 809" });
    await makeTicket({ title: "Printer jam", description: "Tray two" });

    expect(await listIds({ q: "error 809" })).toEqual([ticket.id]);
  });

  it("matches a ticket reference in every accepted spelling", async () => {
    // Ids start at 1 in every test (`sqlite_sequence` is reset), so creating 42
    // rows in order arranges HD-000042. Titles and descriptions carry no digits,
    // so a match can only have come from the id branch of the `OR`.
    await makeTickets(42, () => ({ title: "Printer jam", description: "Tray two sticks" }));

    for (const spelling of ["HD-000042", "hd-42", "#42", "42"]) {
      expect(await listIds({ q: spelling })).toEqual([42]);
    }
  });

  it("narrows within the active filters rather than widening past them", async () => {
    // The hoisted-`OR` regression test. If the `q` branches are lifted out of the
    // top-level `AND`, the resolved ticket comes back too and search silently
    // widens the result set past the status filter.
    const open = await makeTicket({ status: "open", title: "VPN drops every morning" });
    const resolved = await makeTicket({ status: "resolved", title: "VPN drops every evening" });

    const ids = await listIds({ q: "VPN", status: "open" });

    expect(ids).toEqual([open.id]);
    expect(ids).not.toContain(resolved.id);
  });

  it("nests its branches as one OR group inside the top-level AND", () => {
    const where = buildWhere(query({ q: "42", status: "open" }));

    // Structural proof of the same invariant: two entries in the `AND`, one of
    // which is the whole `OR` group — not three siblings.
    expect(where.AND).toHaveLength(2);
    expect(where.AND).toContainEqual({
      OR: [{ title: { contains: "42" } }, { description: { contains: "42" } }, { id: 42 }],
    });
  });

  it("keeps the OR group nested when the raw prefilter path is taken", () => {
    const where = buildWhere(query({ q: "42%", status: "open" }), [7, 9]);

    expect(where.AND).toHaveLength(2);
    expect(where.AND).toContainEqual({ OR: [{ id: { in: [7, 9] } }] });
  });

  it("refuses to build a where for a wildcard q it was given no match set for", () => {
    // Falling back to `contains` here would hand user input straight to `LIKE`
    // as pattern syntax — the bug the raw path exists to fix, wearing the
    // costume of a missing argument.
    expect(() => buildWhere(query({ q: "50%" }))).toThrow(/matchedIds/);
  });
});

/* ------------------------------------------------------------------ *
 * q — LIKE metacharacters
 *
 * Prisma's `contains` compiles to `LIKE ?` with **no `ESCAPE` clause**, so `%`
 * and `_` in user input are live wildcards. Escaping the string before handing
 * it to `contains` does not fix it either: with no escape clause SQLite has no
 * escape character, so `!%` is two literal characters that match nothing. The
 * service therefore resolves `q` with a raw `LIKE … ESCAPE '!'`.
 * ------------------------------------------------------------------ */

describe("q with LIKE metacharacters", () => {
  it("treats a lone % as a literal, returning nothing rather than everything", async () => {
    await makeTickets(3, () => ({ title: "Printer jam", description: "Tray two" }));

    expect(await listIds({ q: "%" })).toEqual([]);
  });

  it("treats % inside the term as a literal percent sign", async () => {
    const literal = await makeTicket({ title: "Upload 50% done", description: "Stalled there" });
    await makeTicket({ title: "500 errors on save", description: "Every request" });

    // As a wildcard, `50%` would match "500 errors" too.
    expect(await listIds({ q: "50%" })).toEqual([literal.id]);
  });

  it("treats _ as a literal underscore rather than a single-character wildcard", async () => {
    const literal = await makeTicket({ title: "Code error_809", description: "Since Tuesday" });
    await makeTicket({ title: "Code errorX809", description: "Unrelated" });

    expect(await listIds({ q: "error_809" })).toEqual([literal.id]);
  });

  it("matches the escape character itself literally", async () => {
    // `!` is the ESCAPE character, so a bare `!` in the pattern would be a
    // dangling escape — SQLite's behaviour there is not something to rely on.
    const bang = await makeTicket({ title: "It broke!", description: "Again" });
    await makeTicket({ title: "It broke", description: "Again" });

    expect(await listIds({ q: "broke!" })).toEqual([bang.id]);
  });

  it("still narrows within an active status filter when the term holds a wildcard", async () => {
    const open = await makeTicket({ status: "open", title: "Upload 50% done" });
    const resolved = await makeTicket({ status: "resolved", title: "Upload 50% done" });

    const ids = await listIds({ q: "50%", status: "open" });

    expect(ids).toEqual([open.id]);
    expect(ids).not.toContain(resolved.id);
  });

  it("takes the raw prefilter path only for a term carrying a LIKE metacharacter", () => {
    // The branch itself, asserted through the shape `buildWhere` produces: a
    // plain term keeps the `contains` spelling (and therefore the ordering
    // index and no id list); a wildcard term demands the resolved id set.
    expect(needsEscapedSearch("printer")).toBe(false);
    expect(needsEscapedSearch("50%")).toBe(true);
    expect(needsEscapedSearch("error_809")).toBe(true);
    // `!` is the escape character, so a term containing it is one whose escaped
    // form differs from itself — the no-op equivalence does not cover it.
    expect(needsEscapedSearch("broke!")).toBe(true);

    expect(buildWhere(query({ q: "printer" })).AND).toEqual([
      { OR: [{ title: { contains: "printer" } }, { description: { contains: "printer" } }] },
    ]);
    expect(buildWhere(query({ q: "50%" }), [4]).AND).toEqual([{ OR: [{ id: { in: [4] } }] }]);
  });

  it("returns the same rows on either path for a term escaping would not change", async () => {
    // The equivalence the fast path rests on, asserted rather than argued:
    // for a term with no `%`, `_`, or `!`, escaping is a no-op, so the raw
    // `LIKE … ESCAPE` and `contains` are the same query.
    const printer = await makeTicket({ title: "Printer jam", description: "Tray two" });
    await makeTicket({ title: "VPN drops", description: "Every morning" });
    await makeTicket({ title: "Laptop", description: "Printer driver missing" });

    const viaFastPath = await listIds({ q: "printer" });
    const viaRawPath = await resolveTextSearch(prisma, "printer");

    expect(viaFastPath).toContain(printer.id);
    expect([...viaFastPath].sort((a, b) => a - b)).toEqual([...viaRawPath].sort((a, b) => a - b));
  });

  it("escapes the escape character before the wildcards, not after", () => {
    // Order is the whole subtlety: escaping `%` first would then re-escape the
    // `!` it just introduced, and the pattern would match nothing.
    expect(escapeLikePattern("100%")).toBe("100!%");
    expect(escapeLikePattern("a_b")).toBe("a!_b");
    expect(escapeLikePattern("!")).toBe("!!");
    expect(escapeLikePattern("!%")).toBe("!!!%");
  });
});

/* ------------------------------------------------------------------ *
 * Date bounds
 * ------------------------------------------------------------------ */

describe("date bounds", () => {
  it("includes a ticket created on the createdTo day itself", async () => {
    // The off-by-one-day bound. A naive `lte: 2026-03-05T00:00:00Z` excludes
    // everything created that day, which reads as "the filter is off by one".
    const onTheDay = await makeTicket({ createdAt: new Date("2026-03-05T13:45:00.000Z") });
    await makeTicket({ createdAt: new Date("2026-03-06T00:00:00.000Z") });

    expect(await listIds({ createdTo: "2026-03-05" })).toEqual([onTheDay.id]);
  });

  it("includes a ticket created at the very start of the createdFrom day", async () => {
    const onTheDay = await makeTicket({ createdAt: new Date("2026-03-05T00:00:00.000Z") });
    await makeTicket({ createdAt: new Date("2026-03-04T23:59:59.999Z") });

    expect(await listIds({ createdFrom: "2026-03-05" })).toEqual([onTheDay.id]);
  });

  it("bounds both ends when a range is given", async () => {
    const inside = await makeTicket({ createdAt: new Date("2026-03-05T09:00:00.000Z") });
    await makeTicket({ createdAt: new Date("2026-03-03T09:00:00.000Z") });
    await makeTicket({ createdAt: new Date("2026-03-08T09:00:00.000Z") });

    expect(await listIds({ createdFrom: "2026-03-04", createdTo: "2026-03-06" })).toEqual([
      inside.id,
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Sorting
 * ------------------------------------------------------------------ */

describe("sorting", () => {
  it("puts urgent first when sorting by priority descending, not the alphabetical last", async () => {
    // Sorted as text, `urgent` would come first descending by accident — so the
    // ascending direction is asserted too, where text and severity disagree
    // (`low` … `urgent` alphabetically vs `low` first by severity is the same,
    // but `high` vs `medium` is not).
    const low = await makeTicket({ priority: "low" });
    const urgent = await makeTicket({ priority: "urgent" });
    const medium = await makeTicket({ priority: "medium" });
    const high = await makeTicket({ priority: "high" });

    expect(await listIds({ sort: "priority:desc" })).toEqual([
      urgent.id,
      high.id,
      medium.id,
      low.id,
    ]);
    expect(await listIds({ sort: "priority:asc" })).toEqual([
      low.id,
      medium.id,
      high.id,
      urgent.id,
    ]);
  });

  it("follows lifecycle order when sorting by status", async () => {
    const closed = await makeTicket({ status: "closed" });
    const open = await makeTicket({ status: "open" });
    const resolved = await makeTicket({ status: "resolved" });
    const inProgress = await makeTicket({ status: "in_progress" });

    expect(await listIds({ sort: "status:asc" })).toEqual([
      open.id,
      inProgress.id,
      resolved.id,
      closed.id,
    ]);
  });

  it("keeps pages disjoint when the sort key is not unique", async () => {
    // Six rows tied on `status`. Without the `{ id: "desc" }` tiebreaker SQLite
    // is free to return them in storage order, which is ascending id — so the
    // expected sequence, not just the disjointness, is what pins the clause.
    const tickets = await makeTickets(6, () => ({ status: "open" as const }));
    const ids = tickets.map((ticket) => ticket.id);

    const first = await listIds({ sort: "status:asc", page: "1", pageSize: "3" });
    const second = await listIds({ sort: "status:asc", page: "2", pageSize: "3" });

    expect(first).toEqual([...ids].reverse().slice(0, 3));
    expect(second).toEqual([...ids].reverse().slice(3));
    expect(first.filter((id) => second.includes(id))).toEqual([]);
    expect([...first, ...second].sort((a, b) => a - b)).toEqual(ids);
  });

  it("sorts by title alphabetically", async () => {
    const beta = await makeTicket({ title: "Beta" });
    const alpha = await makeTicket({ title: "Alpha" });

    expect(await listIds({ sort: "title:asc" })).toEqual([alpha.id, beta.id]);
  });

  it("appends an id tiebreaker to every sort except id itself", () => {
    // The deterministic half of the tiebreaker proof: SQLite happens to be
    // consistent between two offsets of the same query, so a behavioural test
    // alone cannot fail for the right reason on every schema.
    expect(buildOrderBy({ field: "status", direction: "asc" })).toEqual([
      { statusRank: "asc" },
      { id: "desc" },
    ]);
    expect(buildOrderBy({ field: "priority", direction: "desc" })).toEqual([
      { priorityRank: "desc" },
      { id: "desc" },
    ]);
    expect(buildOrderBy({ field: "createdAt", direction: "desc" })).toEqual([
      { createdAt: "desc" },
      { id: "desc" },
    ]);
    // A second clause on the same column can never break a tie there are none of.
    expect(buildOrderBy({ field: "id", direction: "asc" })).toEqual([{ id: "asc" }]);
  });
});
