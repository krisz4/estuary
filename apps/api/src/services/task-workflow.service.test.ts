import {
  answerDecisionInputSchema,
  nextTaskInputSchema,
  releaseTaskInputSchema,
  SYSTEM_ACTOR,
  transitionInputSchema,
  type TransitionInputRaw,
} from "@estuary/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { env } from "../lib/env.js";
import { ApiError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import {
  claimedBy,
  eventsFor,
  expireClaim,
  expiredClaimBy,
  makeDecision,
  makeDependency,
  makeTask,
  makeTaskAwaitingDecision,
  makeTasks,
} from "../test/factories.js";
import { deleteTask, getTask } from "./task.service.js";
import {
  addDependency,
  answerDecision,
  claimTask,
  heartbeatTask,
  nextTask,
  releaseTask,
  removeDependency,
  transitionTask,
} from "./task-workflow.service.js";

/**
 * The agent-facing workflow against a real (temp) SQLite file:
 * `docs/features/Task_Workflow_API.md` § Rules that cut across endpoints, and
 * `docs/features/Task_Status_Lifecycle.md`.
 *
 * Inputs go through the contract schemas exactly as the route parses them;
 * what a payload *requires* (a reason, a question) is the schema's job and is
 * asserted per field in `tasks.workflow.route.test.ts`. What is asserted here is
 * everything that needs the stored row: versions, claims, the acceptance
 * criteria gate, dependency integrity, decisions, and auto-unblocking.
 */

const HUMAN = "human:krisz";
const AGENT = "agent:claude-code";
const OTHER_AGENT = "agent:codex";

const transition = (id: number, raw: TransitionInputRaw, actor = HUMAN) =>
  transitionTask(id, transitionInputSchema.parse(raw), actor);

const answer = (id: number, raw: Record<string, unknown>, actor = HUMAN) =>
  answerDecision(id, answerDecisionInputSchema.parse(raw), actor);

const next = (actor: string, raw: Record<string, unknown> = {}) =>
  nextTask(nextTaskInputSchema.parse(raw), actor);

const release = (id: number, actor: string, raw: Record<string, unknown> = {}) =>
  releaseTask(id, releaseTaskInputSchema.parse(raw), actor);

const row = (id: number) => prisma.task.findUniqueOrThrow({ where: { id } });

const expectApiError = async (
  run: () => Promise<unknown>,
  code: string,
  status: number,
): Promise<ApiError> => {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ApiError);
  const error = thrown as ApiError;
  expect(error.code).toBe(code);
  expect(error.status).toBe(status);
  return error;
};

const DECISION = {
  question: "Should the v1 endpoint stay for a release?",
  options: [{ label: "Keep it" }, { label: "Remove it", description: "Clients migrated already" }],
  recommendedOption: "Remove it",
  context: "Two clients still call it according to the logs.",
};

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * Transitions
 * ------------------------------------------------------------------ */

