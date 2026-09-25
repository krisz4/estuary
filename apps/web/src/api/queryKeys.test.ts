import { describe, expect, it } from "vitest";
import { queryKeys } from "@/api/queryKeys";

/**
 * The property that matters is **prefix containment**: partial invalidation in
 * TanStack Query works by prefix match, so `invalidateQueries({ queryKey:
 * queryKeys.tasks.all })` only reaches a list key if that key literally starts
 * with the `all` key. Asserting the literal arrays would pass while the
 * hierarchy was broken; asserting containment is what actually holds.
 */
const startsWith = (key: readonly unknown[], prefix: readonly unknown[]): boolean =>
  prefix.every((segment, index) => Object.is(key[index], segment));

describe("queryKeys.tasks", () => {
  const all = queryKeys.tasks.all;

  it("nests every key under tasks.all", () => {
    const keys = [
      queryKeys.tasks.lists(),
      queryKeys.tasks.list({ page: 2 }),
      queryKeys.tasks.details(),
      queryKeys.tasks.detail(42),
      queryKeys.tasks.facets(),
      queryKeys.tasks.stats(),
    ];

    for (const key of keys) {
      expect(
        startsWith(key, all),
        `${JSON.stringify(key)} is not under ${JSON.stringify(all)}`,
      ).toBe(true);
    }
  });

  it("nests a specific list under lists() and a specific detail under details()", () => {
    expect(startsWith(queryKeys.tasks.list({ page: 2 }), queryKeys.tasks.lists())).toBe(true);
    expect(startsWith(queryKeys.tasks.detail(42), queryKeys.tasks.details())).toBe(true);
  });

  it("keeps lists and details in separate branches", () => {
    // Otherwise invalidating one silently refetches the other — cheap here, but
    // it is the shape that lets a comment write blow away every list page.
    expect(startsWith(queryKeys.tasks.detail(42), queryKeys.tasks.lists())).toBe(false);
    expect(startsWith(queryKeys.tasks.list({}), queryKeys.tasks.details())).toBe(false);
    expect(startsWith(queryKeys.tasks.facets(), queryKeys.tasks.lists())).toBe(false);
  });

  it("gives different params different keys, and different ids different keys", () => {
    expect(queryKeys.tasks.list({ page: 1 })).not.toEqual(queryKeys.tasks.list({ page: 2 }));
    expect(queryKeys.tasks.detail(1)).not.toEqual(queryKeys.tasks.detail(2));
  });
});

describe("queryKeys.events", () => {
  it("nests one task's timeline under events.all", () => {
    expect(startsWith(queryKeys.events.task(42), queryKeys.events.all)).toBe(true);
  });

  /*
    Deliberately *not* under `tasks.all`: a task write invalidates the events
    explicitly, and an unrelated `tasks.all` invalidation (an edit-form save on
    another task) must not refetch every open timeline.
  */
  it("lives outside the tasks tree", () => {
    expect(startsWith(queryKeys.events.task(42), queryKeys.tasks.all)).toBe(false);
  });

  it("gives different tasks different timelines", () => {
    expect(queryKeys.events.task(1)).not.toEqual(queryKeys.events.task(2));
  });
});
