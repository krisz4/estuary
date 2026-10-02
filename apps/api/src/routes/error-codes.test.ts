import { API_ERROR_CODES, API_ERROR_STATUS, apiErrorResponseSchema } from "@estuary/contracts";
import type { Express } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { env } from "../lib/env.js";
import { claimedBy, makeDependency, makeTask } from "../test/factories.js";

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
 * Individual behaviours are asserted in `tasks.route.test.ts`,
 * `tasks.workflow.route.test.ts`, `comments.route.test.ts`, and the middleware
 * tests; this file asserts *reachability and status*, one request per code, and
 * does not duplicate their coverage.
 */

const app = createApp();

/**
 * `createApp()` mounts the token gate only when `API_TOKEN` is set at
 * construction time, so the UNAUTHORIZED producer builds its own app and puts
 * the setting back immediately — no other request in this file is gated.
 */
const gatedApp = (): Express => {
  const original = env.API_TOKEN;
  env.API_TOKEN = "error-codes-test-token-0123456789";
  try {
    return createApp();
  } finally {
    env.API_TOKEN = original;
  }
};

/**
 * Mutates `env.GITHUB_TOKEN` / `env.GITHUB_WEBHOOK_SECRET` for the duration of
 * `fn`, then restores them — unlike `gatedApp()`, the GitHub integration reads
 * `env` fresh on every request (`services/github.service.ts`), so the override
 * has to still be in place while the request runs, not just while `createApp()`
 * builds the middleware chain.
 */
const withGithubEnv = async <T>(
  overrides: { token?: string; secret?: string },
  fn: () => Promise<T>,
): Promise<T> => {
  const originalToken = env.GITHUB_TOKEN;
  const originalSecret = env.GITHUB_WEBHOOK_SECRET;
  if (overrides.token !== undefined) env.GITHUB_TOKEN = overrides.token;
  if (overrides.secret !== undefined) env.GITHUB_WEBHOOK_SECRET = overrides.secret;
  try {
    return await fn();
  } finally {
    env.GITHUB_TOKEN = originalToken;
    env.GITHUB_WEBHOOK_SECRET = originalSecret;
  }
};

/** Stubs the global `fetch` GitHub client calls go through, for the duration of `fn`. */
const withStubbedFetch = async <T>(stub: typeof fetch, fn: () => Promise<T>): Promise<T> => {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
};

/** How each code is provoked. `arrange` returns the id a request needs, if any. */
interface Producer {
  what: string;
  arrange?: () => Promise<number>;
  send: (app: Express, id: number) => request.Test | Promise<request.Response>;
}

