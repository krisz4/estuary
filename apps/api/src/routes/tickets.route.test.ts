import { apiErrorResponseSchema, ticketSchema } from "@helpdesk/contracts";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { makeComment, makeTicket, makeTickets } from "../test/factories.js";

/**
 * `/api/v1/tickets` route integration tests — the HTTP half of
 * `docs/engineering/TESTING.md` § Tickets, plus the route-level assertions
 * deferred from stage 6 as D11.
 *
 * These run against the real Express app and the worker's temp SQLite file. The
 * service-level behaviour (rank derivation, transition rules, the list query's
 * filters and sorts) is already covered in `services/*.test.ts` and is not
 * re-asserted here — what is asserted is what only the HTTP layer can get
 * wrong: status codes, headers, route ordering, and which parse failure becomes
 * which error code.
 */

const app = createApp();

const BASE = "/api/v1/tickets";

const validTicket = {
  title: "Laptop won't connect to the VPN",
  description: "Fails with error 809 since the Tuesday update. Rebooted and reinstalled already.",
  requesterName: "Dana Whitfield",
  requesterEmail: "Dana.Whitfield@Example.com",
};

/** Every failure must satisfy the envelope contract, not merely carry a code. */
const expectEnvelope = (body: unknown, code: string) => {
  const parsed = apiErrorResponseSchema.safeParse(body);
  expect(parsed.success, `not a valid error envelope: ${JSON.stringify(body)}`).toBe(true);
  expect(parsed.data?.error.code).toBe(code);
  expect(parsed.data?.error.message.length).toBeGreaterThan(0);
  expect(parsed.data?.error.requestId.length).toBeGreaterThan(0);
};

/* ------------------------------------------------------------------ *
 * POST /tickets
 * ------------------------------------------------------------------ */

describe("POST /api/v1/tickets", () => {
  it("returns 201 with a Location header pointing at the created ticket", async () => {
    const res = await request(app).post(BASE).send(validTicket);

    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`${BASE}/${res.body.id}`);
  });

  it("returns a body satisfying ticketSchema, with an integer id and its reference", async () => {
    const res = await request(app).post(BASE).send(validTicket);

    const parsed = ticketSchema.safeParse(res.body);
    expect(parsed.success, JSON.stringify(res.body)).toBe(true);
    expect(Number.isInteger(res.body.id)).toBe(true);
    expect(res.body.reference).toBe(`HD-${String(res.body.id).padStart(6, "0")}`);
    expect(res.body.comments).toEqual([]);
  });

  it("applies the documented defaults: open status and medium priority", async () => {
    const res = await request(app).post(BASE).send(validTicket);

    expect(res.body.status).toBe("open");
    expect(res.body.priority).toBe("medium");
    expect(res.body.resolvedAt).toBeNull();
    expect(res.body.closedAt).toBeNull();
  });

  it("lowercases requesterEmail on write, which is what exact-match filtering depends on", async () => {
    const res = await request(app).post(BASE).send(validTicket);
    expect(res.body.requesterEmail).toBe("dana.whitfield@example.com");
  });

  it("stores assignee: '' and category: '' as null rather than as empty strings", async () => {
    const res = await request(app)
      .post(BASE)
      .send({ ...validTicket, assignee: "", category: "" });

    expect(res.status).toBe(201);
    expect(res.body.assignee).toBeNull();
    expect(res.body.category).toBeNull();
  });

  it("returns 422 VALIDATION_ERROR naming each offending field in details", async () => {
    const res = await request(app)
      .post(BASE)
      .send({ title: "hi", description: "short", requesterName: "D", requesterEmail: "nope" });

    expect(res.status).toBe(422);
    expectEnvelope(res.body, "VALIDATION_ERROR");
    expect(Object.keys(res.body.error.details).sort()).toEqual([
      "description",
      "requesterEmail",
      "requesterName",
      "title",
    ]);
    expect(res.body.error.details.title[0]).toMatch(/at least 5/i);
  });

  it("returns 422 for a missing required field", async () => {
    const { title: _omitted, ...withoutTitle } = validTicket;

    const res = await request(app).post(BASE).send(withoutTitle);

    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.details)).toContain("title");
  });

  it("rejects a client-supplied id or createdAt instead of silently stripping it", async () => {
    const res = await request(app)
      .post(BASE)
      .send({ ...validTicket, id: 99, createdAt: "2020-01-01T00:00:00.000Z" });

    expect(res.status).toBe(422);
    expectEnvelope(res.body, "VALIDATION_ERROR");
    expect(await prisma.ticket.count()).toBe(0);
  });

  it("rejects a client-supplied status — a new ticket is always open", async () => {
    const res = await request(app)
      .post(BASE)
      .send({ ...validTicket, status: "closed" });

    expect(res.status).toBe(422);
  });
});

