import { API_ERROR_CODES, API_ERROR_STATUS, apiErrorResponseSchema } from "@helpdesk/contracts";
import type { Express } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { makeTicket } from "../test/factories.js";

/**
 * **The stage-8 gate, executable.**
 *
 * `docs/engineering/API_ERROR_CONTRACT.md` claims "every code above is
 * reachable, and there is a test that produces each one". This file is what
 * makes that claim checkable instead of aspirational: a table of code → a
 * request that produces it, plus an exhaustiveness assertion against
 * `API_ERROR_CODES`.
 *
 * The exhaustiveness check is the load-bearing half. Adding a code to the
 * contract without a way to produce it fails **here**, at the line that compares
 * the table's keys to the union — which is exactly the bar the contract doc says
 * kept `METHOD_NOT_ALLOWED` and `CONFLICT` out of the table.
 *
 * Individual behaviours are asserted in `tickets.route.test.ts` and
 * `comments.route.test.ts`; this file asserts *reachability and status*, one
 * request per code, and does not duplicate their coverage.
 */

const app = createApp();

/** How each code is provoked. `arrange` returns the id a request needs, if any. */
interface Producer {
  what: string;
  arrange?: () => Promise<number>;
  send: (app: Express, id: number) => request.Test;
}

const PRODUCERS: Record<(typeof API_ERROR_CODES)[number], Producer> = {
  VALIDATION_ERROR: {
    what: "POST /tickets with a two-character title",
    send: (app) => request(app).post("/api/v1/tickets").send({ title: "hi" }),
  },
  AT_LEAST_ONE_FIELD: {
    what: "PATCH /tickets/:id with an empty body",
    arrange: async () => (await makeTicket()).id,
    send: (app, id) => request(app).patch(`/api/v1/tickets/${id}`).send({}),
  },
  TICKET_NOT_FOUND: {
    what: "GET /tickets/999999",
    send: (app) => request(app).get("/api/v1/tickets/999999"),
  },
  COMMENT_NOT_FOUND: {
    what: "DELETE a comment id that is not on this ticket",
    arrange: async () => (await makeTicket()).id,
    send: (app, id) => request(app).delete(`/api/v1/tickets/${id}/comments/999999`),
  },
  INVALID_STATUS_TRANSITION: {
    what: "PATCH a closed ticket back to resolved",
    arrange: async () => (await makeTicket({ status: "closed" })).id,
    send: (app, id) => request(app).patch(`/api/v1/tickets/${id}`).send({ status: "resolved" }),
  },
  MALFORMED_JSON: {
    what: "POST /tickets with an unterminated JSON body",
    send: (app) =>
      request(app)
        .post("/api/v1/tickets")
        .set("Content-Type", "application/json")
        .send('{"title": "unterminated'),
  },
  PAYLOAD_TOO_LARGE: {
    what: "POST /tickets with a body over BODY_LIMIT (default 1mb)",
    send: (app) =>
      request(app)
        .post("/api/v1/tickets")
        .set("Content-Type", "application/json")
        .send(JSON.stringify({ description: "x".repeat(2 * 1024 * 1024) })),
  },
  NOT_FOUND: {
    what: "PUT /tickets/:id — a verb the router does not implement",
    arrange: async () => (await makeTicket()).id,
    send: (app, id) => request(app).put(`/api/v1/tickets/${id}`).send({ title: "whatever" }),
  },
  INTERNAL_ERROR: {
    // Through the diagnostic route on purpose: it is the only way to force an
    // unhandled throw without monkey-patching a real handler, and
    // `vitest.setup.ts`'s stderr filter is scoped to `/__test__/` paths, so a
    // genuine 500 from a real route would still print its stack.
    what: "GET /__test__/boom — a forced unhandled throw",
    send: (app) => request(app).get("/__test__/boom"),
  },
};

describe("every code in API_ERROR_CONTRACT.md has a request that produces it", () => {
  /**
   * The check that keeps unreachable codes out of the table. It fails in both
   * directions: a code added to contracts with no producer, and a producer left
   * behind for a code that was removed.
   */
  it("covers API_ERROR_CODES exactly — no gaps, no strays", () => {
    expect(Object.keys(PRODUCERS).sort()).toEqual([...API_ERROR_CODES].sort());
  });

  it.each(API_ERROR_CODES.map((code) => [code, PRODUCERS[code].what, PRODUCERS[code]] as const))(
    "%s ← %s",
    async (code, _what, producer) => {
      const id = producer.arrange === undefined ? 0 : await producer.arrange();

      const res = await producer.send(app, id);

      expect(res.status, `${producer.what} returned ${res.status}`).toBe(API_ERROR_STATUS[code]);

      const parsed = apiErrorResponseSchema.safeParse(res.body);
      expect(parsed.success, `not a valid envelope: ${JSON.stringify(res.body)}`).toBe(true);
      expect(parsed.data?.error.code).toBe(code);
      expect(parsed.data?.error.message.length).toBeGreaterThan(0);
      expect(parsed.data?.error.requestId.length).toBeGreaterThan(0);
    },
  );

  it("never leaks a stack trace, SQL, or a file path on a 500", async () => {
    const res = await request(app).get("/__test__/boom");

    expect(res.text).not.toContain("boom:");
    expect(res.text).not.toMatch(/\bat\s+\S+\s+\(/);
    expect(res.text).not.toContain(".ts:");
    expect(res.text).not.toContain("SELECT");
    expect(res.body.error.details).toBeUndefined();
  });

  it("echoes the request id onto both the header and the envelope for a real route failure", async () => {
    const res = await request(app)
      .get("/api/v1/tickets/999999")
      .set("x-request-id", "trace-stage-8");

    expect(res.headers["x-request-id"]).toBe("trace-stage-8");
    expect(res.body.error.requestId).toBe("trace-stage-8");
  });
});
