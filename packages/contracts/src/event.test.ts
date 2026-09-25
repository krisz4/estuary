import { describe, expect, it } from "vitest";
import {
  EVENTS_DEFAULT_LIMIT,
  EVENTS_MAX_LIMIT,
  eventsQuerySchema,
  eventsResponseSchema,
  TASK_EVENT_TYPES,
} from "./event.js";
import { TASK_ID_MAX_DIGITS } from "./reference.js";

const event = {
  id: 101,
  taskId: 42,
  type: "task.status_changed",
  actor: "agent:claude-code",
  payload: { from: "in_progress", to: "needs_qa", note: "Added the MCP tools." },
  createdAt: "2026-09-20T10:00:00.000Z",
};

describe("eventsQuerySchema", () => {
  it("defaults the limit and leaves the cursor absent", () => {
    expect(eventsQuerySchema.parse({})).toEqual({ limit: EVENTS_DEFAULT_LIMIT });
    expect(EVENTS_DEFAULT_LIMIT).toBe(50);
  });

  it("parses after and taskId from query strings", () => {
    expect(eventsQuerySchema.parse({ after: "100", taskId: "42" })).toEqual({
      after: 100,
      taskId: 42,
      limit: EVENTS_DEFAULT_LIMIT,
    });
  });

  it("accepts after=0 — start from the beginning of the feed", () => {
    expect(eventsQuerySchema.parse({ after: "0" }).after).toBe(0);
  });

  // Digits only, like every other id parser: a coerced cursor would accept
  // `0x2a` and `1e3` and hand a poller events it did not ask for.
  it.each(["abc", "-1", "1.5", "0x2a", "1e3", " 12 ", "9".repeat(TASK_ID_MAX_DIGITS + 1)])(
    "rejects the cursor %j, naming the field",
    (after) => {
      const result = eventsQuerySchema.safeParse({ after });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["after"]);
    },
  );

  it("rejects a malformed taskId the same way", () => {
    expect(eventsQuerySchema.safeParse({ taskId: "TASK-42" }).success).toBe(false);
  });

  it(`accepts limit up to ${EVENTS_MAX_LIMIT} and rejects beyond, rather than clamping`, () => {
    expect(eventsQuerySchema.parse({ limit: String(EVENTS_MAX_LIMIT) }).limit).toBe(
      EVENTS_MAX_LIMIT,
    );
    expect(eventsQuerySchema.parse({ limit: "1" }).limit).toBe(1);

    for (const limit of ["0", String(EVENTS_MAX_LIMIT + 1), "1.5", "abc"]) {
      const result = eventsQuerySchema.safeParse({ limit });
      expect(result.success, limit).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["limit"]);
    }
  });

  it("rejects unknown params, including page-style paging", () => {
    expect(eventsQuerySchema.safeParse({ page: "2" }).success).toBe(false);
    expect(eventsQuerySchema.safeParse({ type: "task.created" }).success).toBe(false);
  });
});

describe("eventsResponseSchema", () => {
  it("accepts a page of events with a cursor", () => {
    const response = { data: [event], meta: { nextAfter: 101, hasMore: false } };
    expect(eventsResponseSchema.parse(response)).toEqual(response);
  });

  it("accepts an empty feed with nextAfter 0", () => {
    const response = { data: [], meta: { nextAfter: 0, hasMore: false } };
    expect(eventsResponseSchema.parse(response)).toEqual(response);
  });

  it("accepts a system: actor — auto-unblocks are written by the server", () => {
    const unblock = {
      ...event,
      actor: "system:taskmanager",
      payload: { from: "blocked", to: "todo", note: null },
    };
    expect(
      eventsResponseSchema.safeParse({ data: [unblock], meta: { nextAfter: 101, hasMore: false } })
        .success,
    ).toBe(true);
  });

  it.each(TASK_EVENT_TYPES)("accepts the event type %s", (type) => {
    expect(
      eventsResponseSchema.safeParse({
        data: [{ ...event, type }],
        meta: { nextAfter: event.id, hasMore: false },
      }).success,
    ).toBe(true);
  });

  it("rejects page-style meta — a cursor feed has no total", () => {
    const result = eventsResponseSchema.safeParse({
      data: [],
      meta: { nextAfter: 0, hasMore: false, page: 1, total: 0 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown event type, a negative cursor, and a non-object payload", () => {
    const meta = { nextAfter: 101, hasMore: false };
    expect(
      eventsResponseSchema.safeParse({ data: [{ ...event, type: "task.exploded" }], meta }).success,
    ).toBe(false);
    expect(
      eventsResponseSchema.safeParse({ data: [], meta: { nextAfter: -1, hasMore: false } }).success,
    ).toBe(false);
    expect(
      eventsResponseSchema.safeParse({ data: [{ ...event, payload: [] }], meta }).success,
    ).toBe(false);
  });
});