/* ------------------------------------------------------------------ *
 * GET /tickets/:ticketId
 * ------------------------------------------------------------------ */

describe("GET /api/v1/tickets/:ticketId", () => {
  it("returns 200 with the comment thread oldest-first", async () => {
    const ticket = await makeTicket();
    const sameMs = new Date("2026-08-11T09:00:00.000Z");
    await makeComment({ ticketId: ticket.id, body: "first", createdAt: sameMs });
    await makeComment({ ticketId: ticket.id, body: "second", createdAt: sameMs });

    const res = await request(app).get(`${BASE}/${ticket.id}`);

    expect(res.status).toBe(200);
    expect(res.body.comments.map((c: { body: string }) => c.body)).toEqual(["first", "second"]);
    expect(res.body.commentCount).toBe(2);
  });

  it("returns 404 TICKET_NOT_FOUND for an id that does not exist", async () => {
    const res = await request(app).get(`${BASE}/999999`);

    expect(res.status).toBe(404);
    expectEnvelope(res.body, "TICKET_NOT_FOUND");
  });

  /**
   * D11, and the rule the error contract states twice: a malformed id and a
   * missing ticket are indistinguishable to a caller. A 422 here would tell a
   * prober which ids are well-formed.
   */
  it.each(["abc", "1.5", "0x2a", "1e3", "-1", "0", "%20"])(
    "returns 404, not 422 and not 500, for the non-numeric id %j",
    async (segment) => {
      const res = await request(app).get(`${BASE}/${segment}`);

      expect(res.status).toBe(404);
      expectEnvelope(res.body, "TICKET_NOT_FOUND");
      expect(res.body.error.details).toBeUndefined();
    },
  );

  it("does not resolve ticket 42 under an alias spelling of its id", async () => {
    await makeTickets(42);

    expect((await request(app).get(`${BASE}/42`)).status).toBe(200);
    expect((await request(app).get(`${BASE}/0x2a`)).status).toBe(404);
    expect((await request(app).get(`${BASE}/1e3`)).status).toBe(404);
    // Over `TICKET_ID_MAX_DIGITS`. This returned **200** until the digit cap
    // landed, while `?q=0000000000000000042` matched nothing — the two parsers
    // for one concept disagreeing. See `docs/features/Ticket_Numbering.md`.
    expect((await request(app).get(`${BASE}/0000000000000000042`)).status).toBe(404);
  });

  /**
   * The other half of that agreement, asserted through HTTP rather than at the
   * schema: whatever the path accepts, `?q=` must resolve to the same ticket.
   * A leading-zero id is still an alias — that is fine and deliberate, because
   * **both** parsers accept it.
   */
  it("resolves a padded id identically through the path and through search", async () => {
    await makeTickets(42);

    expect((await request(app).get(`${BASE}/042`)).body.id).toBe(42);
    expect((await request(app).get(BASE).query({ q: "042" })).body.data[0].id).toBe(42);

    expect((await request(app).get(`${BASE}/0000000000000000042`)).status).toBe(404);
    expect((await request(app).get(BASE).query({ q: "0000000000000000042" })).body.meta.total).toBe(
      0,
    );
  });
});

/* ------------------------------------------------------------------ *
 * GET /tickets/facets — the route-ordering trap
 * ------------------------------------------------------------------ */

describe("GET /api/v1/tickets/facets", () => {
  /**
   * The regression test for the declaration order. With `/:ticketId` declared
   * first, `facets` is captured as an id, fails the digits-only parse, and comes
   * back 404 `TICKET_NOT_FOUND` — the assertion below fails on the status.
   */
  it("is matched as its own route, not captured as :ticketId", async () => {
    const res = await request(app).get(`${BASE}/facets`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ assignees: [], categories: [] });
  });

  it("returns only the distinct non-null values actually present, sorted", async () => {
    await makeTicket({ assignee: "Priya Raman", category: "network" });
    await makeTicket({ assignee: "Marcus Feld", category: "network" });
    await makeTicket({ assignee: null, category: null });

    const res = await request(app).get(`${BASE}/facets`);

    expect(res.body).toEqual({
      assignees: ["Marcus Feld", "Priya Raman"],
      categories: ["network"],
    });
  });
});

