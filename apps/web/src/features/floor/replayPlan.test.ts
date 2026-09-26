import { type TaskEvent } from "@helpdesk/contracts";
import { describe, expect, it } from "vitest";
import { buildReplaySteps, describeMove } from "@/features/floor/replayPlan";

let nextId = 1;

const event = (overrides: Partial<TaskEvent> = {}): TaskEvent => ({
  id: nextId++,
  taskId: overrides.taskId ?? 1,
  taskTitle: overrides.taskTitle ?? null,
  project: overrides.project ?? "helpdesk",
  type: overrides.type ?? "task.status_changed",
  actor: overrides.actor ?? "agent:claude-code",
  payload: overrides.payload ?? { from: "todo", to: "in_progress" },
  createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
});

const at = (minute: number): string => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const ms = (minute: number): number => Date.UTC(2026, 0, 1, 0, minute);

describe("buildReplaySteps", () => {
  it("makes one step per status change, oldest first, skipping the gaps between them", () => {
    const steps = buildReplaySteps(
      [event({ taskId: 3, createdAt: at(50) }), event({ taskId: 2, createdAt: at(5) }), event({ taskId: 1, createdAt: at(1) })],
      ms(0),
    );
    expect(steps.map((step) => step.atMs)).toEqual([ms(1), ms(5), ms(50)]);
    expect(steps.map((step) => step.events.map((e) => e.taskId))).toEqual([[1], [2], [3]]);
  });

  it("ignores other event types and anything at or before the start", () => {
    const steps = buildReplaySteps(
      [
        event({ createdAt: at(0) }),
        event({ type: "comment.created", createdAt: at(2) }),
        event({ taskId: 7, createdAt: at(3) }),
      ],
      ms(0),
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]?.events[0]?.taskId).toBe(7);
  });

  it("returns no steps when nothing moved", () => {
    expect(buildReplaySteps([event({ type: "comment.created", createdAt: at(4) })], ms(0))).toEqual([]);
  });

  it("chunks a busy range into at most maxSteps, each step landing on its last event", () => {
    const events = Array.from({ length: 10 }, (_, i) => event({ taskId: i + 1, createdAt: at(i + 1) }));
    const steps = buildReplaySteps(events, ms(0), 4);
    expect(steps.length).toBeLessThanOrEqual(4);
    expect(steps.flatMap((step) => step.events.map((e) => e.taskId))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const step of steps) {
      expect(step.atMs).toBe(new Date(step.events.at(-1)!.createdAt).getTime());
    }
  });

  it("never splits events at the same instant across two steps", () => {
    const events = [
      event({ taskId: 1, createdAt: at(1) }),
      event({ taskId: 2, createdAt: at(2) }),
      event({ taskId: 3, createdAt: at(2) }),
      event({ taskId: 4, createdAt: at(3) }),
    ];
    const steps = buildReplaySteps(events, ms(0), 2);
    const stepOf = (taskId: number) => steps.findIndex((step) => step.events.some((e) => e.taskId === taskId));
    expect(stepOf(2)).toBe(stepOf(3));
  });
});

describe("describeMove", () => {
  it("names the actor without its kind prefix and the statuses by their labels", () => {
    expect(describeMove(event({ taskId: 49, actor: "agent:claude-code-ci", payload: { from: "todo", to: "in_progress" } }))).toBe(
      "claude-code-ci moved #49 To do → In progress",
    );
  });

  it("falls back to 'updated' when the payload has no recognisable statuses", () => {
    expect(describeMove(event({ taskId: 2, actor: "human:ana", payload: {} }))).toBe("ana updated #2");
  });
});
