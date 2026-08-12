import { useEffect } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * Which of the two ticket screens the user last looked at — list or board.
 *
 * ## Why this is a store and not URL state
 *
 * Everything else about the list *is* URL state (`useTicketListParams`), and
 * that rule is not being relaxed here: filters, sort and page describe **what**
 * is on screen and have to survive being pasted into someone else's browser.
 * The chosen view is a different kind of fact. It is not a property of the
 * tickets being shown, it is a property of *this user on this machine*, and the
 * screens that need it — detail, create, edit — have no URL of their own to
 * keep it in.
 *
 * The evidence is the bug this fixes: `/tickets/board` → open a ticket → **Back
 * to tickets** landed on `/tickets`. The board's path was known only to the
 * board's own URL, and the moment the user navigated away from it that fact was
 * gone. `location.state.from` carries the *search string* across that hop but
 * not the pathname, and widening it would not help: `state` is dropped on a
 * pasted link and on a reload into a fresh entry, which is exactly when a
 * remembered preference is most useful.
 *
 * ## Why it persists
 *
 * A user who works out of the board expects to still be in the board tomorrow.
 * `localStorage`, keyed like the theme preference (`lib/theme.ts`), which is the
 * other setting of this shape.
 *
 * ## Who writes it
 *
 * Only the two view screens, through `useRememberTicketView`, on mount. Not
 * `ViewSwitch`'s click handler: a click is one of several ways to arrive
 * (pasted URL, back button, bookmark), and recording arrival rather than intent
 * means every one of them agrees. The store follows the URL; it never drives
 * it.
 */

export const TICKET_VIEWS = ["list", "board"] as const;
export type TicketView = (typeof TICKET_VIEWS)[number];

export const TICKET_VIEW_STORAGE_KEY = "helpdesk.ticketView";

const isTicketView = (value: unknown): value is TicketView =>
  typeof value === "string" && (TICKET_VIEWS as readonly string[]).includes(value);

/** The route each view lives at. The one place the two paths are spelled. */
export const ticketViewPath = (view: TicketView): string =>
  view === "board" ? "/tickets/board" : "/tickets";

/** The view a pathname *is*, or `undefined` for every other screen. */
export const ticketViewFromPathname = (pathname: string): TicketView | undefined => {
  if (pathname === "/tickets/board") return "board";
  if (pathname === "/tickets") return "list";
  return undefined;
};

/**
 * `localStorage` throws in a sandboxed iframe and in some privacy modes — the
 * same guard `lib/theme.ts` documents. A preference that cannot be stored must
 * degrade to "not remembered", never to a render that throws.
 */
const safeStorage: Storage = {
  get length() {
    try {
      return window.localStorage.length;
    } catch {
      return 0;
    }
  },
  key: (index) => {
    try {
      return window.localStorage.key(index);
    } catch {
      return null;
    }
  },
  clear: () => {
    try {
      window.localStorage.clear();
    } catch {
      /* ignored */
    }
  },
  getItem: (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* ignored */
    }
  },
  removeItem: (key) => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignored */
    }
  },
};

export type TicketViewState = {
  view: TicketView;
  setView: (view: TicketView) => void;
};

export const useTicketViewStore = create<TicketViewState>()(
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
      name: TICKET_VIEW_STORAGE_KEY,
      storage: createJSONStorage(() => safeStorage),

      /*
        The stored value is validated, not trusted. `localStorage` is writable
        by anything running on the origin and survives a deploy that renames a
        view, so a stale or hand-edited `"kanban"` must not become a `to` prop
        pointing at a route that does not exist.
      */
      merge: (persisted, current) => {
        const view = (persisted as Partial<TicketViewState> | undefined)?.view;
        return { ...current, view: isTicketView(view) ? view : current.view };
      },
    },
  ),
);

/** The remembered view. The read half of the store, for components. */
export const useTicketView = (): TicketView => useTicketViewStore((state) => state.view);

/**
 * Records that this screen is the current view. Called by the list and board
 * pages; see the note above on why it is mount-driven rather than click-driven.
 */
export const useRememberTicketView = (view: TicketView): void => {
  useEffect(() => {
    useTicketViewStore.getState().setView(view);
  }, [view]);
};

/**
 * Drops the remembered view back to the default.
 *
 * For tests: the store is a module singleton and `localStorage` outlives a
 * `cleanup()`, so without this the view chosen by one test leaks into the next
 * one in the same file.
 */
export const resetTicketViewStore = (): void => {
  useTicketViewStore.setState({ view: "list" });
  safeStorage.removeItem(TICKET_VIEW_STORAGE_KEY);
};
