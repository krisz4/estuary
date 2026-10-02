import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { env } from "../lib/env.js";
import { ApiError } from "../lib/errors.js";
import { GithubApiError, type GithubClient } from "../lib/github-client.js";
import { eventsFor, makeTask } from "../test/factories.js";
import {
  clearLinkStatusCache,
  getIntegrationStatus,
  getTaskGithubStatus,
  importGithubIssue,
  isIntegrationEnabled,
  processGithubWebhook,
  verifyWebhookSignature,
} from "./github.service.js";
import { getTask } from "./task.service.js";

/**
 * `services/github.service.ts` — the optional GitHub integration
 * (`docs/features/GitHub_Integration.md`), against a real (temp) SQLite file.
 * Every GitHub call goes through an injected fake `GithubClient`; nothing here
 * touches the network.
 */

const SECRET = "webhook-secret-0123456789abcdef";

const sign = (body: string, secret = SECRET): string =>
  `sha256=${createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex")}`;

const originalToken = env.GITHUB_TOKEN;
const originalSecret = env.GITHUB_WEBHOOK_SECRET;

afterEach(() => {
  env.GITHUB_TOKEN = originalToken;
  env.GITHUB_WEBHOOK_SECRET = originalSecret;
  clearLinkStatusCache();
});

/* ------------------------------------------------------------------ *
 * Enablement
 * ------------------------------------------------------------------ */

describe("isIntegrationEnabled / getIntegrationStatus", () => {
  it("is off with neither variable set", () => {
    env.GITHUB_TOKEN = undefined;
    env.GITHUB_WEBHOOK_SECRET = undefined;

    expect(isIntegrationEnabled()).toBe(false);
    expect(getIntegrationStatus()).toEqual({
      enabled: false,
      tokenConfigured: false,
      webhookConfigured: false,
      webhookPath: "/api/v1/integrations/github/webhook",
    });
  });

  it("is on with only the token set, and reports which half is configured", () => {
    env.GITHUB_TOKEN = "gh-token";
    env.GITHUB_WEBHOOK_SECRET = undefined;

    expect(isIntegrationEnabled()).toBe(true);
    expect(getIntegrationStatus()).toMatchObject({
      enabled: true,
      tokenConfigured: true,
      webhookConfigured: false,
    });
  });

  it("is on with only the webhook secret set", () => {
    env.GITHUB_TOKEN = undefined;
    env.GITHUB_WEBHOOK_SECRET = SECRET;

    expect(isIntegrationEnabled()).toBe(true);
    expect(getIntegrationStatus()).toMatchObject({ enabled: true, webhookConfigured: true });
  });
});

/* ------------------------------------------------------------------ *
 * Webhook signature
 * ------------------------------------------------------------------ */

