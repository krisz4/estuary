import { createHmac } from "node:crypto";

import { apiErrorResponseSchema, taskSchema } from "@helpdesk/contracts";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { env } from "../lib/env.js";
import { eventsFor, makeTask } from "../test/factories.js";

/**
 * `/api/v1/integrations/github` and `/api/v1/tasks/:taskId/github` —
 * integration tests over a real Express app + temp SQLite, with `fetch`
 * stubbed so nothing reaches the real GitHub API
 * (`docs/features/GitHub_Integration.md`).
 */

const WEBHOOK_SECRET = "webhook-secret-0123456789abcdef";
const TOKEN = "gh-token-0123456789";

const originalToken = env.GITHUB_TOKEN;
const originalSecret = env.GITHUB_WEBHOOK_SECRET;
const originalApiToken = env.API_TOKEN;
const originalFetch = globalThis.fetch;

afterEach(() => {
  env.GITHUB_TOKEN = originalToken;
  env.GITHUB_WEBHOOK_SECRET = originalSecret;
  env.API_TOKEN = originalApiToken;
  globalThis.fetch = originalFetch;
});

const sign = (body: string, secret = WEBHOOK_SECRET): string =>
  `sha256=${createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex")}`;

const stubFetch = (impl: (url: string) => Response) => {
  globalThis.fetch = (async (input: string | URL | Request) => impl(String(input))) as typeof fetch;
};

const expectEnvelope = (body: unknown, code: string) => {
  const parsed = apiErrorResponseSchema.safeParse(body);
  expect(parsed.success, `not a valid error envelope: ${JSON.stringify(body)}`).toBe(true);
  expect(parsed.data?.error.code).toBe(code);
};

/* ------------------------------------------------------------------ *
 * Disabled integration
 * ------------------------------------------------------------------ */

describe("the integration off (no GITHUB_TOKEN, no GITHUB_WEBHOOK_SECRET)", () => {
  const app = createApp();

  it("GET /integrations/github answers enabled: false rather than 404", async () => {
    const res = await request(app).get("/api/v1/integrations/github");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: false,
      tokenConfigured: false,
      webhookConfigured: false,
      webhookPath: "/api/v1/integrations/github/webhook",
    });
  });

  it("GET /tasks/:id/github is INTEGRATION_NOT_CONFIGURED", async () => {
    const task = await makeTask();
    const res = await request(app).get(`/api/v1/tasks/${task.id}/github`);

    expect(res.status).toBe(404);
    expectEnvelope(res.body, "INTEGRATION_NOT_CONFIGURED");
  });

  it("POST /integrations/github/import is INTEGRATION_NOT_CONFIGURED", async () => {
    const res = await request(app)
      .post("/api/v1/integrations/github/import")
      .send({ issue: "https://github.com/acme/widgets/issues/1" });

    expect(res.status).toBe(404);
    expectEnvelope(res.body, "INTEGRATION_NOT_CONFIGURED");
  });

  it("POST /integrations/github/webhook is INTEGRATION_NOT_CONFIGURED", async () => {
    const body = JSON.stringify({ zen: "hi" });
    const res = await request(app)
      .post("/api/v1/integrations/github/webhook")
      .set("Content-Type", "application/json")
      .set("X-GitHub-Event", "ping")
      .set("X-GitHub-Delivery", "d-1")
      .send(body);

    expect(res.status).toBe(404);
    expectEnvelope(res.body, "INTEGRATION_NOT_CONFIGURED");
  });
});

/* ------------------------------------------------------------------ *
 * API_TOKEN interaction
 * ------------------------------------------------------------------ */

describe("with API_TOKEN set", () => {
  it("the webhook is reachable with no bearer while every other /api/v1 route still 401s", async () => {
    env.API_TOKEN = "api-token-0123456789abcdef";
    env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const app = createApp();

    const unauthorized = await request(app).get("/api/v1/tasks");
    expect(unauthorized.status).toBe(401);

    const body = JSON.stringify({ zen: "hi" });
    const webhook = await request(app)
      .post("/api/v1/integrations/github/webhook")
      .set("Content-Type", "application/json")
      .set("X-GitHub-Event", "ping")
      .set("X-GitHub-Delivery", "d-2")
      .set("X-Hub-Signature-256", sign(body))
      .send(body);

    expect(webhook.status).toBe(200);
    expect(webhook.body).toEqual({ ok: true });
  });
});

/* ------------------------------------------------------------------ *
 * Webhook
 * ------------------------------------------------------------------ */