describe("transitionTask", () => {
  const VALID: [string, TransitionInputRaw, string | null][] = [
    ["backlog", { to: "backlog" }, null],
    ["needs_refinement", { to: "needs_refinement", reason: "Which endpoint?" }, "Which endpoint?"],
    ["todo", { to: "todo" }, null],
    ["in_progress", { to: "in_progress" }, null],
    ["blocked", { to: "blocked", reason: "Waiting on infra" }, "Waiting on infra"],
    ["needs_user_decision", { to: "needs_user_decision", decision: DECISION }, DECISION.question],
    [
      "needs_user_action",
      { to: "needs_user_action", instructions: "Add the secret in Vault" },
      "Add the secret in Vault",
    ],
    ["needs_qa", { to: "needs_qa", summary: "Retries added" }, "Retries added"],
    ["done", { to: "done" }, null],
    ["deferred", { to: "deferred", reason: "Not this quarter" }, "Not this quarter"],
  ];

  it.each(VALID)("moves a task to %s with a valid payload", async (to, raw, note) => {
    const task = await makeTask({ status: "needs_refinement" });

    const moved = await transition(task.id, raw);

    expect(moved.status).toBe(to);
    expect(moved.statusNote).toBe(note);
    expect(moved.version).toBe(2);
  });

  it("records a task.status_changed event with from, to, and note", async () => {
    const task = await makeTask({ status: "todo" });

    await transition(task.id, { to: "blocked", reason: "Waiting on infra" }, AGENT);

    expect(await eventsFor(task.id)).toEqual([
      {
        type: "task.status_changed",
        actor: AGENT,
        payload: { from: "todo", to: "blocked", note: "Waiting on infra" },
      },
    ]);
  });

  it("keeps the status rank in lifecycle order — asserted by sorting", async () => {
    const [a, b, c] = await makeTasks(3, () => ({ status: "backlog" }));
    await transition(a!.id, { to: "deferred", reason: "Parked for now" });
    await transition(c!.id, { to: "in_progress" });

    const ordered = await prisma.task.findMany({ orderBy: { statusRank: "asc" } });

    expect(ordered.map((task) => task.id)).toEqual([b!.id, c!.id, a!.id]);
  });

  it("allows a same-status transition, which replaces the note", async () => {
    const task = await makeTask({ status: "blocked", statusNote: "Waiting on infra" });

    const moved = await transition(task.id, { to: "blocked", reason: "Infra said Friday" });

    expect(moved.statusNote).toBe("Infra said Friday");
    expect(moved.version).toBe(2);
  });

  it("replaces the status note on every transition — the old reason does not linger", async () => {
    const task = await makeTask({ status: "blocked", statusNote: "Waiting on infra" });

    const moved = await transition(task.id, { to: "todo" });

    expect(moved.statusNote).toBeNull();
  });

  it("throws TASK_NOT_FOUND for an unknown id", async () => {
    await expectApiError(() => transition(999, { to: "todo" }), "TASK_NOT_FOUND", 404);
  });

  describe("the todo gate", () => {
    it("passes on stored acceptance criteria", async () => {
      const task = await makeTask({ status: "needs_refinement", acceptanceCriteria: "It retries" });

      expect((await transition(task.id, { to: "todo" })).status).toBe("todo");
    });

    it("fails on the acceptanceCriteria field when none are stored or supplied, writing nothing", async () => {
      const task = await makeTask({ status: "needs_refinement", acceptanceCriteria: null });

      const error = await expectApiError(
        () => transition(task.id, { to: "todo" }),
        "VALIDATION_ERROR",
        422,
      );

      expect(Object.keys(error.details as object)).toEqual(["acceptanceCriteria"]);
      expect((await row(task.id)).status).toBe("needs_refinement");
      expect(await eventsFor(task.id)).toEqual([]);
    });

    it("passes on supplied criteria and saves them in the same write", async () => {
      const task = await makeTask({ status: "needs_refinement", acceptanceCriteria: null });

      const moved = await transition(task.id, {
        to: "todo",
        acceptanceCriteria: "Retries 3x with backoff",
      });

      expect(moved.status).toBe("todo");
      expect(moved.acceptanceCriteria).toBe("Retries 3x with backoff");
    });

    it("fails when the payload clears stored criteria with an empty string", async () => {
      const task = await makeTask({ status: "needs_refinement", acceptanceCriteria: "It retries" });

      await expectApiError(
        () => transition(task.id, { to: "todo", acceptanceCriteria: "" }),
        "VALIDATION_ERROR",
        422,
      );
    });
  });

  describe("timestamps", () => {
    it("stamps startedAt the first time only", async () => {
      const task = await makeTask({ status: "todo" });

      const first = await transition(task.id, { to: "in_progress" });
      await transition(task.id, { to: "todo" });
      const second = await transition(task.id, { to: "in_progress" });

      expect(first.startedAt).not.toBeNull();
      expect(second.startedAt).toBe(first.startedAt);
    });

    it("sets completedAt on done and clears it on reopening", async () => {
      const task = await makeTask({ status: "needs_qa" });

      const done = await transition(task.id, { to: "done" });
      const reopened = await transition(task.id, { to: "todo" });

      expect(done.completedAt).not.toBeNull();
      expect(reopened.completedAt).toBeNull();
    });
  });

  describe("claims", () => {
    it("takes a claim for the caller on in_progress, with a lease of CLAIM_LEASE_MINUTES", async () => {
      const task = await makeTask({ status: "todo" });
      const before = Date.now();

      const moved = await transition(task.id, { to: "in_progress" }, AGENT);

      expect(moved.claim?.actor).toBe(AGENT);
      const leaseMs = new Date(moved.claim!.expiresAt).getTime() - before;
      expect(leaseMs).toBeGreaterThanOrEqual(env.CLAIM_LEASE_MINUTES * 60_000 - 1000);
      expect(leaseMs).toBeLessThanOrEqual(env.CLAIM_LEASE_MINUTES * 60_000 + 5000);
      expect((await eventsFor(task.id)).map((event) => event.type)).toEqual([
        "task.status_changed",
        "task.claimed",
      ]);
    });

    it("drops the claim on leaving in_progress", async () => {
      const task = await makeTask(claimedBy(AGENT));

      const moved = await transition(
        task.id,
        { to: "needs_qa", summary: "Done, please check" },
        AGENT,
      );

      expect(moved.claim).toBeNull();
      const stored = await row(task.id);
      expect(stored.claimedBy).toBeNull();
      expect(stored.claimExpiresAt).toBeNull();
    });

    it("refuses another agent while the claim is live", async () => {
      const task = await makeTask(claimedBy(AGENT));

      const error = await expectApiError(
        () => transition(task.id, { to: "blocked", reason: "Mine now" }, OTHER_AGENT),
        "TASK_ALREADY_CLAIMED",
        409,
      );
      expect(error.details).toMatchObject({ claimedBy: AGENT });
    });

    it("lets a human move a claimed task away from in_progress, which drops the agent's claim", async () => {
      const task = await makeTask(claimedBy(AGENT));

      const moved = await transition(task.id, { to: "todo" }, HUMAN);

      expect(moved.status).toBe("todo");
      expect(moved.claim).toBeNull();
    });

    it("renews rather than re-announces the holder's own claim", async () => {
      const task = await makeTask(claimedBy(AGENT, 1));

      const moved = await transition(task.id, { to: "in_progress", reason: "Still on it" }, AGENT);

      expect(new Date(moved.claim!.expiresAt).getTime()).toBeGreaterThan(
        task.claimExpiresAt!.getTime(),
      );
      expect((await eventsFor(task.id)).map((event) => event.type)).toEqual([
        "task.status_changed",
      ]);
    });
  });

  describe("agents and done", () => {
    const original = env.AGENTS_MAY_COMPLETE;
    afterEach(() => {
      env.AGENTS_MAY_COMPLETE = original;
    });

    it("refuses an agent moving a task to done with ACTOR_NOT_PERMITTED", async () => {
      env.AGENTS_MAY_COMPLETE = false;
      const task = await makeTask({ status: "needs_qa" });

      await expectApiError(
        () => transition(task.id, { to: "done" }, AGENT),
        "ACTOR_NOT_PERMITTED",
        403,
      );
      expect((await row(task.id)).status).toBe("needs_qa");
    });

    it("lets an agent complete when AGENTS_MAY_COMPLETE is on", async () => {
      env.AGENTS_MAY_COMPLETE = true;
      const task = await makeTask({ status: "needs_qa" });

      expect((await transition(task.id, { to: "done" }, AGENT)).status).toBe("done");
    });

    it("always lets a human complete", async () => {
      env.AGENTS_MAY_COMPLETE = false;
      const task = await makeTask({ status: "needs_qa" });

      expect((await transition(task.id, { to: "done" }, HUMAN)).status).toBe("done");
    });
  });

  describe("needs_qa links", () => {
    it("appends the payload's links, skipping URLs the task already has", async () => {
      const task = await makeTask({
        status: "in_progress",
        links: [{ label: "Branch", url: "https://example.com/tree/retries" }],
      });

      const moved = await transition(task.id, {
        to: "needs_qa",
        summary: "Retries added",
        links: [
          { label: "Branch again", url: "https://example.com/tree/retries" },
          { label: "PR", url: "https://example.com/pull/7" },
          { label: "PR dup", url: "https://example.com/pull/7" },
        ],
      });

      expect(moved.links).toEqual([
        { label: "Branch", url: "https://example.com/tree/retries" },
        { label: "PR", url: "https://example.com/pull/7" },
      ]);
    });

    it("leaves links untouched when the payload has none", async () => {
      const links = [{ label: "PR", url: "https://example.com/pull/7" }];
      const task = await makeTask({ status: "in_progress", links });

      expect((await transition(task.id, { to: "needs_qa", summary: "Done" })).links).toEqual(links);
    });
  });

  describe("blocked with blockedBy", () => {
    it("adds each named task as a dependency, with a dependency.added event each", async () => {
      const task = await makeTask({ status: "in_progress" });
      const [b1, b2] = await makeTasks(2, () => ({ status: "todo" }));

      const moved = await transition(
        task.id,
        { to: "blocked", blockedBy: [b1!.id, b2!.id] },
        HUMAN,
      );

      expect(moved.status).toBe("blocked");
      expect(moved.dependencies.map((dep) => dep.id)).toEqual([b1!.id, b2!.id]);
      expect(moved.openDependencyCount).toBe(2);
      expect(
        (await eventsFor(task.id)).filter((event) => event.type === "dependency.added"),
      ).toHaveLength(2);
    });

    it("rejects a self-dependency on the blockedBy field", async () => {
      const task = await makeTask({ status: "in_progress" });

      const error = await expectApiError(
        () => transition(task.id, { to: "blocked", blockedBy: [task.id] }),
        "VALIDATION_ERROR",
        422,
      );
      expect(Object.keys(error.details as object)).toEqual(["blockedBy"]);
    });

    it("rejects a missing task on the blockedBy field and rolls the whole transition back", async () => {
      const task = await makeTask({ status: "in_progress" });
      const real = await makeTask();

      await expectApiError(
        () => transition(task.id, { to: "blocked", blockedBy: [real.id, 999] }),
        "VALIDATION_ERROR",
        422,
      );

      expect((await row(task.id)).status).toBe("in_progress");
      expect(await prisma.taskDependency.count()).toBe(0);
      expect(await eventsFor(task.id)).toEqual([]);
    });

    it("rejects a dependency that would close a cycle with DEPENDENCY_CYCLE", async () => {
      const a = await makeTask({ status: "in_progress" });
      const b = await makeTask();
      await makeDependency(b.id, a.id);

      const error = await expectApiError(
        () => transition(a.id, { to: "blocked", blockedBy: [b.id] }),
        "DEPENDENCY_CYCLE",
        409,
      );
      expect(error.details).toEqual({ path: [a.id, b.id, a.id] });
    });

    it("rejects blocking only on tasks that are already done, since nothing would ever unblock it", async () => {
      const task = await makeTask({ status: "in_progress" });
      const finished = await makeTask({ status: "done" });

      const error = await expectApiError(
        () => transition(task.id, { to: "blocked", blockedBy: [finished.id] }),
        "VALIDATION_ERROR",
        422,
      );
      expect(Object.keys(error.details as object)).toEqual(["blockedBy"]);
      expect((await row(task.id)).status).toBe("in_progress");
      expect(await prisma.taskDependency.count()).toBe(0);
    });

    it("allows done-only blockers when a written reason says what else it waits on", async () => {
      const task = await makeTask({ status: "in_progress" });
      const finished = await makeTask({ status: "done" });

      const moved = await transition(task.id, {
        to: "blocked",
        blockedBy: [finished.id],
        reason: "Also waiting on the vendor's API key",
      });

      expect(moved.status).toBe("blocked");
      expect(moved.openDependencyCount).toBe(0);
    });
  });

  describe("decisions", () => {
    it("creates an open decision from the payload on needs_user_decision", async () => {
      const task = await makeTask({ status: "in_progress" });

      const moved = await transition(
        task.id,
        { to: "needs_user_decision", decision: DECISION },
        AGENT,
      );

      expect(moved.openDecision).toMatchObject({
        status: "open",
        question: DECISION.question,
        options: DECISION.options,
        recommendedOption: "Remove it",
        context: DECISION.context,
        requestedBy: AGENT,
        choice: null,
        answeredBy: null,
      });
      expect((await eventsFor(task.id)).map((event) => event.type)).toEqual([
        "task.status_changed",
        "decision.requested",
      ]);
    });

    it("withdraws the previous open decision when a new question is asked", async () => {
      const { task, decision } = await makeTaskAwaitingDecision();

      const moved = await transition(task.id, {
        to: "needs_user_decision",
        decision: { question: "A sharper question?", options: [{ label: "A" }, { label: "B" }] },
      });

      expect(moved.openDecision?.question).toBe("A sharper question?");
      expect(moved.decisions.map((d) => [d.id, d.status])).toEqual([
        [moved.openDecision!.id, "open"],
        [decision.id, "withdrawn"],
      ]);
      expect(await prisma.decision.count({ where: { taskId: task.id, status: "open" } })).toBe(1);
    });

    it("withdraws the open decision when the task leaves needs_user_decision another way", async () => {
      const { task, decision } = await makeTaskAwaitingDecision();

      const moved = await transition(task.id, { to: "deferred", reason: "Not needed after all" });

      expect(moved.openDecision).toBeNull();
      expect((await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } })).status).toBe(
        "withdrawn",
      );
      expect(await eventsFor(task.id)).toContainEqual({
        type: "decision.withdrawn",
        actor: HUMAN,
        payload: { decisionId: decision.id },
      });
    });
  });

  describe("done unblocks dependents", () => {
    it("moves a blocked dependent to todo as the system actor once its only blocker is done", async () => {
      const blocker = await makeTask({ status: "needs_qa" });
      const waiter = await makeTask({ status: "blocked", statusNote: "Waiting" });
      await makeDependency(waiter.id, blocker.id);

      await transition(blocker.id, { to: "done" });

      const unblocked = await getTask(waiter.id);
      expect(unblocked.status).toBe("todo");
      expect(unblocked.statusNote).toMatch(/Unblocked/);
      expect(unblocked.openDependencyCount).toBe(0);
      expect(await eventsFor(waiter.id)).toEqual([
        {
          type: "task.status_changed",
          actor: SYSTEM_ACTOR,
          payload: { from: "blocked", to: "todo", note: unblocked.statusNote },
        },
      ]);
    });

    it("leaves a dependent blocked while any other dependency is unfinished", async () => {
      const blocker = await makeTask({ status: "needs_qa" });
      const other = await makeTask({ status: "in_progress" });
      const waiter = await makeTask({ status: "blocked" });
      await makeDependency(waiter.id, blocker.id);
      await makeDependency(waiter.id, other.id);

      await transition(blocker.id, { to: "done" });

      expect((await row(waiter.id)).status).toBe("blocked");
    });

    it("does not unblock on deferred — a deferred blocker still blocks", async () => {
      const blocker = await makeTask({ status: "in_progress" });
      const waiter = await makeTask({ status: "blocked" });
      await makeDependency(waiter.id, blocker.id);

      await transition(blocker.id, { to: "deferred", reason: "Parked" });

      expect((await row(waiter.id)).status).toBe("blocked");
    });

    it("does not touch a dependent that is not blocked", async () => {
      const blocker = await makeTask({ status: "needs_qa" });
      const waiter = await makeTask({ status: "backlog" });
      await makeDependency(waiter.id, blocker.id);

      await transition(blocker.id, { to: "done" });

      expect((await row(waiter.id)).status).toBe("backlog");
      expect(await eventsFor(waiter.id)).toEqual([]);
    });
  });

  describe("expectedVersion", () => {
    it("throws VERSION_CONFLICT when stale", async () => {
      const task = await makeTask({ status: "todo", version: 5 });

      const error = await expectApiError(
        () => transition(task.id, { to: "in_progress", expectedVersion: 4 }),
        "VERSION_CONFLICT",
        409,
      );
      expect(error.details).toEqual({ expected: 4, current: 5 });
    });
  });
});

