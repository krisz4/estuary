import { useEffect } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { safeStorage } from "@/stores/safeStorage";

/**
 * Which of the two task screens the user last looked at — list or map.
 *
 * ## Why this is a store and not URL state
 *
 * Everything else about the list *is* URL state (`useTaskListParams`), and
 * that rule is not being relaxed here: filters, sort and page describe **what**
 * is on screen and have to survive being pasted into someone else's browser.
 * The chosen view is a different kind of fact. It is not a property of the
 * tasks being shown, it is a property of *this user on this machine*, and the
 * screens that need it — detail, create, edit — have no URL of their own to
 * keep it in.
 *
 * The evidence is the bug this fixes: `/tasks/map` → open a task → **Back
 * to tasks** landed on `/tasks`. The map's path was known only to the map's
 * own URL, and the moment the user navigated away from it that fact was
 * gone. `location.state.from` carries the *search string* across that hop but
 * not the pathname, and widening it would not help: `state` is dropped on a
 * pasted link and on a reload into a fresh entry, which is exactly when a
 * remembered preference is most useful.
 *
 * ## Why it persists
 *
 * A user who works out of the map expects to still be there tomorrow.
 * `localStorage`, keyed like the theme preference (`lib/theme.ts`), which is the
 * other setting of this shape.
 *
 * ## Who writes it
 *
 * Only the two view screens, through `useRememberTaskView`, on mount. Not
 * `ViewSwitch`'s click handler: a click is one of several ways to arrive
 * (pasted URL, back button, bookmark), and recording arrival rather than intent
 * means every one of them agrees. The store follows the URL; it never drives
 * it.
 *
 * ## `"board"` migration
 *
 * The Kanban board was retired in favor of the Estuary map view. A value of
 * `"board"` already sitting in a returning user's `localStorage` is not an
 * invalid value to fall back from — it is the direct predecessor of `"map"`
 * — so it is migrated to `"map"`, not to the default `"list"`.
 */

export const TASK_VIEWS = ["list", "map"] as const;
export type TaskView = (typeof TASK_VIEWS)[number];

export const TASK_VIEW_STORAGE_KEY = "estuary.taskView";

const isTaskView = (value: unknown): value is TaskView =>
  typeof value === "string" && (TASK_VIEWS as readonly string[]).includes(value);

/** The route each view lives at. The one place the two paths are spelled. */
export const taskViewPath = (view: TaskView): string => {
  if (view === "map") return "/tasks/map";
  return "/tasks";
};

/** The view a pathname *is*, or `undefined` for every other screen. `/tasks/floor` and `/tasks/board` redirect to `/tasks/map` at the router, so they are never pathnames this sees. */
export const taskViewFromPathname = (pathname: string): TaskView | undefined => {
  if (pathname === "/tasks/map") return "map";
  if (pathname === "/tasks") return "list";
  return undefined;
};

export type TaskViewState = {
  view: TaskView;
  setView: (view: TaskView) => void;
};

export const useTaskViewStore = create<TaskViewState>()(
  persist(
    (set) => ({
      view: "list",

      // Returning the current state object unchanged is how zustand is told
      // "nothing happened": `setState` compares with `Object.is` and skips the
      // notification, so re-mounting the list page does not re-render every
      // subscriber for a value that did not move.
      setView: (view) => set((state) => (state.view === view ? state : { view })),
    }),
    {
      name: TASK_VIEW_STORAGE_KEY,
      storage: createJSONStorage(() => safeStorage),

      /*
        The stored value is validated, not trusted. `localStorage` is writable
        by anything running on the origin and survives a deploy that renames a
        view, so a stale or hand-edited `"kanban"` must not become a `to` prop
        pointing at a route that does not exist.
      */
      merge: (persisted, current) => {
        const stored: unknown = (persisted as { view?: unknown } | undefined)?.view;
        // A pre-migration "board" value is the direct predecessor of "map",
        // not an invalid value to fall back from — send it to "map", not "list".
        const view: unknown = stored === "board" ? "map" : stored;
        return { ...current, view: isTaskView(view) ? view : current.view };
      },
    },
  ),
);

/** The remembered view. The read half of the store, for components. */
export const useTaskView = (): TaskView => useTaskViewStore((state) => state.view);

/**
 * Records that this screen is the current view. Called by the list and map
 * pages; see the note above on why it is mount-driven rather than click-driven.
 */
export const useRememberTaskView = (view: TaskView): void => {
  useEffect(() => {
    useTaskViewStore.getState().setView(view);
  }, [view]);
};

/**
 * Drops the remembered view back to the default.
 *
 * For tests: the store is a module singleton and `localStorage` outlives a
 * `cleanup()`, so without this the view chosen by one test leaks into the next
 * one in the same file.
 */
export const resetTaskViewStore = (): void => {
  useTaskViewStore.setState({ view: "list" });
  safeStorage.removeItem(TASK_VIEW_STORAGE_KEY);
};