describe("POST /api/v1/integrations/github/webhook", () => {
  const buildApp = () => {
    env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
    return createApp();
  };

  it("200s ping", async () => {
    const app = buildApp();
    const body = JSON.stringify({ zen: "Responsive is better than fast." });

    const res = await request(app)
      .post("/api/v1/integrations/github/webhook")
      .set("Content-Type", "application/json")
      .set("X-GitHub-Event", "ping")
      .set("X-GitHub-Delivery", "d-ping")
      .set("X-Hub-Signature-256", sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("401s with no X-Hub-Signature-256", async () => {
    const app = buildApp();
    const body = JSON.stringify({ zen: "hi" });

    const res = await request(app)
      .post("/api/v1/integrations/github/webhook")
      .set("Content-Type", "application/json")
      .send(body);

    expect(res.status).toBe(401);
    expectEnvelope(res.body, "INVALID_WEBHOOK_SIGNATURE");
  });

  it("401s with a wrong signature", async () => {
    const app = buildApp();
    const body = JSON.stringify({ zen: "hi" });

    const res = await request(app)
      .post("/api/v1/integrations/github/webhook")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", sign(body, "the-wrong-secret"))
      .send(body);

    expect(res.status).toBe(401);
    expectEnvelope(res.body, "INVALID_WEBHOOK_SIGNATURE");
  });

  it("202s an event type this integration does not act on", async () => {
    const app = buildApp();
    const body = JSON.stringify({ action: "labeled" });

    const res = await request(app)
      .post("/api/v1/integrations/github/webhook")
      .set("Content-Type", "application/json")
      .set("X-GitHub-Event", "issues")
      .set("X-Hub-Signature-256", sign(body))
      .send(body);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ignored: true });
  });

  it("links a task referenced in the PR title and appends a comment, for a real request", async () => {
    const app = buildApp();
    const task = await makeTask();
    const payload = {
      action: "opened",
      number: 55,
      pull_request: {
        title: `Fix login (task-${task.id})`,
        body: "",
        html_url: "https://github.com/krisz4/helpdesk/pull/55",
        merged: false,
        head: { ref: "main", sha: "deadbeef" },
      },
      repository: { full_name: "krisz4/helpdesk" },
    };
    const body = JSON.stringify(payload);

    const res = await request(app)
      .post("/api/v1/integrations/github/webhook")
      .set("Content-Type", "application/json")
      .set("X-GitHub-Event", "pull_request")
      .set("X-GitHub-Delivery", "d-real")
      .set("X-Hub-Signature-256", sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ linkedTasks: [task.id] });

    const events = await eventsFor(task.id);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "github.pull_request", actor: "system:github" }),
    );
  });
});

/* ------------------------------------------------------------------ *
 * Link status
 * ------------------------------------------------------------------ */

describe("GET /api/v1/tasks/:taskId/github", () => {
  const buildApp = () => {
    env.GITHUB_TOKEN = TOKEN;
    return createApp();
  };

  it("returns 404 TASK_NOT_FOUND for an unknown task", async () => {
    const res = await request(buildApp()).get("/api/v1/tasks/999999/github");

    expect(res.status).toBe(404);
    expectEnvelope(res.body, "TASK_NOT_FOUND");
  });

  it("resolves a linked PR against a stubbed GitHub", async () => {
    const app = buildApp();
    const task = await makeTask({
      links: [{ label: "PR", url: "https://github.com/acme/widgets/pull/12" }],
    });

    stubFetch((url) => {
      if (url.endsWith("/pulls/12")) {
        return new Response(
          JSON.stringify({
            title: "Fix login",
            state: "open",
            draft: false,
            merged: false,
            html_url: "https://github.com/acme/widgets/pull/12",
            head: { sha: "abc123", ref: "task-1" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/commits/abc123/status")) {
        return new Response(JSON.stringify({ state: "success" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    const res = await request(app).get(`/api/v1/tasks/${task.id}/github`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({ kind: "pull", state: "open", checks: "success", error: null }),
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Issue import
 * ------------------------------------------------------------------ */

describe("POST /api/v1/integrations/github/import", () => {
  const buildApp = () => {
    env.GITHUB_TOKEN = TOKEN;
    return createApp();
  };

  it("imports an issue: 201, Location, and a task matching taskSchema", async () => {
    const app = buildApp();
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            title: "Printer jams on floor 3",
            body: "Jams on every duplex job.",
            state: "open",
            html_url: "https://github.com/acme/widgets/issues/5",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const res = await request(app)
      .post("/api/v1/integrations/github/import")
      .send({ issue: "https://github.com/acme/widgets/issues/5" });

    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/v1/tasks/${res.body.id}`);
    expect(taskSchema.safeParse(res.body).success, JSON.stringify(res.body)).toBe(true);
    expect(res.body.project).toBe("widgets");
  });

  it("replays the same issue as 200", async () => {
    const app = buildApp();
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            title: "Printer jams on floor 3",
            body: "Jams on every duplex job.",
            state: "open",
            html_url: "https://github.com/acme/widgets/issues/5",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const first = await request(app)
      .post("/api/v1/integrations/github/import")
      .send({ issue: "https://github.com/acme/widgets/issues/5" });
    const second = await request(app)
      .post("/api/v1/integrations/github/import")
      .send({ issue: "https://github.com/acme/widgets/issues/5" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
  });

  it("refuses a pull request with VALIDATION_ERROR on issue", async () => {
    const app = buildApp();
    stubFetch(
      () =>
        new Response(JSON.stringify({ title: "PR", body: "", state: "open", pull_request: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const res = await request(app)
      .post("/api/v1/integrations/github/import")
      .send({ issue: "https://github.com/acme/widgets/issues/9" });

    expect(res.status).toBe(422);
    expectEnvelope(res.body, "VALIDATION_ERROR");
    expect(res.body.error.details).toHaveProperty("issue");
  });

  it("404s GITHUB_NOT_FOUND", async () => {
    const app = buildApp();
    stubFetch(() => new Response(null, { status: 404 }));

    const res = await request(app)
      .post("/api/v1/integrations/github/import")
      .send({ issue: "https://github.com/acme/widgets/issues/404" });

    expect(res.status).toBe(404);
    expectEnvelope(res.body, "GITHUB_NOT_FOUND");
  });

  it("502s GITHUB_UNAVAILABLE when GitHub rate-limits the request", async () => {
    const app = buildApp();
    stubFetch(() => new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0" } }));

    const res = await request(app)
      .post("/api/v1/integrations/github/import")
      .send({ issue: "https://github.com/acme/widgets/issues/1" });

    expect(res.status).toBe(502);
    expectEnvelope(res.body, "GITHUB_UNAVAILABLE");
  });
});