/* ------------------------------------------------------------------ *
 * Claims
 * ------------------------------------------------------------------ */

describe("claimTask", () => {
  it("claims a todo task: in_progress, claim held by the caller", async () => {
    const task = await makeTask({ status: "todo" });

    const claimed = await claimTask(task.id, undefined, AGENT);

    expect(claimed.status).toBe("in_progress");
    expect(claimed.claim?.actor).toBe(AGENT);
  });

  it("refuses a second agent with TASK_ALREADY_CLAIMED naming the holder and expiry", async () => {
    const task = await makeTask({ status: "todo" });
    const first = await claimTask(task.id, undefined, AGENT);

    const error = await expectApiError(
      () => claimTask(task.id, undefined, OTHER_AGENT),
      "TASK_ALREADY_CLAIMED",
      409,
    );

    expect(error.details).toEqual({ claimedBy: AGENT, expiresAt: first.claim!.expiresAt });
  });

  it("makes an expired lease claimable by anyone — the crashed-agent recovery path", async () => {
    const task = await makeTask({ status: "todo" });
    await claimTask(task.id, undefined, AGENT);
    await expireClaim(task.id);

    expect((await getTask(task.id)).claim).toBeNull();

    const taken = await claimTask(task.id, undefined, OTHER_AGENT);
    expect(taken.claim?.actor).toBe(OTHER_AGENT);
  });

  it("honours expectedVersion", async () => {
    const task = await makeTask({ status: "todo" });

    await expectApiError(() => claimTask(task.id, 9, AGENT), "VERSION_CONFLICT", 409);
    expect((await claimTask(task.id, 1, AGENT)).version).toBe(2);
  });
});

