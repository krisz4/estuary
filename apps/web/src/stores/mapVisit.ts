import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { safeStorage } from "@/stores/safeStorage";

/**
 * The Map's own "since you left" timestamp — separate from the Logbook's
 * (`stores/logbookVisit.ts`), so opening one page does not reset the other's
 * briefing window. Same per-machine, persisted-to-`localStorage` shape as
 * `taskView`/`projectScope`/`logbookVisit`.
 *
 * ## The write timing bug this fixes
 *
 * `logbookVisit.ts`'s `useLastVisit()` records "now" from a `useEffect`
 * cleanup, which runs on a real unmount — **and** on React's `StrictMode`
 * double-invoke in dev (mount → effect → cleanup → mount again), which fires
 * synchronously, in the same tick as the first mount. That wrote "now" to
 * storage before the page had been open long enough to mean anything, and the
 * very next render read it back as "since 37 seconds ago" — the briefing had
 * nothing to summarise and the tide scrubber's range collapsed to almost
 * nothing.
 *
 * `useMapLastVisit()` guards against exactly that: the cleanup only commits a
 * new visit timestamp if the component has been mounted for a meaningful
 * amount of wall-clock time (`MIN_MOUNT_MS`). `StrictMode`'s synthetic
 * cleanup fires in the same tick it mounted; a real departure — navigating
 * away, closing the tab — is always measurably later.
 */
export const MAP_VISIT_STORAGE_KEY = "estuary.mapVisit";

export type MapVisitState = {
  lastVisitAt: string | null;
  recordVisit: (at: string) => void;
};

export const useMapVisitStore = create<MapVisitState>()(
  persist(
    (set) => ({
      lastVisitAt: null,
      recordVisit: (at) => set({ lastVisitAt: at }),
    }),
    {
      name: MAP_VISIT_STORAGE_KEY,
      storage: createJSONStorage(() => safeStorage),
      merge: (persisted, current) => {
        const raw = (persisted as Partial<MapVisitState> | undefined)?.lastVisitAt;
        const valid = typeof raw === "string" && !Number.isNaN(Date.parse(raw));
        return { ...current, lastVisitAt: valid ? raw! : null };
      },
    },
  ),
);

/** Below this, a cleanup is assumed to be `StrictMode`'s synthetic double-invoke, not a real departure. */
const MIN_MOUNT_MS = 50;

/**
 * The timestamp to compute "since you left" from — frozen at mount — and the
 * effect that advances the store to now when the page is really left.
 */
export const useMapLastVisit = (): string | null => {
  const [frozen] = useState<string | null>(() => useMapVisitStore.getState().lastVisitAt);
  const mountedAtRef = useRef(0);

  useEffect(() => {
    mountedAtRef.current = Date.now();
    return () => {
      if (Date.now() - mountedAtRef.current < MIN_MOUNT_MS) return;
      useMapVisitStore.getState().recordVisit(new Date().toISOString());
    };
  }, []);

  return frozen;
};

/** For tests — the store is a module singleton and `localStorage` outlives `cleanup()`. */
export const resetMapVisitStore = (): void => {
  useMapVisitStore.setState({ lastVisitAt: null });
  safeStorage.removeItem(MAP_VISIT_STORAGE_KEY);
};
