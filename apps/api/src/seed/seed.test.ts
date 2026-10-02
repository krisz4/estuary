import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  actorKindOf,
  actorSchema,
  decisionOptionSchema,
  decisionRequestSchema,
  descriptionInputSchema,
  HUMAN_ATTENTION_STATUSES,
  COMMENT_KINDS,
  labelSchema,
  projectSchema,
  TASK_LABELS_MAX,
  TASK_PRIORITIES,
  TASK_STATUS_NOTE_MAX,
  TASK_STATUSES,
  taskLinksInputSchema,
  taskListQuerySchema,
  titleInputSchema,
  type TaskPriority,
  type TaskStatus,
} from "@estuary/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../lib/prisma.js";
import { listTasks } from "../services/task-query.js";
import { PRIORITY_RANK, STATUS_RANK } from "../services/task-status.js";
import {
  PROJECTS,
  PRNG_SEED,
  SEED_TASK_COUNT,
  SEED_WINDOW_DAYS,
  TASK_TEMPLATES,
} from "./seed-data.js";
import { buildSeedTasks, isSeedAllowed, seedDatabase, type SeedTask } from "./index.js";

/**
 * The seed, tested. Not *used* — no other suite reads seeded data, and that stays
 * true (`docs/engineering/TESTING.md`). This file runs the seed against the
 * worker's temp database.
 *
 * Most of what matters is asserted on the pure builder, **across several PRNG
 * seeds**: the statuses are authored, but every timestamp is drawn, and a
 * structural rule that only holds for the shipped seed value is luck, not a rule.
 * The database half then checks what only the database can: ids, ranks by
 * sorting, and that event payloads point at rows that exist.
 */

const NOW = new Date("2026-09-25T12:00:00.000Z");
const LEASE_MINUTES = 30;
const SEEDS = [1, 7, 99, 4242, PRNG_SEED];

const build = (seed: number = PRNG_SEED) =>
  buildSeedTasks(NOW, { seed, leaseMinutes: LEASE_MINUTES });

/** Every status the realised data must have, and how many — see Seed_Data.md. */
const EXPECTED_STATUS_COUNTS: Record<TaskStatus, number> = {
  backlog: 12,
  needs_refinement: 4,
  todo: 8,
  in_progress: 6,
  blocked: 4,
  needs_user_decision: 4,
  needs_user_action: 3,
  needs_qa: 5,
  done: 14,
  deferred: 2,
};

/** Statuses whose transition carries a required note that becomes `statusNote`. */
const NOTE_REQUIRED: readonly TaskStatus[] = [
  "needs_refinement",
  "blocked",
  "needs_user_decision",
  "needs_user_action",
  "needs_qa",
  "deferred",
];

/** Statuses that need acceptance criteria. */
const CRITERIA_REQUIRED: readonly TaskStatus[] = ["todo", "in_progress", "needs_qa", "done"];

/* ------------------------------------------------------------------ *
 * Generation — no database
 * ------------------------------------------------------------------ */