const PRODUCERS: Record<(typeof API_ERROR_CODES)[number], Producer> = {
  VALIDATION_ERROR: {
    what: "POST /tasks with a two-character title",
    send: (app) => request(app).post("/api/v1/tasks").send({ title: "hi" }),
  },
  AT_LEAST_ONE_FIELD: {
    what: "PATCH /tasks/:id with an empty body",
    arrange: async () => (await makeTask()).id,
    send: (app, id) => request(app).patch(`/api/v1/tasks/${id}`).send({}),
  },
  UNAUTHORIZED: {
    what: "GET /tasks without a bearer token, on an app built with API_TOKEN set",
    send: () => request(gatedApp()).get("/api/v1/tasks"),
  },
  ACTOR_NOT_PERMITTED: {
    what: "an agent transitioning a task to done (AGENTS_MAY_COMPLETE off)",
    arrange: async () => (await makeTask({ status: "needs_qa" })).id,
    send: (app, id) =>
      request(app)
        .post(`/api/v1/tasks/${id}/transition`)
        .set("X-Actor", "agent:claude-code")
        .send({ to: "done" }),
  },
  VERSION_CONFLICT: {
    what: "PATCH /tasks/:id with a stale expectedVersion",
    arrange: async () => (await makeTask()).id,
    send: (app, id) =>
      request(app).patch(`/api/v1/tasks/${id}`).send({ priority: "high", expectedVersion: 99 }),
  },
  TASK_ALREADY_CLAIMED: {
    what: "an agent patching a task another agent holds a live claim on",
    arrange: async () => (await makeTask(claimedBy("agent:claude-code"))).id,
    send: (app, id) =>
      request(app)
        .patch(`/api/v1/tasks/${id}`)
        .set("X-Actor", "agent:codex")
        .send({ priority: "high" }),
  },
  NOT_CLAIM_HOLDER: {
    what: "a heartbeat on a task nobody has claimed",
    arrange: async () => (await makeTask({ status: "todo" })).id,
    send: (app, id) => request(app).post(`/api/v1/tasks/${id}/heartbeat`),
  },
  DEPENDENCY_CYCLE: {
    what: "B depends on A, then A is made to depend on B",
    arrange: async () => {
      const a = await makeTask();
      const b = await makeTask();
      await makeDependency(b.id, a.id);
      return a.id;
    },
    send: (app, id) =>
      request(app)
        .post(`/api/v1/tasks/${id}/dependencies`)
        .send({ dependsOnId: id + 1 }),
  },
  NO_OPEN_DECISION: {
    what: "answering a decision on a task that is not waiting on one",
    arrange: async () => (await makeTask({ status: "todo" })).id,
    send: (app, id) =>
      request(app).post(`/api/v1/tasks/${id}/decision/answer`).send({ note: "Yes" }),
  },
  INTEGRATION_NOT_CONFIGURED: {
    what: "GET /tasks/:id/github with neither GITHUB_TOKEN nor GITHUB_WEBHOOK_SECRET set",
    arrange: async () => (await makeTask()).id,
    send: (app, id) => request(app).get(`/api/v1/tasks/${id}/github`),
  },
  INVALID_WEBHOOK_SIGNATURE: {
    what: "POST the GitHub webhook with no X-Hub-Signature-256, on a server with the secret set",
    send: () =>
      withGithubEnv({ secret: "error-codes-webhook-secret-0123456789" }, () =>
        request(createApp())
          .post("/api/v1/integrations/github/webhook")
          .set("Content-Type", "application/json")
          .set("X-GitHub-Event", "ping")
          .set("X-GitHub-Delivery", "error-codes-delivery-1")
          .send(JSON.stringify({ zen: "Anything not underscored is mutable." })),
      ),
  },
  GITHUB_NOT_FOUND: {
    what: "POST /integrations/github/import for an issue GitHub answers 404 for",
    send: () =>
      withGithubEnv({ token: "error-codes-github-token" }, () =>
        withStubbedFetch((async () => new Response(null, { status: 404 })) as typeof fetch, () =>
          request(createApp())
            .post("/api/v1/integrations/github/import")
            .send({ issue: "https://github.com/acme/widgets/issues/999" }),
        ),
      ),
  },
  GITHUB_UNAVAILABLE: {
    what: "POST /integrations/github/import while GitHub answers with a server error",
    send: () =>
      withGithubEnv({ token: "error-codes-github-token" }, () =>
        withStubbedFetch((async () => new Response("boom", { status: 500 })) as typeof fetch, () =>
          request(createApp())
            .post("/api/v1/integrations/github/import")
            .send({ issue: "https://github.com/acme/widgets/issues/1" }),
        ),
      ),
  },
  TASK_NOT_FOUND: {
    what: "GET /tasks/999999",
    send: (app) => request(app).get("/api/v1/tasks/999999"),
  },
  COMMENT_NOT_FOUND: {
    what: "DELETE a comment id that is not on this task",
    arrange: async () => (await makeTask()).id,
    send: (app, id) => request(app).delete(`/api/v1/tasks/${id}/comments/999999`),
  },
  MALFORMED_JSON: {
    what: "POST /tasks with an unterminated JSON body",
    send: (app) =>
      request(app)
        .post("/api/v1/tasks")
        .set("Content-Type", "application/json")
        .send('{"title": "unterminated'),
  },
  PAYLOAD_TOO_LARGE: {
    what: "POST /tasks with a body over BODY_LIMIT (default 1mb)",
    send: (app) =>
      request(app)
        .post("/api/v1/tasks")
        .set("Content-Type", "application/json")
        .send(JSON.stringify({ description: "x".repeat(2 * 1024 * 1024) })),
  },
  NOT_FOUND: {
    what: "PUT /tasks/:id — a verb the router does not implement",
    arrange: async () => (await makeTask()).id,
    send: (app, id) => request(app).put(`/api/v1/tasks/${id}`).send({ title: "whatever" }),
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
    const res = await request(app).get("/api/v1/tasks/999999").set("x-request-id", "trace-stage-8");

    expect(res.headers["x-request-id"]).toBe("trace-stage-8");
    expect(res.body.error.requestId).toBe("trace-stage-8");
  });
});