describe("heartbeatTask", () => {
  it("extends the holder's lease without bumping the version or recording an event", async () => {
    const task = await makeTask({ ...claimedBy(AGENT, 1), version: 3 });

    const beat = await heartbeatTask(task.id, AGENT);

    expect(new Date(beat.claim!.expiresAt).getTime()).toBeGreaterThan(
      task.claimExpiresAt!.getTime() + 60_000,
    );
    expect(beat.version).toBe(3);
    expect(await eventsFor(task.id)).toEqual([]);
  });

  it("refuses anyone but the holder with NOT_CLAIM_HOLDER naming the holder", async () => {
    const task = await makeTask(claimedBy(AGENT));

    for (const actor of [OTHER_AGENT, HUMAN]) {
      const error = await expectApiError(
        () => heartbeatTask(task.id, actor),
        "NOT_CLAIM_HOLDER",
        409,
      );
      expect(error.details).toEqual({
        claimedBy: AGENT,
        expiresAt: task.claimExpiresAt!.toISOString(),
      });
    }
  });

  it("refuses a heartbeat on a task nobody holds, with no details", async () => {
    const task = await makeTask({ status: "todo" });

    const error = await expectApiError(
      () => heartbeatTask(task.id, AGENT),
      "NOT_CLAIM_HOLDER",
      409,
    );
    expect(error.details).toBeUndefined();
  });

  it("revives the holder's own expired lease if nobody else took the task", async () => {
    const task = await makeTask(expiredClaimBy(AGENT));

    const beat = await heartbeatTask(task.id, AGENT);

    expect(beat.claim?.actor).toBe(AGENT);
    expect(new Date(beat.claim!.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("refuses the old holder once another agent has taken the expired task", async () => {
    const task = await makeTask(expiredClaimBy(AGENT));
    await claimTask(task.id, undefined, OTHER_AGENT);

    await expectApiError(() => heartbeatTask(task.id, AGENT), "NOT_CLAIM_HOLDER", 409);
  });

  it("throws TASK_NOT_FOUND for an unknown id", async () => {
    await expectApiError(() => heartbeatTask(999, AGENT), "TASK_NOT_FOUND", 404);
  });
});

describe("releaseTask", () => {
  it("returns the holder's task to todo with the reason as its note, and records both events", async () => {
    const task = await makeTask(claimedBy(AGENT));

    const released = await release(task.id, AGENT, { reason: "Out of budget for today" });

    expect(released.status).toBe("todo");
    expect(released.claim).toBeNull();
    expect(released.statusNote).toBe("Out of budget for today");
    expect(await eventsFor(task.id)).toEqual([
      {
        type: "task.released",
        actor: AGENT,
        payload: { reason: "Out of budget for today", claimedBy: AGENT },
      },
      {
        type: "task.status_changed",
        actor: AGENT,
        payload: { from: "in_progress", to: "todo", note: "Out of budget for today" },
      },
    ]);
  });

  it("lets a human release an agent's claim", async () => {
    const task = await makeTask(claimedBy(AGENT));

    expect((await release(task.id, HUMAN)).claim).toBeNull();
  });

  it("refuses an agent that does not hold the claim with NOT_CLAIM_HOLDER", async () => {
    const task = await makeTask(claimedBy(AGENT));

    const error = await expectApiError(
      () => release(task.id, OTHER_AGENT),
      "NOT_CLAIM_HOLDER",
      409,
    );

    expect(error.details).toMatchObject({ claimedBy: AGENT });
    expect((await row(task.id)).claimedBy).toBe(AGENT);
  });

  it("refuses a task that is not in progress", async () => {
    const task = await makeTask({ status: "todo" });

    await expectApiError(() => release(task.id, HUMAN), "NOT_CLAIM_HOLDER", 409);
  });

  it("honours expectedVersion", async () => {
    const task = await makeTask({ ...claimedBy(AGENT), version: 2 });

    await expectApiError(
      () => release(task.id, AGENT, { expectedVersion: 1 }),
      "VERSION_CONFLICT",
      409,
    );
  });

  it("makes the task available to the next agent", async () => {
    const task = await makeTask(claimedBy(AGENT));
    await release(task.id, AGENT);

    expect((await next(OTHER_AGENT))?.id).toBe(task.id);
  });
});

/* ------------------------------------------------------------------ *
 * next
 * ------------------------------------------------------------------ */

describe("nextTask", () => {
  it("returns null when nothing is available", async () => {
    await makeTask({ status: "backlog" });
    await makeTask({ status: "blocked" });
    await makeTask({ status: "needs_qa" });
    await makeTask(claimedBy(AGENT));

    expect(await next(OTHER_AGENT)).toBeNull();
  });

  it("picks the highest priority first, then the oldest, and claims it", async () => {
    const t = (priority: "low" | "high" | "urgent", day: number) => ({
      status: "todo" as const,
      priority,
      createdAt: new Date(Date.UTC(2026, 0, day)),
    });
    const lowOld = await makeTask(t("low", 1));
    const highNew = await makeTask(t("high", 5));
    const highOld = await makeTask(t("high", 2));
    const urgent = await makeTask(t("urgent", 9));

    const order = [];
    for (let i = 0; i < 4; i += 1) order.push((await next(AGENT))?.id);

    expect(order).toEqual([urgent.id, highOld.id, highNew.id, lowOld.id]);
  });

  it("moves the task to in_progress under the caller's claim and records the events", async () => {
    const task = await makeTask({ status: "todo" });

    const taken = await next(AGENT);

    expect(taken).toMatchObject({ id: task.id, status: "in_progress", version: 2 });
    expect(taken?.claim?.actor).toBe(AGENT);
    expect(taken?.startedAt).not.toBeNull();
    expect((await eventsFor(task.id)).map((event) => event.type)).toEqual([
      "task.status_changed",
      "task.claimed",
    ]);
  });

  it("skips a todo task whose dependencies are not all done — deferred included", async () => {
    // Held under a live claim, so the blocker is not itself a candidate.
    const blocker = await makeTask(claimedBy(OTHER_AGENT));
    const deferredBlocker = await makeTask({ status: "deferred" });
    const doneBlocker = await makeTask({ status: "done" });
    const waiting = await makeTask({ status: "todo", priority: "urgent" });
    const waitingOnDeferred = await makeTask({ status: "todo", priority: "urgent" });
    const ready = await makeTask({ status: "todo", priority: "urgent" });
    const plain = await makeTask({ status: "todo", priority: "low" });
    await makeDependency(waiting.id, blocker.id);
    await makeDependency(waitingOnDeferred.id, deferredBlocker.id);
    await makeDependency(ready.id, doneBlocker.id);

    expect((await next(AGENT))?.id).toBe(ready.id);
    expect((await next(AGENT))?.id).toBe(plain.id);
    expect(await next(AGENT)).toBeNull();
  });

  it("reclaims an in_progress task whose lease expired, saying from whom", async () => {
    const task = await makeTask(expiredClaimBy(AGENT));

    const taken = await next(OTHER_AGENT);

    expect(taken?.id).toBe(task.id);
    expect(taken?.claim?.actor).toBe(OTHER_AGENT);
    expect(taken?.statusNote).toBe(`Reclaimed from ${AGENT} after its lease expired`);
  });

  it("never takes an in_progress task with a live lease", async () => {
    await makeTask(claimedBy(AGENT));

    expect(await next(OTHER_AGENT)).toBeNull();
  });

  it("treats an in_progress task with no claim at all as available", async () => {
    // e.g. a row that predates claims. Nobody is working it as far as the
    // server can tell, which is exactly the expired-lease case.
    const orphan = await makeTask({ status: "in_progress", claimedBy: null });

    const taken = await next(AGENT);

    expect(taken?.id).toBe(orphan.id);
    expect(taken?.statusNote).toBeNull();
  });

  it("filters by project", async () => {
    await makeTask({ status: "todo", project: "web", priority: "urgent" });
    const api = await makeTask({ status: "todo", project: "api", priority: "low" });

    expect((await next(AGENT, { project: ["api"] }))?.id).toBe(api.id);
    expect(await next(AGENT, { project: ["api"] })).toBeNull();
  });

  it("filters by minimum priority, inclusive", async () => {
    await makeTask({ status: "todo", priority: "medium" });
    const high = await makeTask({ status: "todo", priority: "high" });

    expect((await next(AGENT, { minPriority: "high" }))?.id).toBe(high.id);
    expect(await next(AGENT, { minPriority: "high" })).toBeNull();
  });

  it("never hands one task to two agents calling at once", async () => {
    await makeTasks(3, () => ({ status: "todo" }));
    const agents = Array.from({ length: 8 }, (_, i) => `agent:worker-${i}`);

    const results = await Promise.all(agents.map((agent) => next(agent)));

    const handedOut = results.filter((task) => task !== null);
    expect(handedOut).toHaveLength(3);
    expect(new Set(handedOut.map((task) => task!.id)).size).toBe(3);

    // And the database agrees with what each agent was told.
    for (const task of handedOut) {
      expect((await row(task!.id)).claimedBy).toBe(task!.claim!.actor);
    }
    expect(await prisma.taskEvent.count({ where: { type: "task.claimed" } })).toBe(3);
  });

  /**
   * The race the lease condition on the conditional UPDATE closes. A heartbeat
   * renews a lease without bumping the version, so between `next` reading an
   * expired candidate and writing its claim, the holder can come back — and a
   * version-only guard would still let `next` take the task out from under it.
   * The interleaving is forced by running the heartbeat inside the candidate
   * read.
   */
  it("does not steal a task whose holder heartbeats between the read and the claim", async () => {
    const task = await makeTask(expiredClaimBy(AGENT));
    const findMany = prisma.task.findMany.bind(prisma.task);
    vi.spyOn(prisma.task, "findMany").mockImplementationOnce((async (args: unknown) => {
      const candidates = await findMany(args as Parameters<typeof findMany>[0]);
      await heartbeatTask(task.id, AGENT);
      return candidates;
    }) as unknown as typeof prisma.task.findMany);

    expect(await next(OTHER_AGENT)).toBeNull();
    expect((await row(task.id)).claimedBy).toBe(AGENT);
  });

  it("never takes over a human's in_progress task, even after the lease lapses", async () => {
    // Humans do not heartbeat; a lapsed human lease is a person still working.
    await makeTask(expiredClaimBy(HUMAN));

    expect(await next(AGENT)).toBeNull();
  });

  it("does not claim a todo whose blocker reopened between the read and the claim", async () => {
    const blocker = await makeTask({ status: "done" });
    const task = await makeTask({ status: "todo" });
    await makeDependency(task.id, blocker.id);

    const findMany = prisma.task.findMany.bind(prisma.task);
    vi.spyOn(prisma.task, "findMany").mockImplementationOnce((async (args: unknown) => {
      const candidates = await findMany(args as Parameters<typeof findMany>[0]);
      // Reopening the blocker does not bump the dependent's version.
      await prisma.task.update({ where: { id: blocker.id }, data: { status: "todo" } });
      return candidates;
    }) as unknown as typeof prisma.task.findMany);

    const taken = await next(AGENT);

    expect(taken?.id).not.toBe(task.id);
    expect((await row(task.id)).status).toBe("todo");
  });
});

describe("nextTask under unrelated writes", () => {
  /**
   * Losing the version race is not the same as having nothing to do. A human
   * editing a candidate's priority bumps its version between `next`'s read and
   * its conditional claim; before the re-read, every candidate lost that way
   * made `next` answer `{ task: null }` over a queue that still had work in it.
   */
  it("re-reads and still claims a task when every candidate's version moved under it", async () => {
    const tasks = await makeTasks(3, () => ({ status: "todo" }));
    const findMany = prisma.task.findMany.bind(prisma.task);
    vi.spyOn(prisma.task, "findMany").mockImplementationOnce((async (args: unknown) => {
      const candidates = await findMany(args as Parameters<typeof findMany>[0]);
      await prisma.task.updateMany({ data: { version: { increment: 1 } } });
      return candidates;
    }) as unknown as typeof prisma.task.findMany);

    const taken = await next(AGENT);

    expect(taken?.id).toBe(tasks[0]!.id);
    expect(taken?.version).toBe(3);
  });
});

/* ------------------------------------------------------------------ *
 * Decisions
 * ------------------------------------------------------------------ */

describe("answerDecision", () => {
  it("records the choice, moves the task to todo, and puts the answer in the status note", async () => {
    const { task, decision } = await makeTaskAwaitingDecision();

    const answered = await answer(task.id, { choice: "Remove the endpoint" }, HUMAN);

    expect(answered.status).toBe("todo");
    expect(answered.statusNote).toBe("Decision: Remove the endpoint");
    expect(answered.openDecision).toBeNull();
    expect(answered.decisions[0]).toMatchObject({
      id: decision.id,
      status: "answered",
      choice: "Remove the endpoint",
      note: null,
      answeredBy: HUMAN,
    });
    expect(answered.decisions[0]?.answeredAt).not.toBeNull();
    expect(await eventsFor(task.id)).toEqual([
      {
        type: "decision.answered",
        actor: HUMAN,
        payload: { decisionId: decision.id, choice: "Remove the endpoint", note: null },
      },
      {
        type: "task.status_changed",
        actor: HUMAN,
        payload: { from: "needs_user_decision", to: "todo", note: "Decision: Remove the endpoint" },
      },
    ]);
  });

  it("accepts a free-form note, alone or with a choice", async () => {
    const one = await makeTaskAwaitingDecision();
    const two = await makeTaskAwaitingDecision();

    const noteOnly = await answer(one.task.id, { note: "Neither — ask the client" });
    const both = await answer(two.task.id, {
      choice: "Keep the endpoint",
      note: "one more release",
    });

    expect(noteOnly.statusNote).toBe("Decision: Neither — ask the client");
    expect(noteOnly.decisions[0]?.choice).toBeNull();
    expect(both.statusNote).toBe("Decision: Keep the endpoint — one more release");
  });

  it("rejects a choice that is not one of the options, on the choice field, writing nothing", async () => {
    const { task, decision } = await makeTaskAwaitingDecision();

    const error = await expectApiError(
      () => answer(task.id, { choice: "Something else" }),
      "VALIDATION_ERROR",
      422,
    );

    expect(Object.keys(error.details as object)).toEqual(["choice"]);
    expect((await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } })).status).toBe(
      "open",
    );
    expect((await row(task.id)).status).toBe("needs_user_decision");
  });

  it("skips the acceptance-criteria gate — the task was already in flight", async () => {
    const { task } = await makeTaskAwaitingDecision({ acceptanceCriteria: null });

    expect((await answer(task.id, { choice: "Keep the endpoint" })).status).toBe("todo");
  });

  it("throws NO_OPEN_DECISION when the task is not waiting on a decision", async () => {
    const task = await makeTask({ status: "todo" });

    await expectApiError(() => answer(task.id, { choice: "A" }), "NO_OPEN_DECISION", 409);
  });

  it("throws NO_OPEN_DECISION for an already-answered decision", async () => {
    const { task } = await makeTaskAwaitingDecision();
    await answer(task.id, { choice: "Keep the endpoint" });

    await expectApiError(
      () => answer(task.id, { choice: "Keep the endpoint" }),
      "NO_OPEN_DECISION",
      409,
    );
  });

  it("throws NO_OPEN_DECISION when the status says decision but no open one exists", async () => {
    const task = await makeTask({ status: "needs_user_decision" });
    await makeDecision({ taskId: task.id, status: "withdrawn" });

    await expectApiError(
      () => answer(task.id, { choice: "Keep the endpoint" }),
      "NO_OPEN_DECISION",
      409,
    );
  });

  it("returns the decision history newest first on the task", async () => {
    const task = await makeTask({ status: "in_progress" });
    await transition(task.id, { to: "needs_user_decision", decision: DECISION }, AGENT);
    await answer(task.id, { choice: "Keep it" });
    await transition(task.id, { to: "in_progress" }, AGENT);
    await transition(
      task.id,
      {
        to: "needs_user_decision",
        decision: {
          question: "Which log level?",
          options: [{ label: "info" }, { label: "debug" }],
        },
      },
      AGENT,
    );

    const loaded = await getTask(task.id);

    expect(loaded.decisions.map((d) => [d.question, d.status])).toEqual([
      ["Which log level?", "open"],
      [DECISION.question, "answered"],
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Dependencies
 * ------------------------------------------------------------------ */

describe("addDependency", () => {
  it("adds the edge, bumps the version, and records dependency.added", async () => {
    const task = await makeTask();
    const blocker = await makeTask({ status: "todo" });

    const updated = await addDependency(task.id, blocker.id, AGENT);

    expect(updated.dependencies.map((dep) => dep.id)).toEqual([blocker.id]);
    expect(updated.openDependencyCount).toBe(1);
    expect(updated.version).toBe(2);
    expect(await eventsFor(task.id)).toEqual([
      { type: "dependency.added", actor: AGENT, payload: { dependsOnId: blocker.id } },
    ]);
    expect((await getTask(blocker.id)).dependents.map((dep) => dep.id)).toEqual([task.id]);
  });

  it("is a no-op success when the edge already exists", async () => {
    const task = await makeTask();
    const blocker = await makeTask();
    await makeDependency(task.id, blocker.id);

    const updated = await addDependency(task.id, blocker.id, AGENT);

    expect(updated.version).toBe(1);
    expect(await prisma.taskDependency.count()).toBe(1);
    expect(await eventsFor(task.id)).toEqual([]);
  });

  it("rejects a self-dependency on dependsOnId", async () => {
    const task = await makeTask();

    const error = await expectApiError(
      () => addDependency(task.id, task.id, AGENT),
      "VALIDATION_ERROR",
      422,
    );
    expect(Object.keys(error.details as object)).toEqual(["dependsOnId"]);
  });

  it("rejects a dependency on a task that does not exist", async () => {
    const task = await makeTask();

    const error = await expectApiError(
      () => addDependency(task.id, 999, AGENT),
      "VALIDATION_ERROR",
      422,
    );
    expect(error.details).toEqual({ dependsOnId: ["Task 999 does not exist"] });
  });

  it("rejects a cycle with the full loop in details.path", async () => {
    const [a, b, c] = await makeTasks(3);
    await makeDependency(b!.id, c!.id);
    await makeDependency(c!.id, a!.id);

    const error = await expectApiError(
      () => addDependency(a!.id, b!.id, AGENT),
      "DEPENDENCY_CYCLE",
      409,
    );

    // a → b → c → a
    expect(error.details).toEqual({ path: [a!.id, b!.id, c!.id, a!.id] });
    expect(await prisma.taskDependency.count()).toBe(2);
  });

  it("allows a diamond, which is not a cycle", async () => {
    const [top, left, right, bottom] = await makeTasks(4);
    await makeDependency(top!.id, left!.id);
    await makeDependency(top!.id, right!.id);
    await makeDependency(left!.id, bottom!.id);

    const updated = await addDependency(right!.id, bottom!.id, AGENT);

    expect(updated.dependencies.map((dep) => dep.id)).toEqual([bottom!.id]);
  });

  it("refuses an agent that does not hold the live claim", async () => {
    const task = await makeTask(claimedBy(AGENT));
    const blocker = await makeTask();

    await expectApiError(
      () => addDependency(task.id, blocker.id, OTHER_AGENT),
      "TASK_ALREADY_CLAIMED",
      409,
    );
  });

  it("throws TASK_NOT_FOUND for an unknown task", async () => {
    const blocker = await makeTask();
    await expectApiError(() => addDependency(999, blocker.id, AGENT), "TASK_NOT_FOUND", 404);
  });
});

describe("removeDependency", () => {
  it("removes the edge, bumps the version, and records dependency.removed", async () => {
    const task = await makeTask();
    const blocker = await makeTask();
    await makeDependency(task.id, blocker.id);

    const updated = await removeDependency(task.id, blocker.id, HUMAN);

    expect(updated.dependencies).toEqual([]);
    expect(updated.version).toBe(2);
    expect(await eventsFor(task.id)).toEqual([
      { type: "dependency.removed", actor: HUMAN, payload: { dependsOnId: blocker.id } },
    ]);
  });

  it("is a no-op success when the edge does not exist", async () => {
    const task = await makeTask();

    const updated = await removeDependency(task.id, 999, HUMAN);

    expect(updated.version).toBe(1);
    expect(await eventsFor(task.id)).toEqual([]);
  });

  it("unblocks a blocked task when its last unfinished blocker is removed", async () => {
    const task = await makeTask({ status: "blocked" });
    const doneBlocker = await makeTask({ status: "done" });
    const openBlocker = await makeTask({ status: "in_progress" });
    await makeDependency(task.id, doneBlocker.id);
    await makeDependency(task.id, openBlocker.id);

    const updated = await removeDependency(task.id, openBlocker.id, HUMAN);

    expect(updated.status).toBe("todo");
    const events = await eventsFor(task.id);
    expect(events.at(-1)).toMatchObject({
      type: "task.status_changed",
      actor: SYSTEM_ACTOR,
      payload: { from: "blocked", to: "todo" },
    });
  });

  it("keeps a task blocked while another unfinished blocker remains", async () => {
    const task = await makeTask({ status: "blocked" });
    const [one, two] = await makeTasks(2, () => ({ status: "in_progress" }));
    await makeDependency(task.id, one!.id);
    await makeDependency(task.id, two!.id);

    expect((await removeDependency(task.id, one!.id, HUMAN)).status).toBe("blocked");
  });

  it("refuses an agent that does not hold the live claim", async () => {
    const task = await makeTask(claimedBy(AGENT));
    const blocker = await makeTask();
    await makeDependency(task.id, blocker.id);

    await expectApiError(
      () => removeDependency(task.id, blocker.id, OTHER_AGENT),
      "TASK_ALREADY_CLAIMED",
      409,
    );
  });
});

describe("deleting a blocker", () => {
  it("unblocks dependents that were waiting only on it", async () => {
    const blocker = await makeTask({ status: "in_progress" });
    const waiter = await makeTask({ status: "blocked" });
    const alsoWaiting = await makeTask({ status: "blocked" });
    const other = await makeTask({ status: "todo" });
    await makeDependency(waiter.id, blocker.id);
    await makeDependency(alsoWaiting.id, blocker.id);
    await makeDependency(alsoWaiting.id, other.id);

    await deleteTask(blocker.id, HUMAN);

    expect((await row(waiter.id)).status).toBe("todo");
    expect((await row(alsoWaiting.id)).status).toBe("blocked");
    expect((await eventsFor(waiter.id)).at(-1)?.actor).toBe(SYSTEM_ACTOR);
  });
});