describe("buildSeedTasks", () => {
  const rows = build();

  it(`generates ${SEED_TASK_COUNT} tasks, one per template`, () => {
    expect(rows).toHaveLength(SEED_TASK_COUNT);
    expect(TASK_TEMPLATES).toHaveLength(SEED_TASK_COUNT);
    expect(new Set(rows.map((row) => row.task.title)).size).toBe(SEED_TASK_COUNT);
    expect(new Set(rows.map((row) => row.key)).size).toBe(SEED_TASK_COUNT);
  });

  it("is reproducible — the same `now` produces byte-identical output", () => {
    expect(JSON.stringify(build())).toEqual(JSON.stringify(build()));
  });

  it("depends on the PRNG seed, so 'reproducible' is not 'constant'", () => {
    expect(JSON.stringify(build(PRNG_SEED + 1))).not.toEqual(JSON.stringify(build()));
  });

  it("hands out task numbers in chronological order", () => {
    const times = rows.map((row) => row.task.createdAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it(`spreads createdAt across ${SEED_WINDOW_DAYS} days rather than clustering at now`, () => {
    const ages = rows.map((row) => (NOW.getTime() - row.task.createdAt.getTime()) / 86_400_000);

    expect(Math.min(...ages)).toBeGreaterThan(0);
    expect(Math.max(...ages)).toBeLessThanOrEqual(SEED_WINDOW_DAYS);
    expect(Math.max(...ages) - Math.min(...ages)).toBeGreaterThan(SEED_WINDOW_DAYS * 0.8);
  });

  it("covers every status, in the distribution Seed_Data.md documents", () => {
    const counts = countBy(rows.map((row) => row.task.status));

    for (const status of TASK_STATUSES) expect(counts[status], status).toBeGreaterThan(0);
    expect(counts).toEqual(EXPECTED_STATUS_COUNTS);
  });

  it("uses every priority, weighted toward the middle", () => {
    const counts = countBy(rows.map((row) => row.task.priority));

    for (const priority of TASK_PRIORITIES) expect(counts[priority], priority).toBeGreaterThan(0);
    expect(counts.urgent).toBeLessThan(counts.medium);
  });

  it("spans three projects plus a couple of unfiled tasks", () => {
    const counts = countBy(rows.map((row) => row.task.project ?? "(none)"));

    for (const project of PROJECTS) expect(counts[project], project).toBeGreaterThanOrEqual(15);
    expect(counts["(none)"]).toBeGreaterThanOrEqual(1);
  });

  it("mixes agent- and human-created tasks from several actors", () => {
    const creators = new Set(rows.map((row) => row.task.createdBy));
    const agents = [...creators].filter((actor) => actorKindOf(actor) === "agent");
    const humans = [...creators].filter((actor) => actorKindOf(actor) === "human");

    expect(agents.length).toBeGreaterThanOrEqual(3);
    expect(humans.length).toBeGreaterThanOrEqual(3);
  });

  it("uses all three comment kinds", () => {
    const kinds = new Set(rows.flatMap((row) => row.comments.map((comment) => comment.kind)));
    expect([...kinds].sort()).toEqual([...COMMENT_KINDS].sort());
  });

  it("labels a realistic slice of tasks with workspace and kind tags", () => {
    const labeled = rows.filter((row) => row.labels.length > 0);
    const allLabels = new Set(rows.flatMap((row) => row.labels));

    expect(labeled.length).toBeGreaterThanOrEqual(20);
    // Workspace labels (this repo's own shape) and kind labels both show up.
    for (const label of ["mcp", "api", "web", "docs", "db", "bug", "perf", "flaky-test"]) {
      expect(allLabels.has(label), label).toBe(true);
    }
  });

  it("claims exactly the in_progress tasks, with two lapsed leases to recover", () => {
    const inProgress = rows.filter((row) => row.task.status === "in_progress");
    const expired = inProgress.filter((row) => row.task.claimExpiresAt! <= NOW);

    expect(inProgress.length).toBeGreaterThan(0);
    expect(expired).toHaveLength(2);
    expect(inProgress.length - expired.length).toBeGreaterThanOrEqual(3);
  });

  it("has answered decisions on tasks that have since moved on", () => {
    const answered = rows.filter((row) => row.decisions.some((d) => d.status === "answered"));

    expect(answered.length).toBeGreaterThanOrEqual(2);
    for (const row of answered) expect(row.task.status).not.toBe("needs_user_decision");
  });

  it("has parent/child subtasks", () => {
    const parents = new Set(rows.flatMap((row) => (row.parentKey ? [row.parentKey] : [])));
    expect(parents.size).toBeGreaterThanOrEqual(2);
  });

  it("has a todo task whose dependencies are all done", () => {
    const statusOf = statusByKey(rows);
    const ready = rows.filter(
      (row) =>
        row.task.status === "todo" &&
        row.dependencies.length > 0 &&
        row.dependencies.every((dep) => statusOf.get(dep.dependsOn) === "done"),
    );
    expect(ready.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * The reason `getTask` orders comments by `[createdAt asc, id asc]`. Without
   * a collision in the data, dropping that `id` tiebreaker would break nothing
   * visible and the regression would ship — see `docs/features/Comments.md`.
   */
  it("puts several comments in the same millisecond on purpose", () => {
    const colliding = rows.filter((row) => {
      const times = row.comments.map((comment) => comment.createdAt.getTime());
      return new Set(times).size !== times.length;
    });
    expect(colliding.length).toBeGreaterThanOrEqual(3);
  });

  /* -------------------- invariants, across seeds -------------------- */

  describe.each(SEEDS)("with PRNG seed %i", (seed) => {
    const data = build(seed);
    const statusOf = statusByKey(data);

    it("passes the contract's own field validation", () => {
      for (const { task, comments, decisions, events, labels } of data) {
        titleInputSchema.parse(task.title);
        descriptionInputSchema.parse(task.description);
        if (task.project !== null) expect(projectSchema.parse(task.project)).toBe(task.project);
        expect(taskLinksInputSchema.parse(JSON.parse(task.links))).toEqual(JSON.parse(task.links));
        if (task.statusNote !== null) {
          expect(task.statusNote.length).toBeLessThanOrEqual(TASK_STATUS_NOTE_MAX);
        }

        // Labels: valid slugs, within the cap, deduped and sorted (labelsInputSchema's shape).
        expect(labels.length).toBeLessThanOrEqual(TASK_LABELS_MAX);
        for (const label of labels) expect(labelSchema.parse(label)).toBe(label);
        expect([...new Set(labels)].sort()).toEqual(labels);

        // Every event carries the task's project as recorded at the time.
        for (const event of events) expect(event.project, task.title).toBe(task.project);

        // Actors are stored canonical: lowercase `kind:name`, exactly what the
        // `X-Actor` parser would have produced.
        const actors = [
          task.createdBy,
          ...(task.claimedBy ? [task.claimedBy] : []),
          ...comments.map((comment) => comment.author),
          ...decisions.flatMap((d) => [d.requestedBy, ...(d.answeredBy ? [d.answeredBy] : [])]),
          ...events.map((event) => event.actor),
        ];
        for (const actor of actors) expect(actorSchema.parse(actor)).toBe(actor);
      }
    });

    it("keeps claims on in_progress tasks only", () => {
      for (const { key, task } of data) {
        if (task.status === "in_progress") {
          expect(task.claimedBy, key).not.toBeNull();
          expect(task.claimExpiresAt, key).not.toBeNull();
        } else {
          expect(task.claimedBy, key).toBeNull();
          expect(task.claimExpiresAt, key).toBeNull();
        }
      }
    });

    it("sets the status note, acceptance criteria, and links each status needs", () => {
      for (const { key, task } of data) {
        if (NOTE_REQUIRED.includes(task.status)) expect(task.statusNote, key).toBeTruthy();
        if (CRITERIA_REQUIRED.includes(task.status)) {
          expect(task.acceptanceCriteria, key).toBeTruthy();
        }
        if (task.status === "needs_qa" || task.status === "done") {
          expect(JSON.parse(task.links).length, key).toBeGreaterThan(0);
        }
      }
    });

    it("orders lifecycle timestamps the way the workflow service writes them", () => {
      for (const { key, task, comments } of data) {
        const created = task.createdAt.getTime();

        expect(created, key).toBeLessThan(NOW.getTime());
        expect(task.updatedAt.getTime(), key).toBeGreaterThanOrEqual(created);
        expect(task.updatedAt.getTime(), key).toBeLessThanOrEqual(NOW.getTime());

        // `completedAt` iff done; `startedAt` never cleared once set.
        expect(task.completedAt !== null, key).toBe(task.status === "done");
        if (
          ["in_progress", "blocked", "needs_user_action", "needs_qa", "done"].includes(task.status)
        ) {
          expect(task.startedAt, key).not.toBeNull();
        }
        if (["backlog", "needs_refinement", "deferred"].includes(task.status)) {
          expect(task.startedAt, key).toBeNull();
        }
        if (task.startedAt !== null) {
          expect(task.startedAt.getTime(), key).toBeGreaterThan(created);
        }
        if (task.completedAt !== null) {
          expect(task.completedAt.getTime(), key).toBeGreaterThan(task.startedAt!.getTime());
          expect(task.completedAt.getTime(), key).toBeLessThanOrEqual(task.updatedAt.getTime());
        }

        for (const comment of comments) {
          expect(comment.createdAt.getTime(), key).toBeGreaterThan(created);
          expect(comment.createdAt.getTime(), key).toBeLessThanOrEqual(NOW.getTime());
        }
      }
    });

    it("gives unique idempotency keys to agent-created tasks and none to humans'", () => {
      const keys = data.map((row) => row.task.idempotencyKey);

      for (const { key, task } of data) {
        expect(task.idempotencyKey !== null, key).toBe(actorKindOf(task.createdBy) === "agent");
      }
      const present = keys.filter((value) => value !== null);
      expect(new Set(present).size).toBe(present.length);
    });

    it("has exactly one open, well-formed decision per needs_user_decision task", () => {
      for (const { key, task, decisions } of data) {
        const open = decisions.filter((decision) => decision.status === "open");

        if (task.status !== "needs_user_decision") {
          expect(open, key).toHaveLength(0);
          continue;
        }

        expect(open, key).toHaveLength(1);
        const [decision] = open;
        const options = decisionOptionSchema.array().parse(JSON.parse(decision!.options));
        expect(options.length, key).toBeGreaterThanOrEqual(2);
        expect(options.length, key).toBeLessThanOrEqual(4);
        expect(decision!.context, key).toBeTruthy();
        // Same validation a `→ needs_user_decision` transition runs, including
        // "recommendedOption must be one of the labels".
        decisionRequestSchema.parse({
          question: decision!.question,
          options,
          recommendedOption: decision!.recommendedOption ?? undefined,
          context: decision!.context ?? undefined,
        });
        expect(
          options.map((o) => o.label),
          key,
        ).toContain(decision!.recommendedOption);
        // A decision's status note is its question (`statusNoteFor`).
        expect(task.statusNote, key).toBe(decision!.question);
      }
    });

    it("answers decisions with one of their options, as a human, after asking", () => {
      for (const { key, decisions } of data) {
        for (const decision of decisions.filter((d) => d.status === "answered")) {
          const labels = (JSON.parse(decision.options) as { label: string }[]).map((o) => o.label);
          if (decision.choice !== null) expect(labels, key).toContain(decision.choice);
          expect(actorKindOf(decision.answeredBy!), key).toBe("human");
          expect(decision.answeredAt!.getTime(), key).toBeGreaterThan(decision.createdAt.getTime());
        }
      }
    });

    it("points parents and dependencies at older tasks, with no cycles", () => {
      const position = new Map(data.map((row, n) => [row.key, n]));

      data.forEach((row, n) => {
        if (row.parentKey !== null) expect(position.get(row.parentKey)!, row.key).toBeLessThan(n);
        for (const dep of row.dependencies) {
          expect(dep.dependsOn, row.key).not.toBe(row.key);
          expect(position.has(dep.dependsOn), row.key).toBe(true);
        }
      });

      expect(
        findCycle(data.map((row) => [row.key, row.dependencies.map((d) => d.dependsOn)])),
      ).toBeNull();
    });

    /**
     * A `blocked` task whose blockers were all `done` would have been moved to
     * `todo` by auto-unblock, so the seed must never contain one.
     */
    it("blocks every blocked task on at least one unfinished task", () => {
      for (const { key, task, dependencies } of data.filter((r) => r.task.status === "blocked")) {
        expect(dependencies.length, key).toBeGreaterThan(0);
        expect(
          dependencies.some((dep) => statusOf.get(dep.dependsOn) !== "done"),
          `${key} (${task.status})`,
        ).toBe(true);
      }
    });

    it("records an event trail that replays to each task's current state", () => {
      for (const { key, task, comments, decisions, events } of data) {
        const [first, ...rest] = events;

        // Filed first…
        expect(first?.type, key).toBe("task.created");
        expect(first?.createdAt.getTime(), key).toBe(task.createdAt.getTime());
        expect(first?.payload.title, key).toBe(task.title);
        expect(
          rest.some((event) => event.type === "task.created"),
          key,
        ).toBe(false);

        // …in time order…
        const times = events.map((event) => event.createdAt.getTime());
        expect(
          [...times].sort((a, b) => a - b),
          key,
        ).toEqual(times);

        // …and the status changes chain from the creation status to the current one.
        let status = first?.payload.status as TaskStatus;
        let note: unknown = null;
        const changes = events.filter((event) => event.type === "task.status_changed");
        for (const change of changes) {
          expect(change.payload.from, key).toBe(status);
          status = change.payload.to as TaskStatus;
          note = change.payload.note;
        }
        expect(status, key).toBe(task.status);
        expect(note, key).toBe(task.statusNote);

        // One `version` bump per write: at least one per status change, and a
        // task that never changed is still at 1.
        expect(task.version, key).toBeGreaterThanOrEqual(1 + changes.length);

        // Every comment and decision announced itself.
        expect(
          events.filter((e) => e.type === "comment.created"),
          key,
        ).toHaveLength(comments.length);
        expect(
          events.filter((e) => e.type === "decision.requested"),
          key,
        ).toHaveLength(decisions.length);
        expect(
          events.filter((e) => e.type === "decision.answered"),
          key,
        ).toHaveLength(decisions.filter((d) => d.status === "answered").length);

        // A claim event accompanies every move into in_progress.
        const claims = events.filter((e) => e.type === "task.claimed").length;
        expect(claims, key).toBe(changes.filter((c) => c.payload.to === "in_progress").length);
      }
    });
  });
});

describe("isSeedAllowed", () => {
  it("permits seeding outside production without any flag", () => {
    expect(isSeedAllowed("development", false)).toBe(true);
    expect(isSeedAllowed("test", false)).toBe(true);
  });

  it("refuses production unless ALLOW_SEED says otherwise", () => {
    expect(isSeedAllowed("production", false)).toBe(false);
    expect(isSeedAllowed("production", true)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * The seed writes ranks through the helper
 * ------------------------------------------------------------------ */

describe("the seed never writes a rank column itself", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");

  /** Comments describe the rule; only code should be searched for violations. */
  const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "");

  it("routes its task writes through applyTaskRanks", () => {
    expect(code).toMatch(/applyTaskRanks\(/);
  });

  /**
   * The sorting tests below catch a seed that skips the helper and leaves the
   * column defaults. They do **not** catch a seed that computes the ranks
   * itself and happens to get them right — which reads as correct until someone
   * changes `TASK_STATUSES` and only one of the two copies moves.
   */
  it("mentions neither statusRank nor priorityRank outside a comment", () => {
    expect(code).not.toMatch(/\bstatusRank\b/);
    expect(code).not.toMatch(/\bpriorityRank\b/);
  });
});

/* ------------------------------------------------------------------ *
 * Against the database
 * ------------------------------------------------------------------ */

describe("seedDatabase", () => {
  const expected = build();
  const sum = (pick: (row: SeedTask) => unknown[]) =>
    expected.reduce((total, row) => total + pick(row).length, 0);

  beforeEach(async () => {
    await seedDatabase({ now: NOW });
  });

  it(`writes ${SEED_TASK_COUNT} tasks and everything hanging off them`, async () => {
    expect(await prisma.task.count()).toBe(SEED_TASK_COUNT);
    expect(await prisma.comment.count()).toBe(sum((row) => row.comments));
    expect(await prisma.decision.count()).toBe(sum((row) => row.decisions));
    expect(await prisma.taskDependency.count()).toBe(sum((row) => row.dependencies));
    expect(await prisma.taskEvent.count()).toBe(sum((row) => row.events));
    expect(await prisma.taskLabel.count()).toBe(sum((row) => row.labels));
  });

  it("stores every event's project exactly as its task's, and every label on its task", async () => {
    const tasks = await prisma.task.findMany({ select: { id: true, title: true, project: true } });
    const projectById = new Map(tasks.map((task) => [task.id, task.project]));
    const idByTitle = new Map(tasks.map((task) => [task.title, task.id]));

    const events = await prisma.taskEvent.findMany({ select: { taskId: true, project: true } });
    for (const event of events) expect(event.project).toBe(projectById.get(event.taskId));

    const labelRows = await prisma.taskLabel.findMany();
    expect(labelRows.length).toBe(sum((row) => row.labels));

    const labelsByTaskId = new Map<number, string[]>();
    for (const { taskId, label } of labelRows) {
      labelsByTaskId.set(taskId, [...(labelsByTaskId.get(taskId) ?? []), label]);
    }
    for (const row of expected) {
      const id = idByTitle.get(row.task.title)!;
      expect([...(labelsByTaskId.get(id) ?? [])].sort()).toEqual(row.labels);
    }
  });

  it("leaves ids to autoincrement, starting at 1, in creation order", async () => {
    const tasks = await prisma.task.findMany({ orderBy: { id: "asc" } });

    expect(tasks[0]?.id).toBe(1);
    expect(tasks.at(-1)?.id).toBe(SEED_TASK_COUNT);
    const times = tasks.map((task) => task.createdAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("is idempotent — re-seeding replaces rather than appends, and reuses the ids", async () => {
    const before = await prisma.task.findMany({ orderBy: { id: "asc" } });
    const counts = await tableCounts();

    await seedDatabase({ now: NOW });

    const after = await prisma.task.findMany({ orderBy: { id: "asc" } });
    expect(after.map((row) => [row.id, row.title])).toEqual(
      before.map((row) => [row.id, row.title]),
    );
    expect(await tableCounts()).toEqual(counts);
    expect((await prisma.taskEvent.findFirst({ orderBy: { id: "asc" } }))?.id).toBe(1);
  });

  /**
   * **The rank invariant, asserted by sorting.** Ordering by `statusRank` must
   * produce the same sequence as ordering by the contract enum's index — which
   * is only true if the column agrees with the string beside it.
   */
  it("orders by statusRank exactly as the lifecycle enum orders", async () => {
    const rows = await prisma.task.findMany({
      orderBy: [{ statusRank: "asc" }, { id: "asc" }],
      select: { id: true, status: true },
    });

    const sorted = [...rows].sort(
      (a, b) =>
        STATUS_RANK[a.status as TaskStatus] - STATUS_RANK[b.status as TaskStatus] || a.id - b.id,
    );

    expect(rows.map((row) => row.id)).toEqual(sorted.map((row) => row.id));
    expect(new Set(rows.map((row) => row.status)).size).toBe(TASK_STATUSES.length);
  });

  it("orders by priorityRank exactly as the severity enum orders", async () => {
    const rows = await prisma.task.findMany({
      orderBy: [{ priorityRank: "desc" }, { id: "desc" }],
      select: { id: true, priority: true },
    });

    const sorted = [...rows].sort(
      (a, b) =>
        PRIORITY_RANK[b.priority as TaskPriority] - PRIORITY_RANK[a.priority as TaskPriority] ||
        b.id - a.id,
    );

    expect(rows.map((row) => row.id)).toEqual(sorted.map((row) => row.id));
    expect(rows[0]?.priority).toBe("urgent");
  });

  /**
   * The list query pushes the rank predicate as well as the text one, so a
   * rank-drifted row matches **no** status filter: it vanishes from every
   * filtered page and from `meta.total`. Summing the filtered totals back to
   * the task count proves no seeded task is unreachable.
   */
  it("leaves every seeded task reachable through a status filter", async () => {
    let total = 0;
    // Sequential on purpose: `listTasks` runs an interactive transaction, and
    // ten of those at once queue on SQLite long enough to hit the test timeout.
    for (const status of TASK_STATUSES) {
      total += (await listTasks(parseListQuery({ status: [status] }))).meta.total;
    }
    expect(total).toBe(SEED_TASK_COUNT);
  });

  it("leaves every seeded task reachable through a priority filter", async () => {
    let total = 0;
    for (const priority of TASK_PRIORITIES) {
      total += (await listTasks(parseListQuery({ priority: [priority] }))).meta.total;
    }
    expect(total).toBe(SEED_TASK_COUNT);
  });

  it("pages: three full pages and a fourth at the default page size", async () => {
    const first = await listTasks(parseListQuery({}));

    expect(first.data).toHaveLength(20);
    expect(first.meta.total).toBe(SEED_TASK_COUNT);
    expect(first.meta.totalPages).toBe(4);
  });

  it("gives assigneeIsNull=true and the facets something to return", async () => {
    const unassigned = await prisma.task.count({ where: { assignee: null } });
    const assignees = await prisma.task.groupBy({
      by: ["assignee"],
      where: { assignee: { not: null } },
    });

    expect(unassigned).toBeGreaterThan(10);
    expect(assignees.length).toBeGreaterThanOrEqual(5);
  });

  it("fills the inbox: every human-attention status has tasks", async () => {
    const count = await prisma.task.count({
      where: { status: { in: [...HUMAN_ATTENTION_STATUSES] } },
    });
    expect(count).toBeGreaterThanOrEqual(HUMAN_ATTENTION_STATUSES.length * 3);
  });

  it("stores one open decision per needs_user_decision task, and none elsewhere", async () => {
    const open = await prisma.decision.findMany({
      where: { status: "open" },
      include: { task: { select: { status: true } } },
    });
    const waiting = await prisma.task.count({ where: { status: "needs_user_decision" } });

    expect(open).toHaveLength(waiting);
    expect(new Set(open.map((decision) => decision.taskId)).size).toBe(waiting);
    for (const decision of open) expect(decision.task.status).toBe("needs_user_decision");
  });

  it("stores an acyclic dependency graph", async () => {
    const edges = await prisma.taskDependency.findMany();
    const graph = new Map<string, string[]>();
    for (const edge of edges) {
      const list = graph.get(String(edge.taskId)) ?? [];
      list.push(String(edge.dependsOnId));
      graph.set(String(edge.taskId), list);
    }
    expect(findCycle([...graph.entries()])).toBeNull();
  });

  /**
   * An events poller reads `after=<id>`, so ids must follow time across the
   * whole table — not just within a task.
   */
  it("assigns event ids in chronological order, with a task.created per task", async () => {
    const events = await prisma.taskEvent.findMany({ orderBy: { id: "asc" } });
    const times = events.map((event) => event.createdAt.getTime());

    expect([...times].sort((a, b) => a - b)).toEqual(times);

    const created = events.filter((event) => event.type === "task.created");
    expect(created).toHaveLength(SEED_TASK_COUNT);
    expect(new Set(created.map((event) => event.taskId)).size).toBe(SEED_TASK_COUNT);
  });

  it("assigns comment and decision ids in chronological order", async () => {
    for (const rows of [
      await prisma.comment.findMany({ orderBy: { id: "asc" } }),
      await prisma.decision.findMany({ orderBy: { id: "asc" } }),
    ]) {
      const times = rows.map((row) => row.createdAt.getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    }
  });

  it("resolves every id inside an event payload to a row of the same task", async () => {
    const events = await prisma.taskEvent.findMany();
    const comments = new Map((await prisma.comment.findMany()).map((c) => [c.id, c]));
    const decisions = new Map((await prisma.decision.findMany()).map((d) => [d.id, d]));
    const edges = new Set(
      (await prisma.taskDependency.findMany()).map((e) => `${e.taskId}>${e.dependsOnId}`),
    );

    for (const event of events) {
      const payload = JSON.parse(event.payload) as Record<string, unknown>;

      if (event.type === "comment.created") {
        const comment = comments.get(payload.commentId as number);
        expect(comment?.taskId).toBe(event.taskId);
        expect(comment?.kind).toBe(payload.kind);
      }
      if (event.type.startsWith("decision.")) {
        expect(decisions.get(payload.decisionId as number)?.taskId).toBe(event.taskId);
      }
      if (event.type === "dependency.added") {
        expect(edges.has(`${event.taskId}>${payload.dependsOnId as number}`)).toBe(true);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const countBy = <T extends string>(values: T[]): Record<T, number> =>
  values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {}) as Record<T, number>;

const statusByKey = (rows: SeedTask[]) => new Map(rows.map((row) => [row.key, row.task.status]));

/** Depth-first search for a back edge. Returns one cycle's path, or `null`. */
function findCycle(adjacency: [string, string[]][]): string[] | null {
  const graph = new Map(adjacency);
  const state = new Map<string, "visiting" | "done">();

  const visit = (node: string, path: string[]): string[] | null => {
    if (state.get(node) === "done") return null;
    if (state.get(node) === "visiting") return [...path, node];
    state.set(node, "visiting");
    for (const next of graph.get(node) ?? []) {
      const cycle = visit(next, [...path, node]);
      if (cycle) return cycle;
    }
    state.set(node, "done");
    return null;
  };

  for (const node of graph.keys()) {
    const cycle = visit(node, []);
    if (cycle) return cycle;
  }
  return null;
}

async function tableCounts() {
  return {
    tasks: await prisma.task.count(),
    comments: await prisma.comment.count(),
    decisions: await prisma.decision.count(),
    dependencies: await prisma.taskDependency.count(),
    events: await prisma.taskEvent.count(),
  };
}

/**
 * The list service takes an already-validated query, so tests build one through
 * the real schema rather than casting a partial object into place.
 */
function parseListQuery(input: Record<string, unknown>) {
  return taskListQuerySchema.parse(input);
}
