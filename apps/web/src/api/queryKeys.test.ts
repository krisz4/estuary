import { describe, expect, it } from "vitest";
import { queryKeys } from "@/api/queryKeys";

/**
 * The property that matters is **prefix containment**: partial invalidation in
 * TanStack Query works by prefix match, so `invalidateQueries({ queryKey:
 * queryKeys.tickets.all })` only reaches a list key if that key literally starts
 * with the `all` key. Asserting the literal arrays would pass while the
 * hierarchy was broken; asserting containment is what actually holds.
 */
const startsWith = (key: readonly unknown[], prefix: readonly unknown[]): boolean =>
  prefix.every((segment, index) => Object.is(key[index], segment));

describe("queryKeys.tickets", () => {
  const all = queryKeys.tickets.all;

  it("nests every key under tickets.all", () => {
    const keys = [
      queryKeys.tickets.lists(),
      queryKeys.tickets.list({ page: 2 }),
      queryKeys.tickets.details(),
      queryKeys.tickets.detail(42),
      queryKeys.tickets.facets(),
    ];

    for (const key of keys) {
      expect(
        startsWith(key, all),
        `${JSON.stringify(key)} is not under ${JSON.stringify(all)}`,
      ).toBe(true);
    }
  });

  it("nests a specific list under lists() and a specific detail under details()", () => {
    expect(startsWith(queryKeys.tickets.list({ page: 2 }), queryKeys.tickets.lists())).toBe(true);
    expect(startsWith(queryKeys.tickets.detail(42), queryKeys.tickets.details())).toBe(true);
  });

  it("keeps lists and details in separate branches", () => {
    // Otherwise invalidating one silently refetches the other — cheap here, but
    // it is the shape that lets a comment write blow away every list page.
    expect(startsWith(queryKeys.tickets.detail(42), queryKeys.tickets.lists())).toBe(false);
    expect(startsWith(queryKeys.tickets.list({}), queryKeys.tickets.details())).toBe(false);
    expect(startsWith(queryKeys.tickets.facets(), queryKeys.tickets.lists())).toBe(false);
  });

  it("gives different params different keys, and different ids different keys", () => {
    expect(queryKeys.tickets.list({ page: 1 })).not.toEqual(queryKeys.tickets.list({ page: 2 }));
    expect(queryKeys.tickets.detail(1)).not.toEqual(queryKeys.tickets.detail(2));
  });
});
