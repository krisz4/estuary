import { type TaskEvent } from "@helpdesk/contracts";
import { describe, expect, it } from "vitest";
import { formatLiveStatusLine, LIVE_MOTION_SNAP_THRESHOLD, planLiveAnimations } from "@/features/floor/liveMotion";

let nextId = 1;

const event = (overrides: Partial<TaskEvent> = {}): TaskEvent => ({
  id: nextId++,
  taskId: overrides.taskId ?? 1,
  taskTitle: overrides.taskTitle ?? null,
  project: overrides.project ?? "helpdesk",
  type: overrides.type ?? "task.status_changed",
  actor: overrides.actor ?? "agent:claude-code",
  payload: overrides.payload ?? {},
  createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
});

describe("planLiveAnimations", () => {
  it("turns a status_changed event into a move animation", () => {
    const plan = planLiveAnimations(
      [event({ type: "task.status_changed", taskId: 5, payload: { from: "todo", to: "in_progress" } })],
      { reducedMotion: false },
    );
    expect(plan.snap).toBe(false);
    expect(plan.animations).toEqual([{ kind: "move", taskId: 5, from: "todo", to: "in_progress" }]);
  });

  it("turns a claimed event into a claim animation", () => {
    const plan = planLiveAnimations(
      [event({ type: "task.claimed", taskId: 7, actor: "agent:claude-code-ci" })],
      { reducedMotion: false },
    );
    expect(plan.animations).toEqual([{ kind: "claim", taskId: 7, actor: "agent:claude-code-ci" }]);
  });

  it("turns a decision.requested event into a pulse animation", () => {
    const plan = planLiveAnimations([event({ type: "decision.requested", taskId: 9 })], { reducedMotion: false });
    expect(plan.animations).toEqual([{ kind: "pulse", taskId: 9 }]);
  });

  it("ignores event types it doesn't animate", () => {
    const plan = planLiveAnimations(
      [event({ type: "comment.created" }), event({ type: "dependency.added" })],
      { reducedMotion: false },
    );
    expect(plan.animations).toEqual([]);
    expect(plan.snap).toBe(false);
  });

  it("drops a status_changed event with a missing or identical from/to rather than animating a no-op", () => {
    const plan = planLiveAnimations(
      [
        event({ payload: { from: "todo", to: "todo" } }),
        event({ payload: { to: "in_progress" } }),
        event({ payload: {} }),
      ],
      { reducedMotion: false },
    );
    expect(plan.animations).toEqual([]);
  });

  it("snaps (no individual animations) when reduced motion is requested", () => {
    const plan = planLiveAnimations(
      [event({ payload: { from: "todo", to: "in_progress" } })],
      { reducedMotion: true },
    );
    expect(plan.snap).toBe(true);
    expect(plan.animations).toEqual([]);
  });

  it(`snaps when more than ${LIVE_MOTION_SNAP_THRESHOLD} events arrive in one poll`, () => {
    const many = Array.from({ length: LIVE_MOTION_SNAP_THRESHOLD + 1 }, (_, i) =>
      event({ taskId: i, payload: { from: "todo", to: "in_progress" } }),
    );
    const plan = planLiveAnimations(many, { reducedMotion: false });
    expect(plan.snap).toBe(true);
    expect(plan.animations).toEqual([]);
  });

  it(`does not snap at exactly the threshold`, () => {
    const exactly = Array.from({ length: LIVE_MOTION_SNAP_THRESHOLD }, (_, i) =>
      event({ taskId: i, payload: { from: "todo", to: "in_progress" } }),
    );
    const plan = planLiveAnimations(exactly, { reducedMotion: false });
    expect(plan.snap).toBe(false);
    expect(plan.animations).toHaveLength(LIVE_MOTION_SNAP_THRESHOLD);
  });

  it("preserves event order in the animation list", () => {
    const plan = planLiveAnimations(
      [
        event({ taskId: 1, type: "task.claimed" }),
        event({ taskId: 2, type: "decision.requested" }),
        event({ taskId: 3, payload: { from: "todo", to: "done" } }),
      ],
      { reducedMotion: false },
    );
    expect(plan.animations.map((a) => a.taskId)).toEqual([1, 2, 3]);
  });
});

describe("formatLiveStatusLine", () => {
  it("reads 'No agent working' quietly at zero, not '0 agents working'", () => {
    expect(formatLiveStatusLine(0, 5)).toBe("No agent working · synced 5s ago");
  });

  it("pluralises the agent count", () => {
    expect(formatLiveStatusLine(1, 5)).toBe("1 agent working · synced 5s ago");
    expect(formatLiveStatusLine(3, 5)).toBe("3 agents working · synced 5s ago");
  });

  it("reads 'just now' under a second", () => {
    expect(formatLiveStatusLine(2, 0.4)).toBe("2 agents working · synced just now");
  });

  it("rounds the elapsed seconds", () => {
    expect(formatLiveStatusLine(2, 12.6)).toBe("2 agents working · synced 13s ago");
  });
});
