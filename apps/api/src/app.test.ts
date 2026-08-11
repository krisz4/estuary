import { apiErrorResponseSchema } from "@helpdesk/contracts";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";

/**
 * Stage 4 gate: the middleware chain and the error envelope.
 *
 * These tests touch **no database** — `createApp()` mounts no router that does,
 * and `lib/prisma.ts` is never imported on this path. Stage 5 generalises the
 * harness for the service and route tests that will.
 */

const app = createApp();

/** Every failure response must satisfy the envelope contract, not just its code. */
const expectEnvelope = (body: unknown, code: string) => {
  const parsed = apiErrorResponseSchema.safeParse(body);
  expect(parsed.success, `not a valid error envelope: ${JSON.stringify(body)}`).toBe(true);
  expect(parsed.data?.error.code).toBe(code);
  expect(parsed.data?.error.message.length).toBeGreaterThan(0);
  expect(parsed.data?.error.requestId.length).toBeGreaterThan(0);
};

describe("GET /health", () => {
  it("returns 200 from the root, outside /api/v1, so Docker can healthcheck it", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("is not mounted under /api/v1", async () => {
    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(404);
  });
});

describe("requestId", () => {
  it("echoes a caller-supplied x-request-id into the header and the envelope", async () => {
    const res = await request(app).get("/nope").set("x-request-id", "trace-abc-123");

    expect(res.headers["x-request-id"]).toBe("trace-abc-123");
    expect(res.body.error.requestId).toBe("trace-abc-123");
  });

  it("generates one when the caller sends none", async () => {
    const res = await request(app).get("/nope");

    expect(res.body.error.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("unknown route", () => {
  it("returns 404 NOT_FOUND in the envelope", async () => {
    const res = await request(app).get("/definitely-not-a-route");

    expect(res.status).toBe(404);
    expectEnvelope(res.body, "NOT_FOUND");
  });

  it("returns 404 for an unmatched verb, since the contract has no METHOD_NOT_ALLOWED", async () => {
    const res = await request(app).post("/health");

    expect(res.status).toBe(404);
    expectEnvelope(res.body, "NOT_FOUND");
  });
});

describe("body parser failures", () => {
  it("turns malformed JSON into 400 MALFORMED_JSON, not 500", async () => {
    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Content-Type", "application/json")
      .send('{"title": "unterminated');

    expect(res.status).toBe(400);
    expectEnvelope(res.body, "MALFORMED_JSON");
  });

  it("turns a body over BODY_LIMIT into 413 PAYLOAD_TOO_LARGE, not 500", async () => {
    // Default BODY_LIMIT is 1mb; 2 MB of valid JSON is unambiguously over it.
    const oversized = JSON.stringify({ description: "x".repeat(2 * 1024 * 1024) });

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Content-Type", "application/json")
      .send(oversized);

    expect(res.status).toBe(413);
    expectEnvelope(res.body, "PAYLOAD_TOO_LARGE");
  });
});

describe("unhandled errors", () => {
  it("returns 500 INTERNAL_ERROR with no stack trace in the response", async () => {
    const res = await request(app).get("/__test__/boom");

    expect(res.status).toBe(500);
    expectEnvelope(res.body, "INTERNAL_ERROR");

    const raw = res.text;
    expect(raw).not.toContain("boom:");
    expect(raw).not.toMatch(/\bat\s+\S+\s+\(/); // "at fn (file:line)"
    expect(raw).not.toContain(".ts:");
    expect(raw).not.toContain("/src/");
    expect(res.body.error.details).toBeUndefined();
  });

  it("handles a rejected promise the same way — Express 5 forwards it unaided", async () => {
    const res = await request(app).get("/__test__/boom-async");

    expect(res.status).toBe(500);
    expectEnvelope(res.body, "INTERNAL_ERROR");
    expect(res.text).not.toContain("boom:");
  });
});

describe("cors", () => {
  it("allows an origin from ALLOWED_ORIGINS and exposes x-request-id to it", async () => {
    const res = await request(app).get("/health").set("Origin", "http://localhost:5173");

    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(res.headers["access-control-expose-headers"]).toContain("x-request-id");
  });

  it("does not echo an origin that is not on the list", async () => {
    const res = await request(app).get("/health").set("Origin", "http://evil.example");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  // The regression test for middleware ordering. `express.json()` calls
  // next(err) on a bad body, which skips every remaining non-error middleware —
  // so if cors is mounted after the parser, these two responses go out with no
  // CORS headers and the browser turns them into opaque network errors. The
  // user-visible symptom is a ticket description over BODY_LIMIT failing with
  // no message and no request id to quote back.
  it.each([
    ["malformed JSON", "{ not json", undefined],
    ["an oversized body", JSON.stringify({ description: "x".repeat(1_200_000) }), undefined],
  ])("still sends CORS headers when the body parser rejects %s", async (_label, body) => {
    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Origin", "http://localhost:5173")
      .set("Content-Type", "application/json")
      .send(body);

    expect([400, 413]).toContain(res.status);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(res.headers["access-control-expose-headers"]).toContain("x-request-id");
  });
});
