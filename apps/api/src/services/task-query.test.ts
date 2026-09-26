import {
  formatReference,
  TASK_STATUSES,
  taskListQuerySchema,
  taskSummarySchema,
  type TaskListQuery,
} from "@helpdesk/contracts";
import { describe, expect, it } from "vitest";

import { prisma } from "../lib/prisma.js";
import {
  claimedBy,
  expiredClaimBy,
  makeComment,
  makeDecision,
  makeDependency,
  makeTask,
  makeTaskAwaitingDecision,
  makeTasks,
} from "../test/factories.js";
import {
  buildOrderBy,
  buildWhere,
  escapeLikePattern,
  LIKE_ESCAPE_CHAR,
  listTasks,
  needsEscapedSearch,
  resolveTextSearch,
} from "./task-query.js";

/**
 * The list query, against a real (temp) SQLite file. Required cases come from
 * `docs/engineering/TESTING.md` § List query — the longest list in that
 * document, and the reason stage 7 exists as its own stage.
 *
 * Conventions that make these tests able to fail:
 *
 * 1. **Params go through `taskListQuerySchema`**, never hand-built objects.
 *    Defaulting, `""`-dropping, coercion, and the mutual-exclusion refinement
 *    are all schema behaviour; a test that handed `listTasks` a pre-cooked
 *    object would assert nothing about the path a client actually takes.
 * 2. **Validation failures are asserted at the schema**, because routes do not
 *    exist yet (stage 8). Every "→ 422" bullet in TESTING.md is a
 *    `taskListQuerySchema` rejection here; the HTTP status is the route's half
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
const query = (raw: Record<string, unknown> = {}): TaskListQuery => taskListQuerySchema.parse(raw);

/** Assert the schema rejects these params, naming the field it blamed. */
const expectRejected = (raw: Record<string, unknown>, path: string): void => {
  const result = taskListQuerySchema.safeParse(raw);
  expect(result.success).toBe(false);
  const paths = result.error?.issues.map((issue) => issue.path.join(".")) ?? [];
  expect(paths).toContain(path);
};

/** Ids of the returned page, in the order the service returned them. */
const listIds = async (raw: Record<string, unknown> = {}): Promise<number[]> => {
  const page = await listTasks(query(raw));
  return page.data.map((task) => task.id);
};

/** Every field a plain (non-metacharacter) `q` term is ORed across. */
const containsBranches = (term: string) => [
  { title: { contains: term } },
  { description: { contains: term } },
  { acceptanceCriteria: { contains: term } },
  { statusNote: { contains: term } },
  { links: { contains: term } },
  { comments: { some: { body: { contains: term } } } },
];

/* ------------------------------------------------------------------ *
 * Defaults
 * ------------------------------------------------------------------ */

