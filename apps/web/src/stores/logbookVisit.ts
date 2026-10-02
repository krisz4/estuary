import { useEffect, useState } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { safeStorage } from "@/stores/safeStorage";

/**
 * The Logbook's "since you left" timestamp.
 *
 * Per-machine, not shareable — like `taskView` and `projectScope`, this is not
 * a fact of the data, it is a fact of "this browser last looked at 14:02". It
 * persists to `localStorage` so the summary survives a reload and a next-day
 * visit, which is exactly when it is most useful.
 *
 * ## Read then write, not read-and-write
 *
 * `useLastVisit()` captures the *previous* visit once, on mount, and holds it
 * in a ref for the lifetime of the page — the summary is "since you were last
 * here", and updating the stored timestamp as soon as it is read would make
 * every render see "now" and the summary would always read empty. The store is
 * advanced to "now" only when the page unmounts (the user navigates away),
 * which is the moment a *next* visit's "since you left" should measure from.
 */
export const LOGBOOK_VISIT_STORAGE_KEY = "estuary.logbookVisit";

/**
 * The floor on how recent "since you left" is allowed to read. A visit only
 * minutes ago (a reload, a second tab, `pnpm dev` hot-reloading the page)
 * makes the summary — correctly — report almost nothing, which reads as
 * broken ("Nothing new since your last visit") rather than as "you really
 * were just here". Flooring the lookback at 12h keeps the sentence non-empty
 * for any real return-to-the-app visit while still measuring from the real
 * timestamp once it is more than 12h old.
 */
export const LOGBOOK_VISIT_MIN_LOOKBACK_MS = 12 * 60 * 60 * 1000;

export type LogbookVisitState = {
  /** ISO timestamp of the last time the Logbook was open, or `null` before the first visit. */
  lastVisitAt: string | null;
  recordVisit: (at: string) => void;
};

export const useLogbookVisitStore = create<LogbookVisitState>()(
  persist(
    (set) => ({
      lastVisitAt: null,
      recordVisit: (at) => set({ lastVisitAt: at }),
    }),
    {
      name: LOGBOOK_VISIT_STORAGE_KEY,
      storage: createJSONStorage(() => safeStorage),
      merge: (persisted, current) => {
        const raw = (persisted as Partial<LogbookVisitState> | undefined)?.lastVisitAt;
        const valid = typeof raw === "string" && !Number.isNaN(Date.parse(raw));
        return { ...current, lastVisitAt: valid ? raw! : null };
      },
    },
  ),
);

/**
 * The timestamp to compute "since you left" from — frozen at mount — and the
 * effect that advances the store to now on unmount, ready for the next visit.
 *
 * `useState`'s lazy initializer, not a ref: a ref's `.current` must not be read
 * during render (it is not a rendering value), whereas state captured once at
 * mount and never set again is exactly "frozen at mount" without that hazard.
 */
export const useLastVisit = (): string | null => {
  const [frozen] = useState<string | null>(() => {
    const stored = useLogbookVisitStore.getState().lastVisitAt;
    if (stored === null) return null;
    // Floor the lookback at `LOGBOOK_VISIT_MIN_LOOKBACK_MS` — see its doc
    // comment — rather than trusting a too-recent stored timestamp verbatim.
    const floor = Date.now() - LOGBOOK_VISIT_MIN_LOOKBACK_MS;
    return Date.parse(stored) > floor ? new Date(floor).toISOString() : stored;
  });

  useEffect(() => {
    // Advance the store to "now" on unmount (navigating away) *or* `pagehide`
    // (closing the tab/reloading, which does not reliably unmount React
    // first) — either is "the user is done with this visit", and either one
    // firing is enough; recording twice in a row is harmless.
    const recordNow = () => useLogbookVisitStore.getState().recordVisit(new Date().toISOString());
    window.addEventListener("pagehide", recordNow);
    return () => {
      window.removeEventListener("pagehide", recordNow);
      recordNow();
    };
  }, []);

  return frozen;
};

/** For tests. */
export const resetLogbookVisitStore = (): void => {
  useLogbookVisitStore.setState({ lastVisitAt: null });
  safeStorage.removeItem(LOGBOOK_VISIT_STORAGE_KEY);
};
