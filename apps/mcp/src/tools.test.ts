import { afterEach, describe, expect, it } from "vitest";

import {
  apiError,
  connect,
  makeSummary,
  makeTask,
  page,
  type RecordedRequest,
  type Responder,
} from "./test/harness.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const setup = async (responder: Responder, config?: Parameters<typeof connect>[1]) => {
  const session = await connect(responder, config);
  close = session.close;
  return session;
};

/** Answers every request with one task — enough for tests that only inspect the request. */
const echoTask =
  (overrides = {}): Responder =>
  () => ({ status: 200, body: makeTask(overrides) });

const only = (requests: RecordedRequest[]): RecordedRequest => {
  expect(requests).toHaveLength(1);
  return requests[0]!;
};

describe("tool listing", () => {
  it("exposes every tool with an object input schema and a description", async () => {
    const { client } = await setup(echoTask());
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "task_add_dependency",
        "task_answer_decision",
        "task_block",
        "task_claim",
        "task_comment",
        "task_create",
        "task_events",
        "task_get",
        "task_heartbeat",
        "task_import_github_issue",
        "task_list",
        "task_next",
        "task_release",
        "task_remove_dependency",
        "task_request_action",
        "task_request_decision",
        "task_stats",
        "task_submit_for_qa",
        "task_transition",
        "task_update",
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.description?.length, tool.name).toBeGreaterThan(40);
    }
  });

  it("publishes the contract's limits in the JSON schema the model sees", async () => {
    const { client } = await setup(echoTask());
    const { tools } = await client.listTools();
    const decision = tools.find((tool) => tool.name === "task_request_decision")!;
    const options = (
      decision.inputSchema.properties as Record<string, { minItems?: number; maxItems?: number }>
    ).options!;
    expect(options).toMatchObject({ minItems: 2, maxItems: 6 });
  });
});

describe("headers", () => {
  it("sends X-Actor on every request and no Authorization without a token", async () => {
    const { call, requests } = await setup(echoTask());
    await call("task_get", { taskId: 42 });
    const request = only(requests);
    expect(request.headers["x-actor"]).toBe("agent:test-bot");
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers["content-type"]).toBeUndefined();
  });

  it("sends a bearer token when TASKS_API_TOKEN is configured", async () => {
    const { call, requests } = await setup(echoTask(), { token: "s3cret" });
    await call("task_get", { taskId: 42 });
    expect(only(requests).headers.authorization).toBe("Bearer s3cret");
  });

  it("marks JSON bodies with a content type", async () => {
    const { call, requests } = await setup(echoTask());
    await call("task_claim", { taskId: 42 });
    expect(only(requests).headers["content-type"]).toBe("application/json");
  });
});

