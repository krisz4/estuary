import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listEvents } from "@/api/events";
import { queryKeys } from "@/api/queryKeys";
import { planLiveAnimations, type LiveAnimationPlan } from "@/features/floor/liveMotion";

const POLL_MS = 5000;

export type UseLiveMotionOptions = {
  /** `snapshot.meta.lastEventId` — the cursor to poll forward from. */
  lastEventId: number;
  project: readonly string[];
  /** `false` while replaying (`?at=` set) or on first load (no snapshot yet). */
  enabled: boolean;
  reducedMotion: boolean;
  /** Called with whatever should animate — a no-op renderer is a valid caller until the canvas side lands (see `liveMotion.ts`'s module doc). */
  onPlan?: (plan: LiveAnimationPlan) => void;
};

/**
 * Polls `GET /events?after=` every ~5s while the map is visible and not
 * replaying, and invalidates the floor snapshot whenever new events land —
 * the actual "live" half of live motion. `syncedSecondsAgo` (recomputed on
 * every render, not just every poll, so the hero's "synced Xs ago" line
 * counts up smoothly) is for the caller's own status line.
 *
 * A poll makes no attempt to keep a bead's *animated* position steady across
 * the refetch it triggers — see `liveMotion.ts`'s module doc for why the
 * actual canvas animation is a tracked follow-up, not built here.
 */
export const useLiveMotion = ({ lastEventId, project, enabled, reducedMotion, onPlan }: UseLiveMotionOptions) => {
  const queryClient = useQueryClient();
  const cursorRef = useRef(lastEventId);
  const [syncedAt, setSyncedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    cursorRef.current = lastEventId;
  }, [lastEventId]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const poll = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const response = await listEvents({
          after: cursorRef.current,
          ...(project.length > 0 ? { project } : {}),
          limit: 100,
        });
        if (cancelled) return;
        setSyncedAt(Date.now());
        if (response.data.length === 0) return;
        cursorRef.current = response.meta.nextAfter;
        onPlan?.(planLiveAnimations(response.data, { reducedMotion }));
        void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      } catch {
        // A failed poll just retries next interval — not worth surfacing as
        // an error state over a background refresh nobody asked to watch.
      }
    };

    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `project`'s identity changes every render (it's a fresh array from URL params); comparing its length/contents here would need a deep-equal dependency this hook doesn't need — a 5s poll picking up a scope change on its next tick, not instantly, is fine.
  }, [enabled, reducedMotion, queryClient, onPlan]);

  // A one-second ticker so "synced Xs ago" counts up in the UI between polls,
  // not just re-renders for other reasons.
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled]);

  return { syncedSecondsAgo: (now - syncedAt) / 1000 };
};