/* ------------------------------------------------------------------ *
 * PATCH /tickets/:ticketId
 * ------------------------------------------------------------------ */

describe("PATCH /api/v1/tickets/:ticketId", () => {
  it("applies a partial update and leaves untouched fields alone", async () => {
    const ticket = await makeTicket({ title: "Original title here", priority: "low" });

    const res = await request(app).patch(`${BASE}/${ticket.id}`).send({ priority: "urgent" });

    expect(res.status).toBe(200);
    expect(res.body.priority).toBe("urgent");
    expect(res.body.title).toBe("Original title here");
  });

  /** D11: `{}` is valid to zod on purpose, and must not become VALIDATION_ERROR. */
  it("returns 422 AT_LEAST_ONE_FIELD with no details for an empty body", async () => {
    const ticket = await makeTicket();

    const res = await request(app).patch(`${BASE}/${ticket.id}`).send({});

    expect(res.status).toBe(422);
    expectEnvelope(res.body, "AT_LEAST_ONE_FIELD");
    expect(res.body.error.details).toBeUndefined();
  });

  it("prefers VALIDATION_ERROR over AT_LEAST_ONE_FIELD when a supplied field is invalid", async () => {
    const ticket = await makeTicket();

    const res = await request(app).patch(`${BASE}/${ticket.id}`).send({ title: "x" });

    expect(res.status).toBe(422);
    expectEnvelope(res.body, "VALIDATION_ERROR");
    expect(Object.keys(res.body.error.details)).toEqual(["title"]);
  });

  it("returns 404 for an unknown id and for a non-numeric one", async () => {
    expect((await request(app).patch(`${BASE}/999999`).send({ priority: "low" })).status).toBe(404);

    const res = await request(app).patch(`${BASE}/abc`).send({ priority: "low" });
    expect(res.status).toBe(404);
    expectEnvelope(res.body, "TICKET_NOT_FOUND");
  });

  it("returns 409 INVALID_STATUS_TRANSITION with from, to, and allowed in details", async () => {
    const ticket = await makeTicket({ status: "closed" });

    const res = await request(app).patch(`${BASE}/${ticket.id}`).send({ status: "resolved" });

    expect(res.status).toBe(409);
    expectEnvelope(res.body, "INVALID_STATUS_TRANSITION");
    expect(res.body.error.details).toEqual({
      from: "closed",
      to: "resolved",
      allowed: ["open", "in_progress"],
    });
  });

  /** The empty-string-vs-null regression, asserted end to end through HTTP. */
  it("clearing assignee to '' makes the ticket appear under assigneeIsNull=true", async () => {
    const ticket = await makeTicket({ assignee: "Marcus Feld" });

    const patched = await request(app).patch(`${BASE}/${ticket.id}`).send({ assignee: "" });
    expect(patched.body.assignee).toBeNull();

    const list = await request(app).get(BASE).query({ assigneeIsNull: "true" });
    expect(list.body.data.map((t: { id: number }) => t.id)).toEqual([ticket.id]);
  });

  it("rejects a client-supplied resolvedAt — the timestamps are derived", async () => {
    const ticket = await makeTicket();

    const res = await request(app)
      .patch(`${BASE}/${ticket.id}`)
      .send({ resolvedAt: "2026-08-11T00:00:00.000Z" });

    expect(res.status).toBe(422);
    expectEnvelope(res.body, "VALIDATION_ERROR");
  });
});

/* ------------------------------------------------------------------ *
 * DELETE /tickets/:ticketId
 * ------------------------------------------------------------------ */

describe("DELETE /api/v1/tickets/:ticketId", () => {
  it("returns 204 with no body, then the ticket is gone", async () => {
    const ticket = await makeTicket();

    const res = await request(app).delete(`${BASE}/${ticket.id}`);

    expect(res.status).toBe(204);
    expect(res.text).toBe("");
    expect(res.body).toEqual({});
    expect((await request(app).get(`${BASE}/${ticket.id}`)).status).toBe(404);
  });

  it("cascades to the ticket's comments", async () => {
    const ticket = await makeTicket();
    await makeComment({ ticketId: ticket.id });
    await makeComment({ ticketId: ticket.id });

    await request(app).delete(`${BASE}/${ticket.id}`);

    expect(await prisma.comment.count({ where: { ticketId: ticket.id } })).toBe(0);
  });

  it("returns 404, not 500, when the same ticket is deleted twice", async () => {
    const ticket = await makeTicket();

    expect((await request(app).delete(`${BASE}/${ticket.id}`)).status).toBe(204);

    const second = await request(app).delete(`${BASE}/${ticket.id}`);
    expect(second.status).toBe(404);
    expectEnvelope(second.body, "TICKET_NOT_FOUND");
  });

  it("returns 404 for a non-numeric id", async () => {
    const res = await request(app).delete(`${BASE}/abc`);

    expect(res.status).toBe(404);
    expectEnvelope(res.body, "TICKET_NOT_FOUND");
  });
});