describe("reads", () => {
  it("task_list maps filters to repeated query params and fills the defaults", async () => {
    const { call, requests } = await setup(() => ({
      status: 200,
      body: {
        data: [makeTask()],
        meta: {
          page: 1,
          pageSize: 20,
          total: 1,
          totalPages: 1,
          hasNextPage: false,
          hasPrevPage: false,
        },
      },
    }));
    const result = await call("task_list", {
      status: ["needs_user_decision", "needs_qa"],
      project: ["helpdesk"],
      q: "login",
    });
    const request = only(requests);
    expect(request.method).toBe("GET");
    expect(request.path).toBe("/tasks");
    expect(request.query.getAll("status")).toEqual(["needs_user_decision", "needs_qa"]);
    expect(request.query.getAll("project")).toEqual(["helpdesk"]);
    expect(request.query.get("q")).toBe("login");
    expect(request.query.get("sort")).toBe("createdAt:desc");
    expect(request.query.get("page")).toBe("1");
    expect(request.query.get("pageSize")).toBe("20");
    expect(result.text).toContain("TASK-000042 [backlog] Fix the login redirect");
  });

  it("task_list does not apply the default project — a read should not silently hide work", async () => {
    const { call, requests } = await setup(
      () => ({
        status: 200,
        body: {
          data: [],
          meta: {
            page: 1,
            pageSize: 20,
            total: 0,
            totalPages: 1,
            hasNextPage: false,
            hasPrevPage: false,
          },
        },
      }),
      { defaultProject: "helpdesk" },
    );
    const result = await call("task_list", {});
    expect(only(requests).query.has("project")).toBe(false);
    expect(result.text).toContain("No tasks match.");
  });

  it("task_list truncates long descriptions in the verbose JSON", async () => {
    const { call, requests } = await setup(() =>
      page([makeTask({ description: "x".repeat(2000) })]),
    );
    const result = await call("task_list", { verbose: true });
    expect(requests[0]!.query.has("verbose")).toBe(false);
    expect(result.text).not.toContain("x".repeat(400));
    expect(result.text).toContain("truncated; task_get for full text");
    expect(result.text).toContain('"meta":');
  });

  it("task_list is compact by default: one line per task plus a single-lined snippet, no JSON", async () => {
    const { call } = await setup(() =>
      page([
        makeSummary({
          id: 7,
          reference: "TASK-000007",
          title: "Split the board into lanes",
          status: "in_progress",
          priority: "high",
          project: "helpdesk",
          labels: ["api", "web"],
          parentId: 3,
          childCount: 2,
          openDependencyCount: 1,
          claim: { actor: "agent:claude-code@helpdesk", expiresAt: "2026-09-25T10:30:00.000Z" },
          version: 4,
          updatedAt: "2026-09-24T08:00:00.000Z",
          description: `First line\n\nsecond   line ${"y".repeat(300)}`,
        }),
        makeSummary({ status: "blocked", statusNote: "Waiting on the upstream release" }),
      ]),
    );
    const result = await call("task_list", {});
    const lines = result.text.split("\n");
    expect(lines[1]).toBe(
      "- TASK-000007 [in_progress] Split the board into lanes · high · project helpdesk · labels api,web · parent #3 · 2 subtasks · 1 open dependency · claimed by agent:claude-code@helpdesk · v4 · updated 2026-09-24",
    );
    expect(lines[2]).toMatch(/^ {2}First line second line y+…$/);
    expect(lines[2]!.length).toBeLessThanOrEqual(2 + 160 + 1);
    expect(result.text).toContain("  note: Waiting on the upstream release");
    expect(result.text).not.toContain("{");
  });

  it("task_list forwards the discovery filters and accepts references for task ids", async () => {
    const { call, requests } = await setup(() => page([]));
    await call("task_list", {
      label: ["web"],
      parentIsNull: true,
      dependsOn: "TASK-000042",
      dependencyOf: 7,
      q: '"login redirect" safari',
    });
    const { query } = only(requests);
    expect(query.getAll("label")).toEqual(["web"]);
    expect(query.get("parentIsNull")).toBe("true");
    expect(query.get("dependsOn")).toBe("42");
    expect(query.get("dependencyOf")).toBe("7");
    expect(query.get("q")).toBe('"login redirect" safari');
  });

  it("task_get accepts a reference and resolves it to the id", async () => {
    const { call, requests } = await setup(
      echoTask({ status: "in_progress", version: 7, statusNote: "on it" }),
    );
    const result = await call("task_get", { taskId: "TASK-000042" });
    expect(only(requests).path).toBe("/tasks/42");
    expect(result.text).toContain("v7");
    expect(result.text).toContain("statusNote: on it");
    expect(result.text).toContain('"version":7');
  });

  it("task_get spells out answered decisions", async () => {
    const { call } = await setup(
      echoTask({
        status: "todo",
        decisions: [
          {
            id: 3,
            taskId: 42,
            status: "answered",
            question: "Which auth library?",
            options: [{ label: "A" }, { label: "B" }],
            recommendedOption: "A",
            context: null,
            requestedBy: "agent:test-bot",
            choice: "B",
            note: "keep the old endpoint for a release",
            answeredBy: "human:krisz",
            createdAt: "2026-09-25T10:00:00.000Z",
            answeredAt: "2026-09-25T11:00:00.000Z",
          },
        ],
      }),
    );
    const result = await call("task_get", { taskId: 42 });
    expect(result.text).toContain(
      "answered decision: Which auth library? → B — keep the old endpoint for a release (by human:krisz)",
    );
  });

  it("task_get rejects a malformed reference before any request", async () => {
    const { call, requests } = await setup(echoTask());
    const result = await call("task_get", { taskId: "not-a-task" });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("task_events passes the cursor, task, and limit", async () => {
    const { call, requests } = await setup(() => ({
      status: 200,
      body: { data: [], meta: { nextAfter: 17, hasMore: false } },
    }));
    const result = await call("task_events", { after: 17, taskId: "#42", limit: 10 });
    const request = only(requests);
    expect(request.path).toBe("/events");
    expect(Object.fromEntries(request.query)).toEqual({ after: "17", taskId: "42", limit: "10" });
    expect(result.text).toContain("after=17");
  });

  it("task_events filters by project, actor, and type — and applies no default project", async () => {
    const { call, requests } = await setup(
      () => ({
        status: 200,
        body: {
          data: [
            {
              id: 5,
              taskId: 42,
              taskTitle: "Accept a project filter",
              project: "helpdesk",
              type: "task.status_changed",
              actor: "human:dana",
              payload: {},
              createdAt: "2026-09-25T10:00:00.000Z",
            },
          ],
          meta: { nextAfter: 5, hasMore: false },
        },
      }),
      { defaultProject: "helpdesk" },
    );
    await call("task_events", {});
    const result = await call("task_events", {
      project: ["helpdesk"],
      actor: "human:dana",
      type: ["task.status_changed", "decision.answered"],
    });
    expect(requests[0]!.query.has("project")).toBe(false);
    expect(requests[1]!.query.getAll("project")).toEqual(["helpdesk"]);
    expect(requests[1]!.query.get("actor")).toBe("human:dana");
    expect(requests[1]!.query.getAll("type")).toEqual(["task.status_changed", "decision.answered"]);
    expect(result.text).toContain(
      'task 42 "Accept a project filter" (helpdesk) task.status_changed by human:dana',
    );
  });

  it("task_stats passes the project filter", async () => {
    const byStatus = Object.fromEntries(
      [
        "backlog",
        "needs_refinement",
        "todo",
        "in_progress",
        "blocked",
        "needs_user_decision",
        "needs_user_action",
        "needs_qa",
        "done",
        "deferred",
      ].map((status) => [status, 1]),
    );
    const { call, requests } = await setup(() => ({
      status: 200,
      body: { byStatus, needsAttention: 3 },
    }));
    const result = await call("task_stats", { project: ["helpdesk", "web"] });
    const request = only(requests);
    expect(request.path).toBe("/tasks/stats");
    expect(request.query.getAll("project")).toEqual(["helpdesk", "web"]);
    expect(result.text).toContain("3 task(s) need a human.");
  });
});

describe("task_create", () => {
  const createBody = {
    title: "Add rate limiting",
    description: "The public API has no rate limiting at all.",
  };

  it("always sends an idempotency key, derived from project + title", async () => {
    const { call, requests } = await setup(() => ({ status: 201, body: makeTask() }), {
      defaultProject: "helpdesk",
    });
    const result = await call("task_create", createBody);
    const request = only(requests);
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/tasks");
    expect(request.body).toEqual({
      ...createBody,
      status: "backlog",
      priority: "medium",
      project: "helpdesk",
      idempotencyKey: "mcp:helpdesk:add-rate-limiting",
    });
    expect(result.text).toContain("Created TASK-000042.");
  });

  it("passes labels through, canonicalised by the contract", async () => {
    const { call, requests } = await setup(() => ({ status: 201, body: makeTask() }));
    await call("task_create", { ...createBody, labels: ["Web", "api", "web"] });
    expect(only(requests).body).toMatchObject({ labels: ["api", "web"] });
  });

  it("keeps a caller's own key and an explicit null project", async () => {
    const { call, requests } = await setup(() => ({ status: 201, body: makeTask() }), {
      defaultProject: "helpdesk",
    });
    await call("task_create", { ...createBody, project: null, idempotencyKey: "mine-1" });
    expect(only(requests).body).toMatchObject({ project: null, idempotencyKey: "mine-1" });
  });

  it("says so when the API replays an existing task (200)", async () => {
    const { call } = await setup(() => ({ status: 200, body: makeTask() }));
    const result = await call("task_create", createBody);
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Already open as TASK-000042");
  });

  it("enforces the contract's todo rule before calling the API", async () => {
    const { call, requests } = await setup(() => ({ status: 201, body: makeTask() }));
    const result = await call("task_create", { ...createBody, status: "todo" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Acceptance criteria are required");
    expect(requests).toHaveLength(0);
  });

  it("creates, then transitions with the created version as expectedVersion", async () => {
    const { call, requests } = await setup((request) =>
      request.path === "/tasks"
        ? { status: 201, body: makeTask({ version: 1 }) }
        : { status: 200, body: makeTask({ status: "blocked", version: 2, statusNote: "waiting" }) },
    );
    const result = await call("task_create", {
      ...createBody,
      transition: { to: "blocked", blockedBy: [7] },
    });
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /tasks",
      "POST /tasks/42/transition",
    ]);
    expect(requests[1]!.body).toEqual({ to: "blocked", blockedBy: [7], expectedVersion: 1 });
    expect(result.text).toContain("Then moved to blocked.");
    expect(result.text).toContain("[blocked]");
  });

  it("reports a failed transition as an error that says the task exists", async () => {
    const { call, requests } = await setup((request) =>
      request.path === "/tasks"
        ? { status: 201, body: makeTask() }
        : apiError(422, "VALIDATION_ERROR", "Request validation failed", { reason: ["Required"] }),
    );
    const result = await call("task_create", {
      ...createBody,
      transition: { to: "deferred", reason: "later" },
    });
    expect(requests).toHaveLength(2);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("TASK-000042 WAS created");
    expect(result.text).toContain("Do not create it again");
    expect(result.text).toContain("VALIDATION_ERROR");
  });

  it("on a replay, skips the transition when the task has moved on since", async () => {
    const { call, requests } = await setup(() => ({
      status: 200,
      body: makeTask({ status: "needs_qa" }),
    }));
    const result = await call("task_create", { ...createBody, transition: { to: "in_progress" } });
    expect(requests).toHaveLength(1);
    expect(result.text).toContain("transition was skipped");
  });

  it("on a replay, finishes a transition the first run never made", async () => {
    const { call, requests } = await setup((request) =>
      request.path === "/tasks"
        ? { status: 200, body: makeTask({ status: "backlog", version: 1 }) }
        : { status: 200, body: makeTask({ status: "in_progress", version: 2 }) },
    );
    await call("task_create", { ...createBody, transition: { to: "in_progress" } });
    expect(requests).toHaveLength(2);
  });
});

describe("writes", () => {
  it("task_update PATCHes the fields without taskId", async () => {
    const { call, requests } = await setup(echoTask());
    await call("task_update", { taskId: 42, priority: "high", expectedVersion: 3 });
    const request = only(requests);
    expect(request.method).toBe("PATCH");
    expect(request.path).toBe("/tasks/42");
    expect(request.body).toEqual({ priority: "high", expectedVersion: 3 });
  });

  it("task_transition forwards the payload as-is", async () => {
    const { call, requests } = await setup(echoTask());
    await call("task_transition", {
      taskId: 42,
      transition: { to: "needs_refinement", reason: "No repro steps", expectedVersion: 2 },
    });
    const request = only(requests);
    expect(request.path).toBe("/tasks/42/transition");
    expect(request.body).toEqual({
      to: "needs_refinement",
      reason: "No repro steps",
      expectedVersion: 2,
    });
  });

  it("task_submit_for_qa transitions to needs_qa with summary and links", async () => {
    const { call, requests } = await setup(echoTask({ status: "needs_qa" }));
    const links = [{ label: "PR", url: "https://github.com/acme/repo/pull/1" }];
    await call("task_submit_for_qa", {
      taskId: 42,
      summary: "Added the limiter",
      links,
      expectedVersion: 4,
    });
    expect(only(requests).body).toEqual({
      to: "needs_qa",
      summary: "Added the limiter",
      links,
      expectedVersion: 4,
    });
  });

  it("task_request_decision nests the decision payload", async () => {
    const { call, requests } = await setup(echoTask({ status: "needs_user_decision" }));
    await call("task_request_decision", {
      taskId: 42,
      question: "Which store for the limiter?",
      options: [{ label: "Redis", description: "New dependency" }, { label: "In-memory" }],
      recommendedOption: "In-memory",
      expectedVersion: 5,
    });
    expect(only(requests).body).toEqual({
      to: "needs_user_decision",
      decision: {
        question: "Which store for the limiter?",
        options: [{ label: "Redis", description: "New dependency" }, { label: "In-memory" }],
        recommendedOption: "In-memory",
      },
      expectedVersion: 5,
    });
  });

  it("task_request_decision rejects a single option before any request", async () => {
    const { call, requests } = await setup(echoTask());
    const result = await call("task_request_decision", {
      taskId: 42,
      question: "Which store for the limiter?",
      options: [{ label: "Redis" }],
    });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("task_request_action and task_block map to their transitions", async () => {
    const { call, requests } = await setup(echoTask());
    await call("task_request_action", {
      taskId: 42,
      instructions: "Create the STRIPE_KEY secret in CI",
    });
    await call("task_block", { taskId: 42, blockedBy: [7, 8] });
    expect(requests.map((request) => request.body)).toEqual([
      { to: "needs_user_action", instructions: "Create the STRIPE_KEY secret in CI" },
      { to: "blocked", blockedBy: [7, 8] },
    ]);
  });

  it("task_next scopes to the default project unless allProjects is set", async () => {
    const { call, requests } = await setup(
      () => ({ status: 200, body: { task: makeTask({ status: "in_progress" }) } }),
      {
        defaultProject: "helpdesk",
      },
    );
    const claimed = await call("task_next", { minPriority: "high" });
    await call("task_next", { allProjects: true });
    await call("task_next", { project: ["web"] });
    await call("task_next", { label: ["Web"] });
    expect(requests.map((request) => request.body)).toEqual([
      { minPriority: "high", project: ["helpdesk"] },
      {},
      { project: ["web"] },
      { label: ["web"], project: ["helpdesk"] },
    ]);
    expect(requests[0]!.path).toBe("/tasks/next");
    expect(claimed.text).toContain("Claimed TASK-000042");
  });

  it("task_next explains an empty queue without flagging an error", async () => {
    const { call } = await setup(() => ({ status: 200, body: { task: null } }), {
      defaultProject: "helpdesk",
    });
    const result = await call("task_next", {});
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Nothing to claim in project helpdesk");
  });

  it("claim, heartbeat, and release hit their endpoints", async () => {
    const { call, requests } = await setup(
      echoTask({
        status: "in_progress",
        claim: { actor: "agent:test-bot", expiresAt: "2026-09-25T10:30:00.000Z" },
      }),
    );
    await call("task_claim", { taskId: 42, expectedVersion: 2 });
    const beat = await call("task_heartbeat", { taskId: 42 });
    await call("task_release", { taskId: 42, reason: "Out of time; tests still red" });
    expect(requests.map((request) => [request.path, request.body])).toEqual([
      ["/tasks/42/claim", { expectedVersion: 2 }],
      ["/tasks/42/heartbeat", undefined],
      ["/tasks/42/release", { reason: "Out of time; tests still red" }],
    ]);
    expect(requests[1]!.headers["content-type"]).toBeUndefined();
    expect(beat.text).toContain("Lease extended until 2026-09-25T10:30:00.000Z");
  });

  it("task_comment posts body and kind", async () => {
    const { call, requests } = await setup(() => ({
      status: 201,
      body: {
        id: 9,
        taskId: 42,
        author: "agent:test-bot",
        kind: "progress",
        body: "Tests pass",
        createdAt: "2026-09-25T10:00:00.000Z",
      },
    }));
    const result = await call("task_comment", { taskId: 42, body: "Tests pass", kind: "progress" });
    const request = only(requests);
    expect(request.path).toBe("/tasks/42/comments");
    expect(request.body).toEqual({ body: "Tests pass", kind: "progress" });
    expect(result.text).toContain("Comment #9 (progress)");
  });

  it("dependencies and decision answers hit their endpoints", async () => {
    const { call, requests } = await setup(echoTask());
    await call("task_add_dependency", { taskId: 42, dependsOnId: 7 });
    await call("task_remove_dependency", { taskId: 42, dependsOnId: "TASK-7" });
    await call("task_answer_decision", { taskId: 42, choice: "Redis" });
    expect(requests.map((request) => [request.method, request.path, request.body])).toEqual([
      ["POST", "/tasks/42/dependencies", { dependsOnId: 7 }],
      ["DELETE", "/tasks/42/dependencies/7", undefined],
      ["POST", "/tasks/42/decision/answer", { choice: "Redis" }],
    ]);
  });
});

describe("errors", () => {
  it("VERSION_CONFLICT carries details and a re-read hint", async () => {
    const { call } = await setup(() =>
      apiError(409, "VERSION_CONFLICT", "The task changed since you read it", {
        expected: 3,
        current: 5,
      }),
    );
    const result = await call("task_update", {
      taskId: 42,
      title: "New title here",
      expectedVersion: 3,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("VERSION_CONFLICT (HTTP 409)");
    expect(result.text).toContain('details: {"expected":3,"current":5}');
    expect(result.text).toContain("hint: Someone changed the task");
    expect(result.text).toContain("requestId: req-1");
  });

  it.each([
    ["TASK_ALREADY_CLAIMED", 409, "pick another"],
    ["VALIDATION_ERROR", 422, "Fix the fields named in details"],
    ["UNAUTHORIZED", 401, "TASKS_API_TOKEN"],
    ["ACTOR_NOT_PERMITTED", 403, "task_submit_for_qa"],
  ])("%s gets its hint", async (code, status, hint) => {
    const { call } = await setup(() => apiError(status, code, "nope"));
    const result = await call("task_claim", { taskId: 42 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`${code} (HTTP ${status}): nope`);
    expect(result.text).toContain(hint);
  });

  it("an unreachable API names the URL and how to start it", async () => {
    const { call } = await setup(() => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }),
      });
    });
    const result = await call("task_get", { taskId: 42 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Task manager API not reachable at http://api.test/api/v1");
    expect(result.text).toContain("ECONNREFUSED");
    expect(result.text).toContain("pnpm dev:api");
  });

  it("a non-envelope error response is reported as a setup problem", async () => {
    const { call } = await setup(() => ({ status: 502, raw: "<html>Bad Gateway</html>" }));
    const result = await call("task_get", { taskId: 42 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("HTTP 502");
    expect(result.text).toContain("TASKS_API_URL");
  });
});

describe("task_get detail", () => {
  const comments = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      taskId: 42,
      author: "agent:test-bot",
      kind: "progress" as const,
      body: `comment ${index + 1}`,
      createdAt: "2026-09-25T10:00:00.000Z",
    }));

  it("keeps the 10 most recent comments by default and says how to get the rest", async () => {
    const { call } = await setup(echoTask({ comments: comments(25), commentCount: 25 }));
    const result = await call("task_get", { taskId: 42 });
    expect(result.text).toContain(
      "comments: showing the 10 most recent of 25; 15 older omitted — task_get with commentLimit: 25",
    );
    const json = JSON.parse(result.text.split("\n").at(-1)!) as { comments: { id: number }[] };
    expect(json.comments.map((comment) => comment.id)).toEqual([
      16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
    ]);
  });

  it("commentLimit 0 drops them all; a limit above the count keeps them all silently", async () => {
    const { call } = await setup(echoTask({ comments: comments(3), commentCount: 3 }));
    const none = await call("task_get", { taskId: 42, commentLimit: 0 });
    expect(none.text).toContain("comments: 3 not shown (commentLimit 0)");
    expect(none.text).toContain('"comments":[]');
    const all = await call("task_get", { taskId: 42, commentLimit: 50 });
    expect(all.text).not.toContain("comments:");
    expect(all.text).toContain('"body":"comment 1"');
  });

  it("rejects a commentLimit above the maximum", async () => {
    const { call, requests } = await setup(echoTask());
    const result = await call("task_get", { taskId: 42, commentLimit: 5000 });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("lists relations, naming the project only when it differs", async () => {
    const ref = (id: number, project: string | null) => ({
      id,
      reference: `TASK-00000${id}`,
      title: `Task ${id}`,
      status: "todo" as const,
      project,
    });
    const { call } = await setup(
      echoTask({
        parentId: 1,
        parent: ref(1, "helpdesk"),
        children: [ref(2, "helpdesk")],
        dependencies: [ref(3, "mobile-app")],
        dependents: [ref(4, null)],
      }),
    );
    const result = await call("task_get", { taskId: 42 });
    expect(result.text).toContain("parent: TASK-000001 [todo] Task 1\n");
    expect(result.text).toContain("subtasks:\n  - TASK-000002 [todo] Task 2\n");
    expect(result.text).toContain(
      "depends on:\n  - TASK-000003 [todo] Task 3 (project mobile-app)",
    );
    expect(result.text).toContain("  - TASK-000004 [todo] Task 4 (project none)");
  });
});

describe("GitHub", () => {
  const githubLinks = [
    { label: "PR", url: "https://github.com/acme/web/pull/12" },
    { label: "Issue", url: "https://github.com/acme/web/issues/7" },
  ];
  const status = (overrides: Record<string, unknown>) => ({
    url: "https://github.com/acme/web/pull/12",
    kind: "pull",
    repo: "acme/web",
    number: 12,
    title: "Fix login",
    state: "merged",
    checks: "success",
    error: null,
    fetchedAt: "2026-09-25T10:00:00.000Z",
    ...overrides,
  });

  it("task_get prints one line per GitHub link", async () => {
    const { call, requests } = await setup((request) =>
      request.path === "/tasks/42/github"
        ? {
            status: 200,
            body: {
              data: [
                status({}),
                status({ kind: "issue", number: 7, state: "open", checks: null }),
                status({ number: 9, state: null, checks: null, error: "Not found" }),
              ],
            },
          }
        : { status: 200, body: makeTask({ links: githubLinks }) },
    );
    const result = await call("task_get", { taskId: 42 });
    expect(requests.map((request) => request.path)).toEqual(["/tasks/42", "/tasks/42/github"]);
    expect(result.text).toContain("github: PR acme/web#12 merged · checks success");
    expect(result.text).toContain("github: issue acme/web#7 open\n");
    expect(result.text).toContain("github: PR acme/web#9 — unavailable: Not found");
  });

  it("skips the lookup for a task without GitHub links", async () => {
    const { call, requests } = await setup(
      echoTask({ links: [{ label: "Doc", url: "https://example.com/spec" }] }),
    );
    await call("task_get", { taskId: 42 });
    expect(requests).toHaveLength(1);
  });

  it("remembers a disabled integration and never fails task_get over it", async () => {
    const { call, requests } = await setup((request) =>
      request.path === "/tasks/42/github"
        ? apiError(404, "INTEGRATION_NOT_CONFIGURED", "GitHub integration is off")
        : { status: 200, body: makeTask({ links: githubLinks }) },
    );
    const first = await call("task_get", { taskId: 42 });
    const second = await call("task_get", { taskId: 42 });
    expect(first.isError).toBe(false);
    expect(first.text).not.toContain("github:");
    expect(second.isError).toBe(false);
    expect(requests.map((request) => request.path)).toEqual([
      "/tasks/42",
      "/tasks/42/github",
      "/tasks/42",
    ]);
  });

  it("does not remember a transient failure", async () => {
    const { call, requests } = await setup((request) =>
      request.path === "/tasks/42/github"
        ? apiError(502, "GITHUB_UNAVAILABLE", "GitHub is down")
        : { status: 200, body: makeTask({ links: githubLinks }) },
    );
    await call("task_get", { taskId: 42 });
    const again = await call("task_get", { taskId: 42 });
    expect(again.isError).toBe(false);
    expect(requests.filter((request) => request.path === "/tasks/42/github")).toHaveLength(2);
  });

  it("task_import_github_issue posts the issue and reports create vs replay", async () => {
    let status = 201;
    const { call, requests } = await setup(() => ({ status, body: makeTask() }));
    const created = await call("task_import_github_issue", {
      issue: "https://github.com/acme/web/issues/7",
      labels: ["web"],
    });
    status = 200;
    const replay = await call("task_import_github_issue", { issue: "acme/web#7" });
    expect(requests.map((request) => [request.method, request.path, request.body])).toEqual([
      [
        "POST",
        "/integrations/github/import",
        { issue: "https://github.com/acme/web/issues/7", status: "backlog", labels: ["web"] },
      ],
      ["POST", "/integrations/github/import", { issue: "acme/web#7", status: "backlog" }],
    ]);
    expect(created.text).toContain("Imported https://github.com/acme/web/issues/7 as TASK-000042");
    expect(replay.text).toContain("Already imported as TASK-000042");
  });

  it("expands a bare #123 with the origin's repository, and refuses it without one", async () => {
    const withRepo = await setup(() => ({ status: 201, body: makeTask() }), {
      githubRepo: "acme/web",
    });
    await withRepo.call("task_import_github_issue", { issue: "#123" });
    expect(only(withRepo.requests).body).toMatchObject({ issue: "acme/web#123" });
    await withRepo.close();
    close = undefined;

    const { call, requests } = await setup(() => ({ status: 201, body: makeTask() }));
    const result = await call("task_import_github_issue", { issue: "123" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("names no repository");
    const pull = await call("task_import_github_issue", {
      issue: "https://github.com/acme/web/pull/12",
    });
    expect(pull.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it.each([
    ["INTEGRATION_NOT_CONFIGURED", 404, "task_create"],
    ["GITHUB_NOT_FOUND", 404, "GITHUB_TOKEN"],
    ["GITHUB_UNAVAILABLE", 502, "Try again later"],
  ])("%s gets its hint", async (code, httpStatus, hint) => {
    const { call } = await setup(() => apiError(httpStatus, code, "nope"));
    const result = await call("task_import_github_issue", { issue: "acme/web#7" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(hint);
  });
});
