import { type TaskEvent } from "@estuary/contracts";
import { describe, expect, it } from "vitest";
import { sinceYouLeftSentence, sinceYouLeftSummary } from "@/features/logbook/sinceYouLeft";

const event = (overrides: Partial<TaskEvent>): TaskEvent => ({
  id: 1,
  taskId: 42,
  taskTitle: "Some task",
  project: "estuary",
  type: "task.updated",
  actor: "agent:claude-code",
  payload: {},
  createdAt: "2026-09-10T12:00:00.000Z",
  ...overrides,
});

describe("sinceYouLeftSummary", () => {
  it("reports firstVisit when there is no stored timestamp", () => {
    const summary = sinceYouLeftSummary([event({})], null);
    expect(summary.firstVisit).toBe(true);
    expect(summary.shipped).toBe(0);
  });

  it("counts only events after the last visit", () => {
    const lastVisitAt = "2026-09-10T00:00:00.000Z";
    const events = [
      event({
        id: 1,
        type: "task.status_changed",
        payload: { from: "needs_qa", to: "done" },
        createdAt: "2026-09-09T00:00:00.000Z",
      }),
      event({
        id: 2,
        type: "task.status_changed",
        payload: { from: "in_progress", to: "done" },
        createdAt: "2026-09-10T06:00:00.000Z",
      }),
      event({
        id: 3,
        type: "task.status_changed",
        payload: { from: "in_progress", to: "needs_user_action" },
        createdAt: "2026-09-10T07:00:00.000Z",
      }),
      event({ id: 4, type: "decision.requested", createdAt: "2026-09-10T08:00:00.000Z" }),
      event({
        id: 5,
        type: "task.status_changed",
        payload: { from: "in_progress", to: "needs_qa" },
        createdAt: "2026-09-10T09:00:00.000Z",
      }),
    ];

    const summary = sinceYouLeftSummary(events, lastVisitAt);
    expect(summary.firstVisit).toBe(false);
    expect(summary.shipped).toBe(1);
    expect(summary.actionsRequested).toBe(1);
    expect(summary.qaRequested).toBe(1);
    expect(summary.decisionsRequested).toBe(1);
    expect(summary.activeAgents).toEqual(["agent:claude-code"]);
  });

  it("flags truncated when the oldest loaded event is still after the last visit", () => {
    const events = [event({ createdAt: "2026-09-10T09:00:00.000Z" })];
    const summary = sinceYouLeftSummary(events, "2026-09-01T00:00:00.000Z");
    expect(summary.truncated).toBe(true);
  });

  it("does not count human actors as active agents", () => {
    const events = [event({ actor: "human:priya", createdAt: "2026-09-10T09:00:00.000Z" })];
    const summary = sinceYouLeftSummary(events, "2026-09-01T00:00:00.000Z");
    expect(summary.activeAgents).toEqual([]);
  });

  it("counts a needs_qa → in_progress transition as sent back", () => {
    const events = [
      event({
        type: "task.status_changed",
        payload: { from: "needs_qa", to: "in_progress" },
        createdAt: "2026-09-10T09:00:00.000Z",
      }),
    ];
    const summary = sinceYouLeftSummary(events, "2026-09-01T00:00:00.000Z");
    expect(summary.sentBack).toBe(1);
  });

  it("does not count needs_qa → done as sent back", () => {
    const events = [
      event({
        type: "task.status_changed",
        payload: { from: "needs_qa", to: "done" },
        createdAt: "2026-09-10T09:00:00.000Z",
      }),
    ];
    const summary = sinceYouLeftSummary(events, "2026-09-01T00:00:00.000Z");
    expect(summary.sentBack).toBe(0);
  });

  it("names the single agent that asked the most questions", () => {
    const events = [
      event({
        id: 1,
        actor: "agent:claude-code",
        type: "decision.requested",
        createdAt: "2026-09-10T09:00:00.000Z",
      }),
      event({
        id: 2,
        actor: "agent:claude-code",
        type: "decision.requested",
        createdAt: "2026-09-10T09:01:00.000Z",
      }),
      event({
        id: 3,
        actor: "agent:other",
        type: "decision.requested",
        createdAt: "2026-09-10T09:02:00.000Z",
      }),
    ];
    const summary = sinceYouLeftSummary(events, "2026-09-01T00:00:00.000Z");
    expect(summary.topAskingAgent).toEqual({ actor: "agent:claude-code", count: 2 });
  });

  it("names no agent when the top spot is a tie", () => {
    const events = [
      event({
        id: 1,
        actor: "agent:claude-code",
        type: "decision.requested",
        createdAt: "2026-09-10T09:00:00.000Z",
      }),
      event({
        id: 2,
        actor: "agent:other",
        type: "decision.requested",
        createdAt: "2026-09-10T09:01:00.000Z",
      }),
    ];
    const summary = sinceYouLeftSummary(events, "2026-09-01T00:00:00.000Z");
    expect(summary.topAskingAgent).toBeNull();
  });
});

describe("sinceYouLeftSentence", () => {
  it("returns null on a first visit", () => {
    const summary = sinceYouLeftSummary([], null);
    expect(sinceYouLeftSentence(summary, null)).toBeNull();
  });

  it("returns null when nothing qualifying happened", () => {
    const summary = sinceYouLeftSummary(
      [event({ type: "comment.created" })],
      "2026-09-10T00:00:00.000Z",
    );
    expect(sinceYouLeftSentence(summary, "2026-09-10T00:00:00.000Z")).toBeNull();
  });

  it("names the top-asking agent in the sentence", () => {
    const events = [
      event({
        id: 1,
        type: "task.status_changed",
        payload: { from: "in_progress", to: "done" },
        createdAt: "2026-09-10T09:00:00.000Z",
      }),
      event({
        id: 2,
        actor: "agent:claude-code",
        type: "decision.requested",
        createdAt: "2026-09-10T09:01:00.000Z",
      }),
    ];
    const summary = sinceYouLeftSummary(events, "2026-09-01T00:00:00.000Z");
    const sentence = sinceYouLeftSentence(summary, "2026-09-01T00:00:00.000Z");
    expect(sentence).toContain("1 shipped");
    expect(sentence).toContain("claude-code asked 1 question");
  });
});
