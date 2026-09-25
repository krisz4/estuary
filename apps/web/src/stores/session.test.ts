import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SESSION_STORAGE_KEY,
  actorFromDisplayName,
  resetSessionStore,
  sessionHeaders,
  useSessionStore,
} from "@/stores/session";

/**
 * The session store: who this browser writes as, and the API token. What goes
 * on the wire is asserted in `api/http.test.ts`; these cover the derivation and
 * what reaches — and comes back out of — `localStorage`.
 */

describe("actorFromDisplayName", () => {
  it.each([
    ["Krisz", "human:krisz"],
    ["  Krisz Tian  ", "human:krisz-tian"],
    ["dana@example.com", "human:dana@example.com"],
  ])("turns %j into %s", (name, actor) => {
    expect(actorFromDisplayName(name)).toBe(actor);
  });

  it.each(["", "   ", "!!!"])("is null for %j, so no header is sent", (name) => {
    expect(actorFromDisplayName(name)).toBeNull();
  });
});

describe("sessionHeaders", () => {
  it("is empty when nothing is set", () => {
    expect(sessionHeaders({ displayName: "", apiToken: "" })).toEqual({});
  });

  it("carries both when both are set", () => {
    expect(sessionHeaders({ displayName: "Krisz", apiToken: "t0ken" })).toEqual({
      "X-Actor": "human:krisz",
      Authorization: "Bearer t0ken",
    });
  });
});

/** An in-memory `Storage` — see `taskView.test.ts` for why one is needed here. */
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

describe("useSessionStore", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      value: memoryStorage(),
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    resetSessionStore();
    if (originalStorage !== undefined) {
      Object.defineProperty(window, "localStorage", originalStorage);
    }
  });

  it("persists the name and token, trimmed — and nothing transient", () => {
    const store = useSessionStore.getState();
    store.setDialogOpen(true);
    store.reportUnauthorized();
    store.save({ displayName: " Krisz ", apiToken: " t0ken " });

    const stored = JSON.parse(window.localStorage.getItem(SESSION_STORAGE_KEY) ?? "{}") as {
      state: Record<string, unknown>;
    };
    expect(stored.state).toEqual({ displayName: "Krisz", apiToken: "t0ken" });
  });

  it("clears the 401 flag and closes the dialog on save", () => {
    const store = useSessionStore.getState();
    store.setDialogOpen(true);
    store.reportUnauthorized();

    store.save({ displayName: "", apiToken: "new" });

    expect(useSessionStore.getState()).toMatchObject({ unauthorized: false, isDialogOpen: false });
  });

  it("does not notify subscribers for a 401 it already knows about", () => {
    let notified = 0;
    const unsubscribe = useSessionStore.subscribe(() => {
      notified += 1;
    });

    useSessionStore.getState().reportUnauthorized();
    useSessionStore.getState().reportUnauthorized();
    unsubscribe();

    expect(notified).toBe(1);
  });

  it("ignores stored values that are not strings", () => {
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ state: { displayName: 7, apiToken: { a: 1 } }, version: 0 }),
    );

    void useSessionStore.persist.rehydrate();

    expect(useSessionStore.getState()).toMatchObject({ displayName: "", apiToken: "" });
  });

  it("rehydrates valid stored values", () => {
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ state: { displayName: "Dana", apiToken: "t" }, version: 0 }),
    );

    void useSessionStore.persist.rehydrate();

    expect(useSessionStore.getState()).toMatchObject({ displayName: "Dana", apiToken: "t" });
  });
});
