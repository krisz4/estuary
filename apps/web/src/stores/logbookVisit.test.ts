import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOGBOOK_VISIT_STORAGE_KEY,
  resetLogbookVisitStore,
  useLogbookVisitStore,
} from "@/stores/logbookVisit";

/** See `taskView.test.ts` for why a real `localStorage` needs stubbing here. */
const memoryStorage = (): Storage => {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    key: (index) => [...entries.keys()][index] ?? null,
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  };
};

const originalStorage = Object.getOwnPropertyDescriptor(window, "localStorage");

describe("useLogbookVisitStore", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      value: memoryStorage(),
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    if (originalStorage === undefined) return;
    Object.defineProperty(window, "localStorage", originalStorage);
  });

  it("starts with no recorded visit", () => {
    expect(useLogbookVisitStore.getState().lastVisitAt).toBeNull();
  });

  it("records a visit", () => {
    useLogbookVisitStore.getState().recordVisit("2026-09-26T12:00:00.000Z");
    expect(useLogbookVisitStore.getState().lastVisitAt).toBe("2026-09-26T12:00:00.000Z");
  });

  it.each(['{"state":{"lastVisitAt":7}}', '{"state":{"lastVisitAt":"not a date"}}', "not json"])(
    "falls back to null when the stored value is %s",
    (stored) => {
      window.localStorage.setItem(LOGBOOK_VISIT_STORAGE_KEY, stored);
      useLogbookVisitStore.persist.rehydrate();
      expect(useLogbookVisitStore.getState().lastVisitAt).toBeNull();
    },
  );

  it("rehydrates a valid stored timestamp", () => {
    window.localStorage.setItem(
      LOGBOOK_VISIT_STORAGE_KEY,
      JSON.stringify({ state: { lastVisitAt: "2026-09-20T00:00:00.000Z" }, version: 0 }),
    );
    useLogbookVisitStore.persist.rehydrate();
    expect(useLogbookVisitStore.getState().lastVisitAt).toBe("2026-09-20T00:00:00.000Z");
  });

  it("clears on reset", () => {
    useLogbookVisitStore.getState().recordVisit("2026-09-26T12:00:00.000Z");
    resetLogbookVisitStore();
    expect(useLogbookVisitStore.getState().lastVisitAt).toBeNull();
  });
});
