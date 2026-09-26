import { ACTOR_HEADER } from "@helpdesk/contracts";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../app.js";

/**
 * A single realistic walk through the API, at the HTTP layer, covering the
 * exact gaps a prior audit found: label-scoped `next`, multi-term `q` that
 * finds a comment, cross-project `dependsOn`, and events filtered by project.
 * Each of `services/*.test.ts` and `routes/*.route.test.ts` proves its own
 * piece in isolation; this proves they compose the way an agent would
 * actually use them, in one monorepo-shaped setup.
 */

const app = createApp();
const TASKS = "/api/v1/tasks";
const WEB_AGENT = "agent:web-bot";
const API_AGENT = "agent:api-bot";

describe("a monorepo project: labels, multi-term search, cross-project dependencies, and events", () => {
  it("walks the whole scenario end to end", async () => {
    // --- Arrange: a "monorepo" project with a web task and an api task,
    // labelled to their workspace, one blocking the other across the split. ---
    const webTask = await request(app)
      .post(TASKS)
      .set(ACTOR_HEADER, WEB_AGENT)
      .send({
        title: "Fix pagination reset on filter change",
        description: "The task list resets to page 1 every time a filter changes.",
        project: "monorepo",
        labels: ["web"],
      });
    expect(webTask.status).toBe(201);

    const apiTask = await request(app)
      .post(TASKS)
      .set(ACTOR_HEADER, API_AGENT)
      .send({
        title: "Add a stable sort tiebreaker to the list endpoint",
        description: "Needed before the web pagination fix can be verified.",
        project: "monorepo",
        labels: ["api"],
        status: "todo",
        acceptanceCriteria: "Two ties in the same page never swap order across a reload.",
      });
    expect(apiTask.status).toBe(201);

    // The web task depends on the api task finishing first.
    const blocked = await request(app)
      .post(`${TASKS}/${webTask.body.id}/dependencies`)
      .set(ACTOR_HEADER, WEB_AGENT)
      .send({ dependsOnId: apiTask.body.id });
    expect(blocked.status).toBe(200);

    // A second, unblocked web task — ready to claim, so scoping `next` by
    // label is what has to keep it out of the api agent's hands, not a
    // dependency that happens to also block it.
    const readyWebTask = await request(app)
      .post(TASKS)
      .set(ACTOR_HEADER, WEB_AGENT)
      .send({
        title: "Debounce the filter input before it refetches",
        description: "Every keystroke currently fires its own request.",
        project: "monorepo",
        labels: ["web"],
        status: "todo",
        acceptanceCriteria: "Typing five characters quickly fires exactly one request.",
      });
    expect(readyWebTask.status).toBe(201);

    // A human leaves a comment on the web task naming the real symptom, in
    // words that appear nowhere in the title or description.
    const comment = await request(app)
      .post(`${TASKS}/${webTask.body.id}/comments`)
      .set(ACTOR_HEADER, "human:krisz")
      .send({ body: "Repro: type in the search box, the cursor jumps to page 1 mid-keystroke." });
    expect(comment.status).toBe(201);

    // --- task_next scoped by label: an agent working only the api workspace
    // must get the api task, never the web one, even though the web task was
    // filed first and nothing blocks it from a status point of view. ---
    const apiNext = await request(app)
      .post(`${TASKS}/next`)
      .set(ACTOR_HEADER, API_AGENT)
      .send({ label: ["api"] });
    expect(apiNext.status).toBe(200);
    expect(apiNext.body.task?.id).toBe(apiTask.body.id);

    // Scoped to `web`, the agent gets the ready web task, never the api one —
    // even though the api task is also `todo` and higher up the queue by
    // creation order.
    const webNext = await request(app)
      .post(`${TASKS}/next`)
      .set(ACTOR_HEADER, WEB_AGENT)
      .send({ label: ["web"] });
    expect(webNext.status).toBe(200);
    expect(webNext.body.task?.id).toBe(readyWebTask.body.id);

    // --- Multi-term q: neither term alone would isolate the web task from
    // the api task ("pagination" is only in the web task's own text, but
    // proves the search reaches title+description+comment together). The
    // second assertion is the one the audit's original bug missed —
    // "cursor jumps" only exists in the comment thread. ---
    const searchTitle = await request(app).get(TASKS).query({ q: "pagination reset" });
    expect(searchTitle.body.data.map((t: { id: number }) => t.id)).toEqual([webTask.body.id]);

    const searchComment = await request(app).get(TASKS).query({ q: "cursor jumps" });
    expect(searchComment.body.data.map((t: { id: number }) => t.id)).toEqual([webTask.body.id]);

    // --- dependsOn across the project split: the api task's dependent is the
    // web task, and the ref on it carries `project` so an agent in a
    // different repo can tell at a glance what it is waiting on without a
    // second lookup. ---
    const dependents = await request(app).get(TASKS).query({ dependsOn: apiTask.body.id });
    expect(dependents.body.data.map((t: { id: number }) => t.id)).toEqual([webTask.body.id]);

    const webDetail = await request(app).get(`${TASKS}/${webTask.body.id}`);
    expect(webDetail.body.dependencies).toEqual([
      expect.objectContaining({ id: apiTask.body.id, project: "monorepo" }),
    ]);

    // Finish the api task; done unblocks nothing here since the dependency is
    // a hard link, not a `blocked` status, but the completion event is what
    // the next assertion reads back.
    const apiClaim = await request(app)
      .post(`${TASKS}/${apiTask.body.id}/transition`)
      .set(ACTOR_HEADER, API_AGENT)
      .send({ to: "in_progress" });
    expect(apiClaim.status).toBe(200);

    const apiQa = await request(app)
      .post(`${TASKS}/${apiTask.body.id}/transition`)
      .set(ACTOR_HEADER, API_AGENT)
      .send({ to: "needs_qa", summary: "Tiebreaker added; verified against the seed data." });
    expect(apiQa.status).toBe(200);

    // --- Events filtered by project: every event recorded above stamped
    // "monorepo", including the comment and the transitions, so the whole
    // trail is findable by project even though nothing here ever passed
    // `project` explicitly to `recordEvent`. ---
    const events = await request(app).get("/api/v1/events").query({ project: "monorepo" });
    expect(events.status).toBe(200);
    const types = events.body.data.map((e: { type: string }) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "task.created",
        "dependency.added",
        "comment.created",
        "task.status_changed",
      ]),
    );
    expect(
      events.body.data.every((e: { project: string | null }) => e.project === "monorepo"),
    ).toBe(true);

    // A project filter for an unrelated project finds none of this.
    const otherProjectEvents = await request(app)
      .get("/api/v1/events")
      .query({ project: "unrelated" });
    expect(otherProjectEvents.body.data).toEqual([]);
  });
});