describe("defaults", () => {
  it("returns page 1 at size 20 sorted by createdAt descending when no params are sent", async () => {
    const [oldest, middle, newest] = await makeTasks(3, (index) => ({
      createdAt: new Date(Date.UTC(2026, 0, index + 1)),
    }));

    const page = await listTasks(query());

    expect(page.meta).toEqual({
      page: 1,
      pageSize: 20,
      total: 3,
      totalPages: 1,
      hasNextPage: false,
      hasPrevPage: false,
    });
    expect(page.data.map((task) => task.id)).toEqual([newest?.id, middle?.id, oldest?.id]);
  });

  it("returns summaries carrying commentCount rather than a comment array", async () => {
    const task = await makeTask();

    const page = await listTasks(query());

    expect(page.data[0]).toMatchObject({
      id: task.id,
      reference: formatReference(task.id),
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
    await makeTasks(5);

    const page = await listTasks(query({ page: "2", pageSize: "2" }));

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
    await makeTasks(5);

    const page = await listTasks(query({ page: "9", pageSize: "2" }));

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
    await makeTask({ status: "todo" });

    const page = await listTasks(query({ status: "deferred" }));

    expect(page.data).toEqual([]);
    // `Math.max(1, …)`. Zero would render as "Page 1 of 0" in the pager.
    expect(page.meta).toMatchObject({ total: 0, totalPages: 1, hasNextPage: false });
  });

  it("splits tied rows across pages without repeating or dropping one", async () => {
    // Every row shares a createdAt, so the default sort is entirely ties and the
    // `{ id: "desc" }` tiebreaker is the only thing making the order total.
    const createdAt = new Date(Date.UTC(2026, 4, 20));
    const tasks = await makeTasks(6, () => ({ createdAt }));
    const ids = tasks.map((task) => task.id);

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
    expect(taskListQuerySchema.safeParse({ pageSize: "100" }).success).toBe(true);
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
    const result = taskListQuerySchema.safeParse({ utm_source: "slack" });

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
    const todo = await makeTask({ status: "todo" });
    await makeTask({ status: "deferred" });

    expect(await listIds({ status: "todo" })).toEqual([todo.id]);
  });

  it("ORs repeated values within one parameter", async () => {
    const todo = await makeTask({ status: "todo" });
    const inProgress = await makeTask({ status: "in_progress" });
    await makeTask({ status: "deferred" });

    const ids = await listIds({ status: ["todo", "in_progress"] });

    expect(ids.sort((a, b) => a - b)).toEqual([todo.id, inProgress.id]);
  });

  it("ANDs across different parameters", async () => {
    const match = await makeTask({ status: "todo", priority: "urgent", project: "helpdesk" });
    await makeTask({ status: "todo", priority: "low", project: "helpdesk" });
    await makeTask({ status: "deferred", priority: "urgent", project: "helpdesk" });
    await makeTask({ status: "todo", priority: "urgent", project: "billing" });

    expect(await listIds({ status: "todo", priority: "urgent", project: "helpdesk" })).toEqual([
      match.id,
    ]);
  });

  it("does not return a rank-drifted row under the status it no longer has", async () => {
    // `statusRank` defaults to 0 and only `applyTaskRanks()` maintains it, so a
    // row written by raw SQL, a seed, or a service that forgot the helper can
    // hold `status='archived'` with `statusRank=2` — the rank meaning `todo`.
    // Filtering on the rank alone would return it for `?status=todo`, making the
    // drift a wrong result set and a wrong `meta.total`, not merely a wrong sort.
    const drifted = await makeTask({ status: "todo" });
    await prisma.$executeRawUnsafe(
      `UPDATE "Task" SET status = 'archived' WHERE id = ?`,
      drifted.id,
    );

    const page = await listTasks(query({ status: "todo" }));

    expect(page.data.map((task) => task.id)).not.toContain(drifted.id);
    expect(page.meta.total).toBe(0);
  });

  /**
   * **The consequence of ANDing the two predicates, stated as a test.**
   *
   * A drifted row is not merely filed under the wrong status — it is
   * unreachable through the status filter entirely: it fails the *text* term
   * under its true status and the *rank* term under the drifted one. So the
   * union of all ten statuses returns strictly fewer rows than no status
   * filter at all, and the two `meta.total` values disagree.
   *
   * That is the intended trade (a drifted row is corrupt data; hiding it beats
   * reporting it under a status it does not have), and it is pinned here so it
   * is a decision rather than an accident. It stays hypothetical only while
   * `applyTaskRanks()` is the sole writer of the rank columns — the stage-9
   * seed is exactly the kind of write that could bypass it, and a seeded row
   * that vanished from the list page would be a genuinely confusing bug.
   */
  it("makes a rank-drifted row unreachable under every status, so the totals disagree", async () => {
    const healthy = await makeTask({ status: "todo" });
    const drifted = await makeTask({ status: "todo" });
    await prisma.$executeRawUnsafe(
      `UPDATE "Task" SET status = 'archived' WHERE id = ?`,
      drifted.id,
    );

    const everyStatus = await listTasks(query({ status: [...TASK_STATUSES] }));
    const noFilter = await listTasks(query());

    // Unreachable under the union of every legal status…
    expect(everyStatus.data.map((task) => task.id)).toEqual([healthy.id]);
    expect(everyStatus.meta.total).toBe(1);

    // …while an unfiltered list still sees it. The two totals disagreeing is
    // the observable symptom, and it is the point of the test.
    expect(noFilter.data.map((task) => task.id)).toContain(drifted.id);
    expect(noFilter.meta.total).toBe(2);
    expect(everyStatus.meta.total).toBeLessThan(noFilter.meta.total);
  });

  it("matches project case-insensitively by lowercasing the input to match storage", async () => {
    const task = await makeTask({ project: "helpdesk" });
    await makeTask({ project: "billing" });
    await makeTask({ project: null });

    expect(await listIds({ project: "HelpDesk" })).toEqual([task.id]);
  });

  it("ORs repeated project values", async () => {
    const helpdesk = await makeTask({ project: "helpdesk" });
    const billing = await makeTask({ project: "billing" });
    await makeTask({ project: "infra" });

    const ids = await listIds({ project: ["helpdesk", "billing"] });
    expect(ids.sort((a, b) => a - b)).toEqual([helpdesk.id, billing.id]);
  });

  it("rejects a project that is not a slug", () => {
    expectRejected({ project: "two words" }, "project.0");
  });

  it("matches createdBy exactly, lowercasing the input like the stored actor", async () => {
    const byAgent = await makeTask({ createdBy: "agent:claude-code" });
    await makeTask({ createdBy: "human:krisz" });
    await makeTask({ createdBy: "agent:claude-code-2" });

    expect(await listIds({ createdBy: "Agent:Claude-Code" })).toEqual([byAgent.id]);
  });

  it("matches claimedBy against the stored holder, lowercasing the input — expired leases included", async () => {
    const live = await makeTask(claimedBy("agent:claude-code"));
    const expired = await makeTask(expiredClaimBy("agent:claude-code"));
    await makeTask(claimedBy("agent:codex"));
    await makeTask({ status: "todo" });

    const ids = await listIds({ claimedBy: "Agent:Claude-Code" });

    expect(ids.sort((a, b) => a - b)).toEqual([live.id, expired.id]);
  });

  it("returns only the subtasks of one parent for parentId", async () => {
    const parent = await makeTask();
    const other = await makeTask();
    const child = await makeTask({ parentId: parent.id });
    await makeTask({ parentId: other.id });

    expect(await listIds({ parentId: String(parent.id) })).toEqual([child.id]);
  });

  it("rejects a parentId that is not a positive integer", () => {
    expectRejected({ parentId: "0" }, "parentId");
    expectRejected({ parentId: "abc" }, "parentId");
    // Digits only, like the path parameter: no hex or exponent aliases.
    expectRejected({ parentId: "0x2a" }, "parentId");
    expectRejected({ parentId: "1e3" }, "parentId");
  });

  it("matches assignee exactly and case-sensitively", async () => {
    const task = await makeTask({ assignee: "Ada Chen" });
    await makeTask({ assignee: "ada chen" });

    expect(await listIds({ assignee: "Ada Chen" })).toEqual([task.id]);
  });

  it("returns tasks carrying any of the given labels", async () => {
    const web = await makeTask();
    await prisma.taskLabel.create({ data: { taskId: web.id, label: "web" } });
    const api = await makeTask();
    await prisma.taskLabel.create({ data: { taskId: api.id, label: "api" } });
    await makeTask();

    const ids = await listIds({ label: ["web", "api"] });
    expect(ids.sort((a, b) => a - b)).toEqual([web.id, api.id]);
  });

  it("ANDs label with other filters rather than widening past them", async () => {
    const match = await makeTask({ status: "todo" });
    await prisma.taskLabel.create({ data: { taskId: match.id, label: "web" } });
    const wrongStatus = await makeTask({ status: "done" });
    await prisma.taskLabel.create({ data: { taskId: wrongStatus.id, label: "web" } });

    expect(await listIds({ label: "web", status: "todo" })).toEqual([match.id]);
  });

  it("returns only top-level tasks when parentIsNull is true", async () => {
    const parent = await makeTask();
    const child = await makeTask({ parentId: parent.id });

    expect(await listIds({ parentIsNull: "true" })).toEqual([parent.id]);
    expect(await listIds({ parentIsNull: "true" })).not.toContain(child.id);
  });

  it("returns only subtasks when parentIsNull is false", async () => {
    const parent = await makeTask();
    const child = await makeTask({ parentId: parent.id });

    expect(await listIds({ parentIsNull: "false" })).toEqual([child.id]);
    expect(await listIds({ parentIsNull: "false" })).not.toContain(parent.id);
  });

  it("rejects parentId together with parentIsNull", () => {
    expectRejected({ parentId: "1", parentIsNull: "true" }, "parentId");
    expectRejected({ parentId: "1", parentIsNull: "true" }, "parentIsNull");
  });

  it("returns a task's dependents for dependsOn", async () => {
    const target = await makeTask();
    const dependent = await makeTask();
    await makeDependency(dependent.id, target.id);
    await makeTask();

    expect(await listIds({ dependsOn: String(target.id) })).toEqual([dependent.id]);
  });

  it("returns a task's dependencies for dependencyOf", async () => {
    const target = await makeTask();
    const dependency = await makeTask();
    await makeDependency(target.id, dependency.id);
    await makeTask();

    expect(await listIds({ dependencyOf: String(target.id) })).toEqual([dependency.id]);
  });
});

/* ------------------------------------------------------------------ *
 * assigneeIsNull
 * ------------------------------------------------------------------ */

describe("assigneeIsNull", () => {
  it("returns only unassigned tasks when true", async () => {
    const unassigned = await makeTask({ assignee: null });
    await makeTask({ assignee: "Ada Chen" });

    expect(await listIds({ assigneeIsNull: "true" })).toEqual([unassigned.id]);
  });

  it("returns only assigned tasks when false", async () => {
    const assigned = await makeTask({ assignee: "Ada Chen" });
    await makeTask({ assignee: null });

    expect(await listIds({ assigneeIsNull: "false" })).toEqual([assigned.id]);
  });

  it("treats an assignee literally named None as a person, not a sentinel", async () => {
    // The test that would have caught the rejected `assignee=none` design.
    const none = await makeTask({ assignee: "None" });
    const unassigned = await makeTask({ assignee: null });

    expect(await listIds({ assignee: "None" })).toEqual([none.id]);
    expect(await listIds({ assigneeIsNull: "true" })).toEqual([unassigned.id]);
  });
});

/* ------------------------------------------------------------------ *
 * q
 * ------------------------------------------------------------------ */

describe("q", () => {
  it("matches the title", async () => {
    const task = await makeTask({ title: "VPN drops every morning" });
    await makeTask({ title: "Printer jam", description: "Tray two" });

    expect(await listIds({ q: "vpn" })).toEqual([task.id]);
  });

  it("matches the description", async () => {
    const task = await makeTask({ title: "Laptop issue", description: "Fails with error 809" });
    await makeTask({ title: "Printer jam", description: "Tray two" });

    expect(await listIds({ q: "error 809" })).toEqual([task.id]);
  });

  it("matches a task reference in every accepted spelling", async () => {
    // Ids start at 1 in every test (`sqlite_sequence` is reset), so creating 42
    // rows in order arranges TASK-000042. Titles and descriptions carry no digits,
    // so a match can only have come from the id branch of the `OR`.
    await makeTasks(42, () => ({ title: "Printer jam", description: "Tray two sticks" }));

    for (const spelling of ["TASK-000042", "task-42", "#42", "42"]) {
      expect(await listIds({ q: spelling })).toEqual([42]);
    }
  });

  it("narrows within the active filters rather than widening past them", async () => {
    // The hoisted-`OR` regression test. If the `q` branches are lifted out of the
    // top-level `AND`, the done task comes back too and search silently
    // widens the result set past the status filter.
    const todo = await makeTask({ status: "todo", title: "VPN drops every morning" });
    const done = await makeTask({ status: "done", title: "VPN drops every evening" });

    const ids = await listIds({ q: "VPN", status: "todo" });

    expect(ids).toEqual([todo.id]);
    expect(ids).not.toContain(done.id);
  });

  it("nests its branches as one OR group inside the top-level AND", () => {
    const where = buildWhere(query({ q: "42", status: "todo" }));

    // Structural proof of the same invariant: two entries in the `AND`, one of
    // which is the whole `OR` group — not three siblings.
    expect(where.AND).toHaveLength(2);
    expect(where.AND).toContainEqual({
      OR: [...containsBranches("42"), { id: 42 }],
    });
  });

  it("keeps the OR group nested when the raw prefilter path is taken", () => {
    const where = buildWhere(query({ q: "42%", status: "todo" }), new Map([["42%", [7, 9]]]));

    expect(where.AND).toHaveLength(2);
    expect(where.AND).toContainEqual({ OR: [{ id: { in: [7, 9] } }] });
  });

  it("refuses to build a where for a wildcard q it was given no match set for", () => {
    // Falling back to `contains` here would hand user input straight to `LIKE`
    // as pattern syntax — the bug the raw path exists to fix, wearing the
    // costume of a missing argument.
    expect(() => buildWhere(query({ q: "50%" }))).toThrow(/matchedIds/);
  });

  it("ANDs every term in a multi-term query, one OR group per term", async () => {
    const both = await makeTask({
      title: "Pagination resets unexpectedly on every reload",
      description: "Filed against the list page.",
    });
    await makeTask({ title: "Pagination controls need alignment", description: "Cosmetic only." });
    await makeTask({
      title: "Cache resets after ten minutes",
      description: "Unrelated to paging.",
    });

    // Neither term alone narrows to just `both`: "pagination" also matches the
    // controls task, "resets" also matches the cache task. Only the task
    // carrying both terms survives an AND of the two.
    expect(await listIds({ q: "pagination resets" })).toEqual([both.id]);
  });

  it("treats a quoted phrase as one term", async () => {
    const task = await makeTask({ title: "The retry loop is broken", description: "Details" });
    await makeTask({ title: "The loop is a retry mechanism", description: "Different order" });

    expect(await listIds({ q: '"retry loop"' })).toEqual([task.id]);
  });

  it("matches a term that only appears in a comment", async () => {
    const task = await makeTask({ title: "Investigate slow queries" });
    await makeComment({ taskId: task.id, body: "Root cause turned out to be a missing index." });
    await makeTask({ title: "Unrelated task" });

    expect(await listIds({ q: "missing index" })).toEqual([task.id]);
  });

  it("matches a term that only appears in statusNote", async () => {
    const task = await makeTask({ status: "blocked", statusNote: "Waiting on the vendor API key" });
    await makeTask({ status: "blocked", statusNote: "Waiting on design review" });

    expect(await listIds({ q: "vendor" })).toEqual([task.id]);
  });

  it("matches a term that only appears in acceptanceCriteria", async () => {
    const task = await makeTask({ acceptanceCriteria: "Response time under 200ms p95" });
    await makeTask({ acceptanceCriteria: "Every field is validated" });

    expect(await listIds({ q: "200ms" })).toEqual([task.id]);
  });

  it("matches a term that only appears in a link URL", async () => {
    const task = await makeTask({
      links: [{ label: "PR", url: "https://example.com/org/repo/pull/909" }],
    });
    await makeTask({ links: [{ label: "PR", url: "https://example.com/org/repo/pull/1" }] });

    expect(await listIds({ q: "909" })).toEqual([task.id]);
  });

  it("finds a metacharacter term inside a comment via the raw prefilter path", async () => {
    const task = await makeTask({ title: "Discount rollout" });
    await makeComment({ taskId: task.id, body: "Applies a 50% discount at checkout." });
    await makeTask({ title: "Unrelated" });

    expect(await listIds({ q: "50%" })).toEqual([task.id]);
  });

  it("still narrows within the status filter with a multi-term q", async () => {
    const todo = await makeTask({ status: "todo", title: "Fix pagination bug" });
    const done = await makeTask({ status: "done", title: "Fix pagination bug" });

    const ids = await listIds({ q: "pagination bug", status: "todo" });

    expect(ids).toEqual([todo.id]);
    expect(ids).not.toContain(done.id);
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
    await makeTasks(3, () => ({ title: "Printer jam", description: "Tray two" }));

    expect(await listIds({ q: "%" })).toEqual([]);
  });

  it("treats % inside the term as a literal percent sign", async () => {
    const literal = await makeTask({ title: "Upload 50% done", description: "Stalled there" });
    await makeTask({ title: "500 errors on save", description: "Every request" });

    // As a wildcard, `50%` would match "500 errors" too.
    expect(await listIds({ q: "50%" })).toEqual([literal.id]);
  });

  it("treats _ as a literal underscore rather than a single-character wildcard", async () => {
    const literal = await makeTask({ title: "Code error_809", description: "Since Tuesday" });
    await makeTask({ title: "Code errorX809", description: "Unrelated" });

    expect(await listIds({ q: "error_809" })).toEqual([literal.id]);
  });

  it("matches the escape character itself literally", async () => {
    // `!` is the ESCAPE character, so a bare `!` in the pattern would be a
    // dangling escape — SQLite's behaviour there is not something to rely on.
    const bang = await makeTask({ title: "It broke!", description: "Again" });
    await makeTask({ title: "It broke", description: "Again" });

    expect(await listIds({ q: "broke!" })).toEqual([bang.id]);
  });

  it("still narrows within an active status filter when the term holds a wildcard", async () => {
    const todo = await makeTask({ status: "todo", title: "Upload 50% done" });
    const done = await makeTask({ status: "done", title: "Upload 50% done" });

    const ids = await listIds({ q: "50%", status: "todo" });

    expect(ids).toEqual([todo.id]);
    expect(ids).not.toContain(done.id);
  });

  /**
   * **The coupling test for `LIKE_ESCAPE_CHAR`.**
   *
   * SQLite will not accept a bind parameter after `ESCAPE`, so the literal in
   * `resolveTextSearch`'s SQL is a hand-maintained copy of the constant. This
   * asserts the copy is in step — and it asserts it against the *disagreement
   * itself* rather than against a helper's output: `escapeLikePattern` doubles
   * whatever `LIKE_ESCAPE_CHAR` says, the SQL declares whatever its literal
   * says, and only a round trip through the database can tell whether those two
   * are the same character.
   *
   * Change the constant to `#` without changing the SQL and this fails: the
   * pattern arrives as `%a#%b%` while SQLite still treats `!` as its escape
   * character, so `#` and `%` are both taken literally, the wildcard match
   * disappears, and the search silently returns nothing.
   */
  it("declares the same escape character in its SQL that escapeLikePattern emits", async () => {
    const literal = await makeTask({
      // Contains the escape character *and* a wildcard, so the pattern only
      // matches if the two sides agree on which one is which.
      title: `Payment ${LIKE_ESCAPE_CHAR}% surcharge`,
      description: "Nothing else",
    });
    const decoy = await makeTask({ title: "Payment XY surcharge", description: "Nothing else" });

    const term = `${LIKE_ESCAPE_CHAR}%`;
    expect(needsEscapedSearch(term), "the probe term must take the raw path").toBe(true);

    const matched = await resolveTextSearch(prisma, term);

    expect(matched).toContain(literal.id);
    expect(matched).not.toContain(decoy.id);
    // And the escaped form really is the doubled-then-escaped spelling, so a
    // pass above cannot come from escaping having been skipped altogether.
    expect(escapeLikePattern(term)).toBe(
      `${LIKE_ESCAPE_CHAR}${LIKE_ESCAPE_CHAR}${LIKE_ESCAPE_CHAR}%`,
    );
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

    expect(buildWhere(query({ q: "printer" })).AND).toEqual([{ OR: containsBranches("printer") }]);
    expect(buildWhere(query({ q: "50%" }), new Map([["50%", [4]]])).AND).toEqual([
      { OR: [{ id: { in: [4] } }] },
    ]);
  });

  it("returns the same rows on either path for a term escaping would not change", async () => {
    // The equivalence the fast path rests on, asserted rather than argued:
    // for a term with no `%`, `_`, or `!`, escaping is a no-op, so the raw
    // `LIKE … ESCAPE` and `contains` are the same query.
    const printer = await makeTask({ title: "Printer jam", description: "Tray two" });
    await makeTask({ title: "VPN drops", description: "Every morning" });
    await makeTask({ title: "Laptop", description: "Printer driver missing" });

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
  it("includes a task created on the createdTo day itself", async () => {
    // The off-by-one-day bound. A naive `lte: 2026-03-05T00:00:00Z` excludes
    // everything created that day, which reads as "the filter is off by one".
    const onTheDay = await makeTask({ createdAt: new Date("2026-03-05T13:45:00.000Z") });
    await makeTask({ createdAt: new Date("2026-03-06T00:00:00.000Z") });

    expect(await listIds({ createdTo: "2026-03-05" })).toEqual([onTheDay.id]);
  });

  it("includes a task created at the very start of the createdFrom day", async () => {
    const onTheDay = await makeTask({ createdAt: new Date("2026-03-05T00:00:00.000Z") });
    await makeTask({ createdAt: new Date("2026-03-04T23:59:59.999Z") });

    expect(await listIds({ createdFrom: "2026-03-05" })).toEqual([onTheDay.id]);
  });

  it("bounds both ends when a range is given", async () => {
    const inside = await makeTask({ createdAt: new Date("2026-03-05T09:00:00.000Z") });
    await makeTask({ createdAt: new Date("2026-03-03T09:00:00.000Z") });
    await makeTask({ createdAt: new Date("2026-03-08T09:00:00.000Z") });

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
    const low = await makeTask({ priority: "low" });
    const urgent = await makeTask({ priority: "urgent" });
    const medium = await makeTask({ priority: "medium" });
    const high = await makeTask({ priority: "high" });

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
    // Inserted in reverse-alphabetical order, so alphabetical, insertion, and
    // lifecycle order all differ.
    const deferred = await makeTask({ status: "deferred" });
    const todo = await makeTask({ status: "todo" });
    const needsQa = await makeTask({ status: "needs_qa" });
    const done = await makeTask({ status: "done" });
    const blocked = await makeTask({ status: "blocked" });
    const inProgress = await makeTask({ status: "in_progress" });
    const backlog = await makeTask({ status: "backlog" });

    expect(await listIds({ sort: "status:asc" })).toEqual([
      backlog.id,
      todo.id,
      inProgress.id,
      blocked.id,
      needsQa.id,
      done.id,
      deferred.id,
    ]);
  });

  it("keeps pages disjoint when the sort key is not unique", async () => {
    // Six rows tied on `status`. Without the `{ id: "desc" }` tiebreaker SQLite
    // is free to return them in storage order, which is ascending id — so the
    // expected sequence, not just the disjointness, is what pins the clause.
    const tasks = await makeTasks(6, () => ({ status: "todo" as const }));
    const ids = tasks.map((task) => task.id);

    const first = await listIds({ sort: "status:asc", page: "1", pageSize: "3" });
    const second = await listIds({ sort: "status:asc", page: "2", pageSize: "3" });

    expect(first).toEqual([...ids].reverse().slice(0, 3));
    expect(second).toEqual([...ids].reverse().slice(3));
    expect(first.filter((id) => second.includes(id))).toEqual([]);
    expect([...first, ...second].sort((a, b) => a - b)).toEqual(ids);
  });

  it("sorts by title alphabetically", async () => {
    const beta = await makeTask({ title: "Beta" });
    const alpha = await makeTask({ title: "Alpha" });

    expect(await listIds({ sort: "title:asc" })).toEqual([alpha.id, beta.id]);
  });

  it("sorts by completedAt, with SQLite's native null ordering: nulls first ascending, last descending", async () => {
    const open = await makeTask({ status: "todo" }); // completedAt: null
    const early = await makeTask({ status: "done", completedAt: new Date("2026-01-01T00:00:00Z") });
    const late = await makeTask({ status: "done", completedAt: new Date("2026-06-01T00:00:00Z") });

    // Ascending: every open (null) task sorts before the earliest completion.
    expect(await listIds({ sort: "completedAt:asc" })).toEqual([open.id, early.id, late.id]);
    // Descending: the archive's default — newest-completed first, open tasks last.
    expect(await listIds({ sort: "completedAt:desc" })).toEqual([late.id, early.id, open.id]);
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

/* ------------------------------------------------------------------ *
 * List rows — the summary fields
 *
 * Everything a row carries beyond its own columns comes from one `include`
 * batched across the page (`summaryInclude`). These pin that each derived
 * field is computed from the right rows, not merely present.
 * ------------------------------------------------------------------ */

describe("list rows", () => {
  const rowFor = async (id: number) => {
    const page = await listTasks(query({ pageSize: "100" }));
    const row = page.data.find((task) => task.id === id);
    if (row === undefined) throw new Error(`task ${id} not in the list`);
    return row;
  };

  it("counts only dependencies that are not done — a deferred blocker still counts", async () => {
    const task = await makeTask({ status: "blocked" });
    const done = await makeTask({ status: "done" });
    const deferred = await makeTask({ status: "deferred" });
    const inProgress = await makeTask({ status: "in_progress" });
    for (const dep of [done, deferred, inProgress]) await makeDependency(task.id, dep.id);

    expect((await rowFor(task.id)).openDependencyCount).toBe(2);
    expect((await rowFor(done.id)).openDependencyCount).toBe(0);
  });

  it("carries the open decision inline, and only the open one", async () => {
    const { task, decision } = await makeTaskAwaitingDecision();
    await makeDecision({ taskId: task.id, status: "withdrawn", question: "An older question?" });

    const row = await rowFor(task.id);

    expect(row.openDecision?.id).toBe(decision.id);
    expect(row.openDecision?.options.map((option) => option.label)).toEqual([
      "Keep the endpoint",
      "Remove the endpoint",
    ]);
    expect((await rowFor((await makeTask()).id)).openDecision).toBeNull();
  });

  it("shows a live claim and hides an expired one", async () => {
    const live = await makeTask(claimedBy("agent:alpha"));
    const expired = await makeTask(expiredClaimBy("agent:beta"));

    expect((await rowFor(live.id)).claim).toEqual({
      actor: "agent:alpha",
      expiresAt: live.claimExpiresAt!.toISOString(),
    });
    expect((await rowFor(expired.id)).claim).toBeNull();
  });

  it("reports the comment count without shipping the thread", async () => {
    const task = await makeTask();
    await makeComment({ taskId: task.id });
    await makeComment({ taskId: task.id });

    const row = await rowFor(task.id);

    expect(row.commentCount).toBe(2);
    expect("comments" in row).toBe(false);
  });

  it("carries labels sorted, and childCount for an epic", async () => {
    const task = await makeTask();
    await prisma.taskLabel.create({ data: { taskId: task.id, label: "web" } });
    await prisma.taskLabel.create({ data: { taskId: task.id, label: "api" } });
    await makeTask({ parentId: task.id });
    await makeTask({ parentId: task.id });

    const row = await rowFor(task.id);

    expect(row.labels).toEqual(["api", "web"]);
    expect(row.childCount).toBe(2);
    expect((await rowFor((await makeTask()).id)).labels).toEqual([]);
  });

  it("serializes every row through the summary contract", async () => {
    await makeTask({ links: [{ label: "PR", url: "https://example.com/pr/1" }], project: "web" });
    await makeTask(claimedBy("agent:alpha"));

    const page = await listTasks(query());

    for (const row of page.data) {
      const parsed = taskSummarySchema.safeParse(row);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  });
});
