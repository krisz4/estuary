import request from "supertest";
import { describe, expect, it } from "vitest";
import { agentConnectionsSchema, taskExportSchema } from "@estuary/contracts";
import { createApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { makeTask, makeTaskAwaitingDecision } from "../test/factories.js";
const app = createApp();
const actor = "agent:codex@estuary";
const post = (id: number, action: string, body: object, session = "session-a") =>
  request(app)
    .post(`/api/v1/tasks/${id}/${action}`)
    .set("X-Actor", actor)
    .set("X-Claim-Session", session)
    .send(body);
const evidence = {
  commit: "abcdef1234567",
  checks: [{ command: "pnpm test", result: "passed" }],
  criteria: [{ criterion: "Requests receive the expected response", result: "passed" }],
};
describe("supervision workflow", () => {
  it("fences another session of the same actor across writes, heartbeat, comments, release, and takeover", async () => {
    const task = await makeTask({ status: "todo" });
    const claimed = await post(task.id, "claim", {});
    expect(claimed.body.claim.sessionId).toBe("session-a");
    for (const action of ["claim", "transition", "heartbeat", "release"]) {
      const response = await post(
        task.id,
        action,
        action === "transition" ? { to: "needs_qa", summary: "Work checked" } : {},
        "session-b",
      );
      expect(response.status, action).toBe(409);
    }
    const patch = await request(app)
      .patch(`/api/v1/tasks/${task.id}`)
      .set("X-Actor", actor)
      .set("X-Claim-Session", "session-b")
      .send({ description: "Another session changing the task" });
    expect(patch.status).toBe(409);
    const before = (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).claimExpiresAt;
    await request(app)
      .post(`/api/v1/tasks/${task.id}/comments`)
      .set("X-Actor", actor)
      .set("X-Claim-Session", "session-b")
      .send({ kind: "progress", body: "An observation from another session" });
    expect(
      (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).claimExpiresAt,
    ).toEqual(before);
    await prisma.task.update({ where: { id: task.id }, data: { claimExpiresAt: new Date(0) } });
    expect((await post(task.id, "claim", {}, "session-b")).status).toBe(200);
    expect((await post(task.id, "heartbeat", {}, "session-a")).status).toBe(409);
  });
  it("stores checkpoint and verification evidence, and rejects approval of a stale version", async () => {
    const task = await makeTask({ status: "todo" });
    await post(task.id, "claim", {});
    const checkpoint = {
      branch: "codex/work",
      commit: "abcdef1234567",
      completed: "Implemented handler",
      remaining: "Run the integration check",
    };
    expect((await post(task.id, "release", { checkpoint })).body.checkpoint).toEqual(checkpoint);
    await post(task.id, "claim", {});
    const qa = await post(task.id, "transition", {
      to: "needs_qa",
      summary: "Implemented and verified",
      verification: evidence,
    });
    expect(qa.body.verification).toEqual(evidence);
    const changed = await request(app)
      .patch(`/api/v1/tasks/${task.id}`)
      .send({ description: "Reviewer changes the scope before approval" });
    expect(changed.status).toBe(200);
    const approve = await request(app)
      .post(`/api/v1/tasks/${task.id}/transition`)
      .send({ to: "done", expectedVersion: qa.body.version });
    expect(approve.status).toBe(409);
    expect(approve.body.error.code).toBe("VERSION_CONFLICT");
  });
  it("keeps attention age through edits and restores a snoozed blocker when its time expires", async () => {
    const task = await makeTask({ status: "todo", project: "supervision-snooze" });
    const blocked = await request(app)
      .post(`/api/v1/tasks/${task.id}/transition`)
      .send({ to: "blocked", reason: "Waiting on the vendor" });
    const since = blocked.body.attentionSince;
    const edited = await request(app)
      .patch(`/api/v1/tasks/${task.id}`)
      .send({ description: "The vendor is still investigating this problem" });
    expect(edited.body.attentionSince).toBe(since);
    const snoozedUntil = new Date(Date.now() + 60_000).toISOString();
    expect(
      (await request(app).patch(`/api/v1/tasks/${task.id}`).send({ snoozedUntil })).status,
    ).toBe(200);
    const list = () =>
      request(app).get("/api/v1/tasks").query({ attention: true, project: task.project });
    expect((await list()).body.meta.total).toBe(0);
    expect(
      (
        await request(app)
          .get("/api/v1/tasks")
          .query({ attention: true, snoozed: true, project: task.project })
      ).body.data[0].id,
    ).toBe(task.id);
    expect(
      (await request(app).get("/api/v1/tasks/stats").query({ project: task.project })).body
        .needsAttention,
    ).toBe(0);
    await prisma.task.update({ where: { id: task.id }, data: { snoozedUntil: new Date(0) } });
    expect((await list()).body.meta.total).toBe(1);
  });
  it("sorts by actual work unlocked and updates the score when dependencies change", async () => {
    const first = await makeTask({ status: "todo", project: "unlock-ranking" });
    const other = await makeTask({ status: "todo", project: "unlock-ranking" });
    const target = await makeTask({ status: "todo", project: "unlock-ranking" });
    await request(app)
      .post(`/api/v1/tasks/${target.id}/dependencies`)
      .send({ dependsOnId: first.id });
    let rows = (
      await request(app)
        .get("/api/v1/tasks")
        .query({ project: "unlock-ranking", sort: "unlocksCount:desc" })
    ).body.data;
    expect(rows[0]).toMatchObject({ id: first.id, unlocksCount: 1 });
    await request(app)
      .post(`/api/v1/tasks/${target.id}/dependencies`)
      .send({ dependsOnId: other.id });
    rows = (
      await request(app)
        .get("/api/v1/tasks")
        .query({ project: "unlock-ranking", sort: "unlocksCount:desc" })
    ).body.data;
    expect(rows.every((row: { unlocksCount: number }) => row.unlocksCount === 0)).toBe(true);
    await request(app).post(`/api/v1/tasks/${other.id}/transition`).send({ to: "done" });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: first.id } })).unlocksCount).toBe(1);
  });
  it("rejects an answer bound to a replaced decision", async () => {
    const { task, decision } = await makeTaskAwaitingDecision();
    const res = await request(app)
      .post(`/api/v1/tasks/${task.id}/decision/answer`)
      .send({ choice: "A", decisionId: decision.id + 1 });
    expect(res.status).toBe(409);
  });
  it("exports the project with its comments, decisions and events and reports connection readiness", async () => {
    const task = await makeTask({ project: "export-scope" });
    await request(app)
      .post(`/api/v1/tasks/${task.id}/comments`)
      .send({ kind: "note", body: "Preserve this project context" });
    const exported = await request(app)
      .get("/api/v1/tasks/export")
      .query({ project: "export-scope" });
    expect(exported.status).toBe(200);
    expect(taskExportSchema.safeParse(exported.body).success).toBe(true);
    expect(exported.body.tasks[0].comments[0].body).toBe("Preserve this project context");
    expect(exported.body.events).toHaveLength(1);
    expect(
      (
        await request(app)
          .get("/api/v1/system/ready")
          .set("X-Actor", actor)
          .set("X-Claim-Session", "connection-test")
      ).status,
    ).toBe(200);
    const connections = await request(app).get("/api/v1/system/agents");
    expect(agentConnectionsSchema.safeParse(connections.body).success).toBe(true);
    expect(connections.body.data).toContainEqual(
      expect.objectContaining({ actor, sessionId: "connection-test" }),
    );
  });
});