describe("verifyWebhookSignature", () => {
  const body = JSON.stringify({ zen: "Keep it logically awesome." });

  it("accepts a correctly signed body", () => {
    expect(verifyWebhookSignature(Buffer.from(body), sign(body), SECRET)).toBe(true);
  });

  it("rejects a wrong signature", () => {
    expect(
      verifyWebhookSignature(Buffer.from(body), sign(body, "a-different-secret"), SECRET),
    ).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(verifyWebhookSignature(Buffer.from(body), undefined, SECRET)).toBe(false);
  });

  it("rejects a malformed header", () => {
    expect(verifyWebhookSignature(Buffer.from(body), "not-a-signature", SECRET)).toBe(false);
  });

  it("checks the exact raw bytes — a re-serialized body with the same JSON value fails", () => {
    const reserialized = JSON.stringify(JSON.parse(body), null, 2); // different whitespace
    expect(verifyWebhookSignature(Buffer.from(reserialized), sign(body), SECRET)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Webhook processing
 * ------------------------------------------------------------------ */

describe("processGithubWebhook", () => {
  const pullRequestPayload = (overrides: {
    action: string;
    number?: number;
    title: string;
    body?: string;
    ref?: string;
    merged?: boolean;
    deliveryId?: string;
  }) => ({
    action: overrides.action,
    number: overrides.number ?? 12,
    pull_request: {
      title: overrides.title,
      body: overrides.body ?? "",
      html_url: `https://github.com/krisz4/estuary/pull/${overrides.number ?? 12}`,
      merged: overrides.merged ?? false,
      head: { ref: overrides.ref ?? "main", sha: "abc123" },
    },
    repository: { full_name: "krisz4/estuary" },
  });

  it("answers ping without touching the database", async () => {
    const result = await processGithubWebhook({
      name: "ping",
      deliveryId: "d-ping",
      payload: { zen: "hi" },
    });

    expect(result).toEqual({ status: 200, body: { ok: true } });
  });

  it("ignores an event type it does not act on", async () => {
    const result = await processGithubWebhook({
      name: "issues",
      deliveryId: "d-issues",
      payload: {},
    });

    expect(result).toEqual({ status: 202, body: { ignored: true } });
  });

  it("links, comments, and records an event for an opened PR referencing a task", async () => {
    const task = await makeTask();

    const result = await processGithubWebhook({
      name: "pull_request",
      deliveryId: "d-1",
      payload: pullRequestPayload({
        action: "opened",
        title: `Fix login (task-${task.id})`,
        ref: `task-${task.id}-fix-login`,
      }),
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ linkedTasks: [task.id] });

    const after = await getTask(task.id);
    expect(after.links).toEqual([
      { label: "PR krisz4/estuary#12", url: "https://github.com/krisz4/estuary/pull/12" },
    ]);
    expect(after.comments.at(-1)).toMatchObject({
      author: "system:github",
      body: expect.stringContaining("opened") as unknown,
    });

    const events = await eventsFor(task.id);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "github.pull_request",
        actor: "system:github",
        payload: expect.objectContaining({ action: "opened", deliveryId: "d-1" }) as unknown,
      }),
    );
  });

  it("never changes task status", async () => {
    const task = await makeTask({ status: "todo" });

    await processGithubWebhook({
      name: "pull_request",
      deliveryId: "d-2",
      payload: pullRequestPayload({ action: "opened", title: `task-${task.id}` }),
    });

    expect((await getTask(task.id)).status).toBe("todo");
  });

  it("does not link a URL that is already on the task", async () => {
    const task = await makeTask({
      links: [{ label: "existing", url: "https://github.com/krisz4/estuary/pull/12" }],
    });

    await processGithubWebhook({
      name: "pull_request",
      deliveryId: "d-3",
      payload: pullRequestPayload({ action: "opened", title: `task-${task.id}` }),
    });

    expect((await getTask(task.id)).links).toHaveLength(1);
  });

  it("comments 'merged' when a PR closes merged, and 'closed without merging' otherwise", async () => {
    const merged = await makeTask();
    await processGithubWebhook({
      name: "pull_request",
      deliveryId: "d-merged",
      payload: pullRequestPayload({ action: "closed", title: `task-${merged.id}`, merged: true }),
    });
    expect((await getTask(merged.id)).comments.at(-1)?.body).toContain("merged:");

    const closed = await makeTask();
    await processGithubWebhook({
      name: "pull_request",
      deliveryId: "d-closed",
      payload: pullRequestPayload({ action: "closed", title: `task-${closed.id}`, merged: false }),
    });
    expect((await getTask(closed.id)).comments.at(-1)?.body).toContain("closed without merging:");
  });

  it("links and records an event but leaves no comment for ready_for_review / edited", async () => {
    const task = await makeTask();

    await processGithubWebhook({
      name: "pull_request",
      deliveryId: "d-ready",
      payload: pullRequestPayload({ action: "ready_for_review", title: `task-${task.id}` }),
    });

    const after = await getTask(task.id);
    expect(after.links).toHaveLength(1);
    expect(after.comments).toHaveLength(0);
    expect(await eventsFor(task.id)).toContainEqual(
      expect.objectContaining({ type: "github.pull_request" }),
    );
  });

  it("deduplicates a redelivery: the same deliveryId is a no-op the second time", async () => {
    const task = await makeTask();
    const payload = pullRequestPayload({ action: "opened", title: `task-${task.id}` });

    await processGithubWebhook({ name: "pull_request", deliveryId: "d-repeat", payload });
    const result = await processGithubWebhook({
      name: "pull_request",
      deliveryId: "d-repeat",
      payload,
    });

    expect(result.body).toEqual({ linkedTasks: [task.id] });
    expect((await getTask(task.id)).comments).toHaveLength(1);
    // task.updated (the link) + github.pull_request + comment.created — once, not twice.
    expect(await eventsFor(task.id)).toHaveLength(3);
    expect(
      (await eventsFor(task.id)).filter((event) => event.type === "github.pull_request"),
    ).toHaveLength(1);
  });

  it("ignores an id with no matching task", async () => {
    const result = await processGithubWebhook({
      name: "pull_request",
      deliveryId: "d-missing",
      payload: pullRequestPayload({ action: "opened", title: "Fix task-999999" }),
    });

    expect(result.body).toEqual({ linkedTasks: [] });
  });

  it("finds the reference in the head branch as well as the title", async () => {
    const task = await makeTask();

    const result = await processGithubWebhook({
      name: "pull_request",
      deliveryId: "d-branch",
      payload: pullRequestPayload({
        action: "opened",
        title: "Fix login",
        ref: `task-${task.id}-fix`,
      }),
    });

    expect(result.body).toEqual({ linkedTasks: [task.id] });
  });
});

/* ------------------------------------------------------------------ *
 * Link status
 * ------------------------------------------------------------------ */

describe("getTaskGithubStatus", () => {
  beforeEach(() => {
    env.GITHUB_TOKEN = "gh-token";
  });

  const fakeClient = (overrides: Partial<GithubClient> = {}): GithubClient => ({
    getIssue: async () => {
      throw new Error("not stubbed");
    },
    getPullRequest: async () => {
      throw new Error("not stubbed");
    },
    getCombinedStatus: async () => {
      throw new Error("not stubbed");
    },
    ...overrides,
  });

  it("throws INTEGRATION_NOT_CONFIGURED when the integration is off", async () => {
    env.GITHUB_TOKEN = undefined;
    env.GITHUB_WEBHOOK_SECRET = undefined;
    const task = await makeTask();

    await expect(getTaskGithubStatus(task.id)).rejects.toMatchObject({
      code: "INTEGRATION_NOT_CONFIGURED",
    });
  });

  it("resolves an open PR with a passing check", async () => {
    const task = await makeTask({
      links: [{ label: "PR", url: "https://github.com/acme/widgets/pull/12" }],
    });
    const client = fakeClient({
      getPullRequest: async () => ({
        title: "Fix login",
        body: "",
        state: "open",
        draft: false,
        merged: false,
        html_url: "https://github.com/acme/widgets/pull/12",
        head: { sha: "abc123", ref: "task-1" },
      }),
      getCombinedStatus: async () => ({ state: "success" }),
    });

    const status = await getTaskGithubStatus(task.id, client);

    expect(status.data).toEqual([
      {
        url: "https://github.com/acme/widgets/pull/12",
        kind: "pull",
        repo: "acme/widgets",
        number: 12,
        title: "Fix login",
        state: "open",
        checks: "success",
        error: null,
        fetchedAt: expect.any(String) as unknown,
      },
    ]);
  });

  it("maps a merged PR to state 'merged' and a draft PR to state 'draft'", async () => {
    const task = await makeTask({
      links: [
        { label: "merged", url: "https://github.com/acme/widgets/pull/1" },
        { label: "draft", url: "https://github.com/acme/widgets/pull/2" },
      ],
    });
    const client = fakeClient({
      getPullRequest: async (_o, _r, number) => ({
        title: "PR",
        body: "",
        state: "open",
        draft: number === 2,
        merged: number === 1,
        html_url: `https://github.com/acme/widgets/pull/${number}`,
        head: { sha: "sha", ref: "x" },
      }),
      getCombinedStatus: async () => ({ state: "pending" }),
    });

    const status = await getTaskGithubStatus(task.id, client);
    const byNumber = Object.fromEntries(status.data.map((d) => [d.number, d.state]));
    expect(byNumber[1]).toBe("merged");
    expect(byNumber[2]).toBe("draft");
  });

  it("resolves an issue with no checks field", async () => {
    const task = await makeTask({
      links: [{ label: "Issue", url: "https://github.com/acme/widgets/issues/9" }],
    });
    const client = fakeClient({
      getIssue: async () => ({
        title: "Crash on load",
        body: "",
        state: "closed",
        html_url: "https://github.com/acme/widgets/issues/9",
      }),
    });

    const status = await getTaskGithubStatus(task.id, client);

    expect(status.data[0]).toMatchObject({ kind: "issue", state: "closed", checks: null });
  });

  it("carries a per-link error instead of failing the whole response", async () => {
    const task = await makeTask({
      links: [
        { label: "ok", url: "https://github.com/acme/widgets/issues/1" },
        { label: "gone", url: "https://github.com/acme/widgets/issues/2" },
      ],
    });
    const client = fakeClient({
      getIssue: async (_o, _r, number) => {
        if (number === 2) throw new GithubApiError("Not found", 404);
        return {
          title: "Ok",
          body: "",
          state: "open",
          html_url: "https://github.com/acme/widgets/issues/1",
        };
      },
    });

    const status = await getTaskGithubStatus(task.id, client);
    const byNumber = Object.fromEntries(status.data.map((d) => [d.number, d]));

    expect(byNumber[1]?.error).toBeNull();
    expect(byNumber[2]?.state).toBeNull();
    expect(byNumber[2]?.error).toBeTruthy();
  });

  it("ignores a link that is not a GitHub URL", async () => {
    const task = await makeTask({
      links: [{ label: "docs", url: "https://example.com/design-doc" }],
    });

    const status = await getTaskGithubStatus(task.id, fakeClient());

    expect(status.data).toEqual([]);
  });

  it("caches a resolved link for the TTL — a second call within it makes no further request", async () => {
    const task = await makeTask({
      links: [{ label: "Issue", url: "https://github.com/acme/widgets/issues/42" }],
    });
    let calls = 0;
    const client = fakeClient({
      getIssue: async () => {
        calls += 1;
        return { title: "Once", body: "", state: "open", html_url: "" };
      },
    });

    await getTaskGithubStatus(task.id, client);
    await getTaskGithubStatus(task.id, client);

    expect(calls).toBe(1);
  });

  it("throws TASK_NOT_FOUND for an unknown task", async () => {
    await expect(getTaskGithubStatus(999_999, fakeClient())).rejects.toMatchObject({
      code: "TASK_NOT_FOUND",
    });
  });
});

/* ------------------------------------------------------------------ *
 * Issue import
 * ------------------------------------------------------------------ */

describe("importGithubIssue", () => {
  beforeEach(() => {
    env.GITHUB_TOKEN = "gh-token";
  });

  const fakeClient = (overrides: Partial<GithubClient> = {}): GithubClient => ({
    getIssue: async () => ({
      title: "Printer jams on floor 3",
      body: "The printer on floor 3 jams on every duplex job.",
      state: "open",
      html_url: "https://github.com/acme/widgets/issues/5",
    }),
    getPullRequest: async () => {
      throw new Error("not stubbed");
    },
    getCombinedStatus: async () => {
      throw new Error("not stubbed");
    },
    ...overrides,
  });

  it("throws INTEGRATION_NOT_CONFIGURED when the integration is off", async () => {
    env.GITHUB_TOKEN = undefined;
    env.GITHUB_WEBHOOK_SECRET = undefined;

    await expect(
      importGithubIssue(
        { issue: "https://github.com/acme/widgets/issues/5", status: "backlog" },
        "human:tester",
        fakeClient(),
      ),
    ).rejects.toMatchObject({ code: "INTEGRATION_NOT_CONFIGURED" });
  });

  it("creates a task from the issue: title, body, a link back, and a slugified project", async () => {
    const { task, created } = await importGithubIssue(
      { issue: "https://github.com/acme/widgets/issues/5", status: "backlog" },
      "human:tester",
      fakeClient(),
    );

    expect(created).toBe(true);
    expect(task.title).toBe("Printer jams on floor 3");
    expect(task.description).toContain("duplex job");
    expect(task.project).toBe("widgets");
    expect(task.links).toEqual([
      { label: "Issue acme/widgets#5", url: "https://github.com/acme/widgets/issues/5" },
    ]);
    expect(task.createdBy).toBe("human:tester");
  });

  it("pads a short title and a short/empty body to the contract minimums", async () => {
    const client = fakeClient({
      getIssue: async () => ({ title: "Hi", body: "", state: "open", html_url: "" }),
    });

    const { task } = await importGithubIssue(
      { issue: "https://github.com/acme/widgets/issues/6", status: "backlog" },
      "human:tester",
      client,
    );

    expect(task.title.length).toBeGreaterThanOrEqual(5);
    expect(task.description.length).toBeGreaterThanOrEqual(10);
    expect(task.description).toContain("Imported from");
  });

  it("replays an existing import idempotently — 200 semantics via `created: false`", async () => {
    const first = await importGithubIssue(
      { issue: "https://github.com/acme/widgets/issues/5", status: "backlog" },
      "human:tester",
      fakeClient(),
    );
    const second = await importGithubIssue(
      { issue: "https://github.com/acme/widgets/issues/5", status: "backlog" },
      "human:other",
      fakeClient(),
    );

    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(second.task.createdBy).toBe("human:tester");
  });

  it("refuses a pull request with a field-scoped VALIDATION_ERROR", async () => {
    const client = fakeClient({
      getIssue: async () => ({
        title: "Fix login",
        body: "",
        state: "open",
        html_url: "",
        pull_request: {},
      }),
    });

    const thrown = await importGithubIssue(
      { issue: "https://github.com/acme/widgets/issues/5", status: "backlog" },
      "human:tester",
      client,
    ).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).code).toBe("VALIDATION_ERROR");
    expect((thrown as ApiError).details).toMatchObject({ issue: expect.any(Array) as unknown });
  });

  it("maps a 404 from GitHub to GITHUB_NOT_FOUND", async () => {
    const client = fakeClient({
      getIssue: async () => {
        throw new GithubApiError("Not found", 404);
      },
    });

    await expect(
      importGithubIssue(
        { issue: "https://github.com/acme/widgets/issues/404", status: "backlog" },
        "human:tester",
        client,
      ),
    ).rejects.toMatchObject({ code: "GITHUB_NOT_FOUND" });
  });

  it("maps a rate limit / 5xx from GitHub to GITHUB_UNAVAILABLE", async () => {
    const client = fakeClient({
      getIssue: async () => {
        throw new GithubApiError("rate limited", 403, true);
      },
    });

    await expect(
      importGithubIssue(
        { issue: "https://github.com/acme/widgets/issues/7", status: "backlog" },
        "human:tester",
        client,
      ),
    ).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
  });

  it("honours an explicit project over the repo-derived slug", async () => {
    const { task } = await importGithubIssue(
      {
        issue: "https://github.com/acme/widgets/issues/8",
        project: "mobile-app",
        status: "backlog",
      },
      "human:tester",
      fakeClient(),
    );

    expect(task.project).toBe("mobile-app");
  });
});
