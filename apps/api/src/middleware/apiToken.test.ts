import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../app.js";
import { env } from "../lib/env.js";
import { ApiError } from "../lib/errors.js";
import { apiToken } from "./apiToken.js";

/**
 * The optional `API_TOKEN` gate (`middleware/apiToken.ts`,
 * `docs/features/Task_Workflow_API.md` § Request headers).
 *
 * `createApp()` decides whether to mount the gate from `env.API_TOKEN` at
 * construction time, so each app here is built *after* the value is set, and
 * the value is restored afterwards so no other test file inherits a gated app.
 */

const TOKEN = "s3cret-token-for-tests-0123456789";

describe("with API_TOKEN set", () => {
  const original = env.API_TOKEN;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    env.API_TOKEN = TOKEN;
    app = createApp();
  });

  afterEach(() => {
    env.API_TOKEN = original;
  });

  it("leaves /health open", async () => {
    expect((await request(app).get("/health")).status).toBe(200);
  });

  it("leaves /docs open", async () => {
    expect((await request(app).get("/docs/openapi.json")).status).toBe(200);
  });

  it("returns 401 UNAUTHORIZED in the envelope when the header is missing", async () => {
    const res = await request(app).get("/api/v1/tasks");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
    expect(res.body.error.requestId).toBeTruthy();
  });

  it.each([
    ["a wrong token of the same length", `Bearer ${"x".repeat(TOKEN.length)}`],
    ["a shorter token", "Bearer short"],
    ["a longer token", `Bearer ${TOKEN}-and-more`],
    ["the right token under another scheme", `Basic ${TOKEN}`],
    ["the bare token with no scheme", TOKEN],
    ["an empty bearer", "Bearer "],
  ])("returns 401, never a 500, for %s", async (_label, header) => {
    const res = await request(app).get("/api/v1/tasks").set("Authorization", header);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("serves the request with the right token, scheme case-insensitive", async () => {
    const res = await request(app).get("/api/v1/tasks").set("Authorization", `Bearer ${TOKEN}`);
    const lower = await request(app).get("/api/v1/tasks").set("Authorization", `bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    expect(lower.status).toBe(200);
  });

  it("gates writes, not just reads", async () => {
    const res = await request(app)
      .post("/api/v1/tasks")
      .send({ title: "Should not exist", description: "Rejected before any router ran." });

    expect(res.status).toBe(401);
  });

  it("answers the token check before the actor check", async () => {
    const res = await request(app).get("/api/v1/events").set("X-Actor", "malformed");

    expect(res.status).toBe(401);
  });

  it("lets a CORS preflight through without a token — browsers never send one on OPTIONS", async () => {
    const res = await request(app)
      .options("/api/v1/tasks")
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "authorization,x-actor,content-type");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-headers"]).toMatch(/authorization/i);
  });
});

describe("with API_TOKEN unset (the default)", () => {
  it("serves /api/v1 with no Authorization header at all", async () => {
    expect(env.API_TOKEN).toBeUndefined();

    expect((await request(createApp()).get("/api/v1/tasks")).status).toBe(200);
  });
});

describe("apiToken() comparison", () => {
  const run = (header: string | undefined) => {
    const next = vi.fn<(err?: unknown) => void>();
    const req = { headers: header === undefined ? {} : { authorization: header } } as Request;
    apiToken(TOKEN)(req, {} as Response, next as unknown as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
    return next.mock.calls[0]?.[0];
  };

  it("calls next() with nothing for the right token", () => {
    expect(run(`Bearer ${TOKEN}`)).toBeUndefined();
  });

  it("skips timingSafeEqual for a length mismatch instead of throwing", () => {
    // `timingSafeEqual` throws RangeError on buffers of different lengths; the
    // length check in front of it is what keeps that from becoming a 500.
    for (const header of ["Bearer a", `Bearer ${TOKEN}x`, "Bearer é".repeat(3)]) {
      const error = run(header);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("UNAUTHORIZED");
    }
  });

  it("compares bytes, not characters, so a multi-byte lookalike of equal length fails", () => {
    // Same character count as the token, different byte length.
    const lookalike = `é${TOKEN.slice(1)}`;
    expect(lookalike.length).toBe(TOKEN.length);

    expect((run(`Bearer ${lookalike}`) as ApiError).code).toBe("UNAUTHORIZED");
  });

  it("rejects a request with no Authorization header", () => {
    expect((run(undefined) as ApiError).code).toBe("UNAUTHORIZED");
  });
});