/* ------------------------------------------------------------------ *
 * GET /tickets — the envelope and the query-level 422s (D11)
 * ------------------------------------------------------------------ */

describe("GET /api/v1/tickets", () => {
  it("returns the { data, meta } envelope with the documented defaults", async () => {
    await makeTickets(3);

    const res = await request(app).get(BASE);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.meta).toEqual({
      page: 1,
      pageSize: 20,
      total: 3,
      totalPages: 1,
      hasNextPage: false,
      hasPrevPage: false,
    });
  });

  it("omits comments from list rows and reports commentCount instead", async () => {
    const ticket = await makeTicket();
    await makeComment({ ticketId: ticket.id });

    const res = await request(app).get(BASE);

    expect(res.body.data[0].commentCount).toBe(1);
    expect(res.body.data[0].comments).toBeUndefined();
  });

  it("passes repeated params through as an OR within that filter", async () => {
    await makeTicket({ status: "open" });
    await makeTicket({ status: "resolved" });
    await makeTicket({ status: "closed" });

    const res = await request(app).get(`${BASE}?status=open&status=resolved`);

    expect(res.body.meta.total).toBe(2);
  });

  it("returns an empty page rather than a 404 beyond the end of the results", async () => {
    await makeTickets(3);

    const res = await request(app).get(BASE).query({ page: "5" });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.hasNextPage).toBe(false);
  });

  /** D11: rejected, not clamped. A client asking for 500 rows has a bug. */
  it.each([
    ["pageSize=101", { pageSize: "101" }, "pageSize"],
    ["pageSize=0", { pageSize: "0" }, "pageSize"],
    ["page=0", { page: "0" }, "page"],
    ["an unknown sort field", { sort: "nope:asc" }, "sort"],
  ])("returns 422 for %s, naming it in details", async (_label, query, field) => {
    const res = await request(app).get(BASE).query(query);

    expect(res.status).toBe(422);
    expectEnvelope(res.body, "VALIDATION_ERROR");
    expect(Object.keys(res.body.error.details)).toContain(field);
  });

  /**
   * `.strict()` rejects an unknown param rather than ignoring it — a typo'd
   * filter silently returning everything is worse than an error.
   *
   * Its `details` key is `_`, not `utm_source`: zod reports an unrecognised key
   * with an **empty path** (the offending key is named in the message instead),
   * and `errorHandler` files a pathless issue under `_`. That is the honest
   * shape — there is no field on the schema to attach it to — so the assertion
   * pins the message, which is where the param name actually is.
   */
  it("returns 422 for an unknown query param, naming it in the message", async () => {
    const res = await request(app).get(BASE).query({ utm_source: "slack" });

    expect(res.status).toBe(422);
    expectEnvelope(res.body, "VALIDATION_ERROR");
    expect(JSON.stringify(res.body.error.details)).toContain("utm_source");
  });

  it("returns 422 naming both params when assignee and assigneeIsNull are sent together", async () => {
    const res = await request(app)
      .get(BASE)
      .query({ assignee: "Marcus Feld", assigneeIsNull: "true" });

    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.details).sort()).toEqual(["assignee", "assigneeIsNull"]);
  });

  it("treats empty query values as absent rather than malformed", async () => {
    await makeTickets(2);

    const res = await request(app).get(`${BASE}?page=&pageSize=&status=&q=`);

    expect(res.status).toBe(200);
    expect(res.body.meta.page).toBe(1);
    expect(res.body.meta.pageSize).toBe(20);
    expect(res.body.meta.total).toBe(2);
  });

  it("does not clamp pageSize=101 to 100 — the request fails and no page is served", async () => {
    await makeTickets(2);

    const res = await request(app).get(BASE).query({ pageSize: "101" });

    expect(res.status).toBe(422);
    expect(res.body.data).toBeUndefined();
  });
});
