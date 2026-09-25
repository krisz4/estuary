import request from "supertest";
import { afterAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../app.js";
import { OPENAPI_TITLE, OPENAPI_VERSION } from "../lib/openapi.js";

/**
 * `/docs` — Swagger UI, and the flag that turns it off.
 *
 * The disabled case is the half worth writing. `DOCS_ENABLED` is read once, at
 * boot, by `lib/env.ts`, so the only honest way to test it is to re-import the
 * application with a different environment — asserting on `env.DOCS_ENABLED`
 * instead would test that a boolean is a boolean.
 */

const app = createApp();

describe("with DOCS_ENABLED (the default)", () => {
  it("serves Swagger UI at /docs", async () => {
    const res = await request(app).get("/docs/").redirects(1);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("swagger-ui");
  });

  it("redirects /docs to /docs/ rather than 404ing on the missing slash", async () => {
    const res = await request(app).get("/docs");

    expect([200, 301]).toContain(res.status);
  });

  it("serves the raw spec at /docs/openapi.json", async () => {
    const res = await request(app).get("/docs/openapi.json");

    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
    expect(res.body.info).toMatchObject({ title: OPENAPI_TITLE, version: OPENAPI_VERSION });
  });

  /**
   * `swaggerUi.serve` is a static-file middleware for the whole subtree, so a
   * JSON route declared *after* it never runs — the request would come back as
   * Swagger's own 404 page instead of the spec. Declaration order in
   * `docs.route.ts` is what prevents that, and this is what pins it.
   */
  it("does not let the UI's static handler swallow /docs/openapi.json", async () => {
    const res = await request(app).get("/docs/openapi.json");

    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  /**
   * `swaggerUi.setup()` is a handler, not a router: reached for any path it
   * renders the page. Unscoped, `/docs` therefore answered `200 text/html` to
   * everything beneath it — a client fetching a mistyped spec URL got HTML it
   * would try to parse as JSON, and `system.openapi.ts` documents the opposite.
   */
  it("falls through to NOT_FOUND for a mistyped spec URL rather than serving HTML", async () => {
    const res = await request(app).get("/docs/openapi.jso");

    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("falls through to NOT_FOUND for an unknown path under /docs", async () => {
    const res = await request(app).get("/docs/not-a-real-page");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("falls through to NOT_FOUND for a verb the docs router does not serve", async () => {
    const res = await request(app).post("/docs/whatever").send({});

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("still serves the UI's own assets", async () => {
    const css = await request(app).get("/docs/swagger-ui.css");
    const init = await request(app).get("/docs/swagger-ui-init.js");

    expect(css.status).toBe(200);
    expect(init.status).toBe(200);
  });

  it("documents every operation the spec knows about", async () => {
    const res = await request(app).get("/docs/openapi.json");
    const paths = Object.keys(res.body.paths as Record<string, unknown>);

    expect(paths).toContain("/health");
    expect(paths).toContain("/api/v1/tasks");
    expect(paths).toContain("/api/v1/tasks/{taskId}");
    expect(paths).toContain("/api/v1/tasks/facets");
    expect(paths).toContain("/api/v1/tasks/{taskId}/comments");
    expect(paths).toContain("/api/v1/tasks/{taskId}/comments/{commentId}");
    expect(paths).toContain("/api/v1/tasks/stats");
    expect(paths).toContain("/api/v1/tasks/next");
    expect(paths).toContain("/api/v1/tasks/{taskId}/transition");
    expect(paths).toContain("/api/v1/events");
  });

  it("titles the UI page with the API's name", async () => {
    const res = await request(app).get("/docs/");

    expect(res.text).toContain(`<title>${OPENAPI_TITLE}</title>`);
  });
});

describe("with DOCS_ENABLED=false", () => {
  let disconnect: (() => Promise<void>) | undefined;

  afterAll(async () => {
    // The re-imported module graph built its own PrismaClient against the same
    // worker database. Left open, it holds a file handle past teardown.
    await disconnect?.();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /**
   * Both assertions come from one boot because `vi.resetModules()` plus a fresh
   * `import` is the only honest way to test a value `lib/env.ts` reads once, and
   * doing it twice would build two more module graphs and two more Prisma
   * clients.
   *
   * The registry half is the one that matters. `app.ts` statically imports
   * `createDocsRouter`, which reaches `src/openapi.ts` — so before registration
   * was made a *call* rather than an import side effect, every boot built the
   * list query's parameters, which means calling `unwrapPreprocessedObject()`,
   * which reads zod internals and throws by design. A `zod ^4` patch bump would
   * have killed **process startup** on a deployment that had switched docs off.
   */
  it("serves no docs, and never even builds the spec", async () => {
    vi.stubEnv("DOCS_ENABLED", "false");
    vi.resetModules();

    const { createApp: createDisabledApp } = await import("../app.js");
    const { registry } = await import("../lib/openapi.js");
    const { prisma } = await import("../lib/prisma.js");
    disconnect = () => prisma.$disconnect();

    const disabled = createDisabledApp();

    // Nothing in the spec layer has run: no paths registered, so nothing called
    // the zod-internals unwrap that registration needs.
    expect(registry.definitions).toHaveLength(0);

    const ui = await request(disabled).get("/docs/");
    const spec = await request(disabled).get("/docs/openapi.json");

    expect(ui.status).toBe(404);
    expect(ui.body.error.code).toBe("NOT_FOUND");
    expect(spec.status).toBe(404);
    expect(spec.body.error.code).toBe("NOT_FOUND");
  });
});
