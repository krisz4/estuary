import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TASK_VIEW_STORAGE_KEY,
  resetTaskViewStore,
  taskViewFromPathname,
  taskViewPath,
  useTaskViewStore,
} from "@/stores/taskView";

/**
 * The store itself. The behaviour that matters to a user — "back" going to the
 * board — is asserted end to end in `TasksBoardPage.test.tsx`; these cover the
 * two things that file cannot see: what reaches `localStorage`, and what happens
 * when what comes back out of it is not a view.
 *
 * `resetTaskViewStore` runs in `vitest.setup.ts`'s global `afterEach`, so each
 * case here starts from the default.
 */
describe("taskViewPath", () => {
  it("maps each view to its route", () => {
    expect(taskViewPath("list")).toBe("/tasks");
    expect(taskViewPath("board")).toBe("/tasks/board");
  });
});

describe("taskViewFromPathname", () => {
  it.each([
    ["/tasks", "list"],
    ["/tasks/board", "board"],
  ])("reads %s as the %s view", (pathname, view) => {
    expect(taskViewFromPathname(pathname)).toBe(view);
  });

  it.each(["/tasks/42", "/tasks/new", "/tasks/42/edit", "/", "/tasks/board/x"])(
    "does not claim %s is a view",
    (pathname) => {
      expect(taskViewFromPathname(pathname)).toBeUndefined();
    },
  );
});

/**
 * An in-memory `Storage`, installed for the persistence cases.
 *
 * This environment has **no working `localStorage`**: `window.localStorage` is
 * an object whose `getItem` is not a function, so every call through it throws
 * a `TypeError` that the store's `safeStorage` swallows. That is the correct
 * behaviour and is asserted below — but it also means the persistence path is
 * unobservable without a stub, and testing "nothing was stored" against an
 * environment that can store nothing proves nothing.
 */
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

const installStorage = (storage: Storage | undefined): void => {
  Object.defineProperty(window, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
};

describe("useTaskViewStore", () => {
  beforeEach(() => {
    installStorage(memoryStorage());
  });

  afterEach(() => {
    if (originalStorage === undefined) return;
    Object.defineProperty(window, "localStorage", originalStorage);
  });

  it("starts on the list", () => {
    expect(useTaskViewStore.getState().view).toBe("list");
  });

  it("persists the chosen view", () => {
    useTaskViewStore.getState().setView("board");

    expect(useTaskViewStore.getState().view).toBe("board");
    expect(window.localStorage.getItem(TASK_VIEW_STORAGE_KEY)).toContain("board");
  });

  /*
    `setState` compares with `Object.is`, so returning the current state object
    for a no-op set is what keeps a re-mount of the same page from waking every
    subscriber. Asserted through the subscription rather than the value, because
    the value is identical either way — that is the whole point.
  */
  it("does not notify subscribers when the view is set to what it already is", () => {
    const seen: string[] = [];
    const unsubscribe = useTaskViewStore.subscribe((state) => seen.push(state.view));

    useTaskViewStore.getState().setView("board");
    useTaskViewStore.getState().setView("board");
    unsubscribe();

    expect(seen).toEqual(["board"]);
  });

  /*
    `localStorage` is writable by anything on the origin and outlives a deploy
    that renames a view, so a stored value that is not one must not become a
    `to` prop pointing at a route that no longer exists.
  */
  it.each(['{"state":{"view":"kanban"},"version":0}', '{"state":{"view":7}}', "not json"])(
    "falls back to the list when the stored value is %s",
    (stored) => {
      window.localStorage.setItem(TASK_VIEW_STORAGE_KEY, stored);

      useTaskViewStore.persist.rehydrate();

      expect(useTaskViewStore.getState().view).toBe("list");
    },
  );

  it("rehydrates a valid stored view", () => {
    window.localStorage.setItem(
      TASK_VIEW_STORAGE_KEY,
      JSON.stringify({ state: { view: "board" }, version: 0 }),
    );

    useTaskViewStore.persist.rehydrate();

    expect(useTaskViewStore.getState().view).toBe("board");
  });

  it("clears both halves on reset", () => {
    useTaskViewStore.getState().setView("board");

    resetTaskViewStore();

    expect(useTaskViewStore.getState().view).toBe("list");
    expect(window.localStorage.getItem(TASK_VIEW_STORAGE_KEY)).toBeNull();
  });

  /*
    Private browsing and sandboxed iframes throw on every `localStorage` access
    — as, incidentally, does this test environment. The preference is then
    simply not remembered; it is never a reason for a render to fail.
  */
  it("keeps working when storage throws", () => {
    installStorage(
      new Proxy({} as Storage, {
        get() {
          throw new DOMException("denied", "SecurityError");
        },
      }),
    );

    expect(() => useTaskViewStore.getState().setView("board")).not.toThrow();
    expect(useTaskViewStore.getState().view).toBe("board");
    expect(() => useTaskViewStore.persist.rehydrate()).not.toThrow();
  });
});
