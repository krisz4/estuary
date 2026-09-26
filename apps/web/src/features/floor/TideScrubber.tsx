import { type TaskEvent } from "@helpdesk/contracts";
import { Pause, Play, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEventLogQuery } from "@/api/events";
import { Button } from "@/components/ui";
import { buildReplaySteps, describeMove, type ReplayStep } from "@/features/floor/replayPlan";
import { cn } from "@/lib/cn";

/**
 * The tide scrubber — phase 6 replay. Unlike the prototype (which simulates a
 * fake night locally), this drives a **real** `GET /floor?at=` refetch: the
 * scrubber only ever produces an `at` ISO string (or `undefined` for "now"),
 * debounced onto the URL; the caller re-queries the snapshot for whatever `at`
 * comes out.
 *
 * The activity sparkline comes from `GET /events` (`useEventLogQuery`, the
 * same hook the Logbook uses), bucketed client-side into a fixed number of
 * bins across the range — this reads the feed, it does not write to it, so it
 * cannot break the Logbook's own paging.
 *
 * **Replay plays events, not the clock.** Play steps through the range's
 * status changes (`buildReplaySteps`), one snapshot per change and a fixed
 * beat between them, so a quiet stretch costs nothing and a whole day replays
 * in ~20 seconds. The caller animates each step's moves (`onPlayingChange` →
 * `FloorCanvas`'s `animateReplay`) and can warm the next snapshot
 * (`onPrefetch`) so a move lands on the beat instead of after a request.
 */
export type TideScrubberProps = {
  /** The start of the replay window (ISO). */
  rangeStart: string;
  /** `at`, or `undefined` for "now" (live). */
  at: string | undefined;
  onChange: (at: string | undefined) => void;
  project: readonly string[];
  className?: string;
  /** Phone layout: play + time on one (non-wrapping) row, the track full-width on its own row below, "Now" as a small icon button. */
  compact?: boolean;
  /** Tells the caller when playback starts and stops — the map only animates bead travel while replaying if it is playing. */
  onPlayingChange?: (playing: boolean) => void;
  /** Called with the next step's `at` while playing, so the caller can fetch it before it is shown. */
  onPrefetch?: (at: string) => void;
};

const BINS = 28;
const STEP_MIN_MS = 10 * 60_000;
const STEP_HOUR_MS = 60 * 60_000;
/** The beat between two replay steps — long enough for a bead's travel (900–2000ms) to read. */
const PLAY_STEP_MS = 1500;
/** The pause on the "just before" frame, so the rewind to it settles before the first move. */
const PLAY_LEAD_MS = 2000;
/** How long the last step holds before playback hands back to "now". */
const PLAY_HOLD_MS = 2500;
/** A step's "just before" frame sits this far ahead of its first event. */
const BEFORE_STEP_MS = 1000;

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

const fmtClock = (date: Date): string =>
  date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const fmtAgo = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h${rest ? ` ${rest}m` : ""} ago`;
};

export const TideScrubber = ({
  rangeStart,
  at,
  onChange,
  project,
  className,
  compact = false,
  onPlayingChange,
  onPrefetch,
}: TideScrubberProps) => {
  const rangeStartMs = useMemo(() => new Date(rangeStart).getTime(), [rangeStart]);
  // Frozen once, at mount — the scrubber's own notion of "now" should not
  // drift as the component re-renders (a lazy `useState` initializer runs
  // exactly once, unlike a `useRef(Date.now())` argument, which is
  // re-evaluated — impurely — on every render).
  const [nowMs] = useState(() => Date.now());
  const totalMs = Math.max(1, nowMs - rangeStartMs);

  const [scrubbing, setScrubbing] = useState(false);
  const [playing, setPlaying] = useState(false);
  /** Local, un-debounced position — 0 = live. Immediate visual feedback while `at` itself is debounced. */
  const [localPositionMs, setLocalPositionMs] = useState(at === undefined ? 0 : nowMs - new Date(at).getTime());
  const trackRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Re-derive `localPositionMs` from `at`/`totalMs` whenever either changes —
  // adjusted during render (React's documented pattern for resetting state
  // from props: https://react.dev/learn/you-might-not-need-an-effect), rather
  // than in an effect, which would cause an extra commit-then-recommit render
  // for every `at` change instead of one.
  const [syncedFrom, setSyncedFrom] = useState({ at, totalMs });
  if (syncedFrom.at !== at || syncedFrom.totalMs !== totalMs) {
    setSyncedFrom({ at, totalMs });
    setLocalPositionMs(at === undefined ? 0 : clamp(nowMs - new Date(at).getTime(), 0, totalMs));
  }

  const eventsQuery = useEventLogQuery({ project, type: [], from: rangeStart });
  const eventsData = eventsQuery.data?.pages[0]?.data;
  // Stabilize the reference: without this, the `?? []` fallback allocates a
  // new empty array every render while the query has no data yet, which
  // would make every `useMemo` below that depends on `events` recompute on
  // every render instead of only when the data actually changes.
  const events = useMemo<TaskEvent[]>(() => eventsData ?? [], [eventsData]);

  // Status changes get their own read: in the all-types feed above, comments
  // and heartbeats would crowd them out of the first page on a busy day.
  const movesQuery = useEventLogQuery({ project, type: ["task.status_changed"], from: rangeStart });
  const movesData = movesQuery.data?.pages[0]?.data;
  const moves = useMemo<TaskEvent[]>(() => movesData ?? [], [movesData]);
  const steps = useMemo(() => buildReplaySteps(moves, rangeStartMs), [moves, rangeStartMs]);
  const moveCount = useMemo(() => steps.reduce((sum, step) => sum + step.events.length, 0), [steps]);

  // Callers pass these inline, so their identity changes on every parent
  // render. Read them through refs so `commit` — and the playback timer that
  // depends on it — stays stable; otherwise any parent re-render more often
  // than a step restarts the timer before it ever fires.
  const onChangeRef = useRef(onChange);
  const onPrefetchRef = useRef(onPrefetch);
  const onPlayingChangeRef = useRef(onPlayingChange);
  useEffect(() => {
    onChangeRef.current = onChange;
    onPrefetchRef.current = onPrefetch;
    onPlayingChangeRef.current = onPlayingChange;
  }, [onChange, onPrefetch, onPlayingChange]);

  const commit = useCallback(
    (positionMs: number, options: { immediate?: boolean } = {}) => {
      const clamped = clamp(positionMs, 0, totalMs);
      setLocalPositionMs(clamped);
      const next = clamped < 30_000 ? undefined : new Date(nowMs - clamped).toISOString();
      if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
      if (options.immediate) {
        onChangeRef.current(next);
      } else {
        debounceRef.current = setTimeout(() => onChangeRef.current(next), 220);
      }
    },
    [totalMs, nowMs],
  );

  /** The step playback shows next, and the one on screen (for the caption) — `null` before the first. */
  const nextStepRef = useRef(0);
  const firstDelayRef = useRef(PLAY_STEP_MS);
  const [shownStep, setShownStep] = useState<ReplayStep | null>(null);

  const positionOf = useCallback((ms: number) => nowMs - ms, [nowMs]);
  const prefetchStep = useCallback(
    (step: ReplayStep | undefined) => {
      if (step !== undefined) onPrefetchRef.current?.(new Date(step.atMs).toISOString());
    },
    [],
  );

  useEffect(() => {
    onPlayingChangeRef.current?.(playing);
  }, [playing]);

  // Playback: a timer chain, one step per beat. Each step writes the instant
  // of its last event, so the snapshot shows exactly that change applied; the
  // canvas's layout diff turns the difference into bead travel.
  useEffect(() => {
    if (!playing) return;
    let id: ReturnType<typeof setTimeout>;
    const tick = () => {
      const index = nextStepRef.current;
      const step = steps[index];
      if (step === undefined) {
        setPlaying(false);
        setShownStep(null);
        commit(0, { immediate: true });
        return;
      }
      commit(positionOf(step.atMs), { immediate: true });
      setShownStep(step);
      prefetchStep(steps[index + 1]);
      nextStepRef.current = index + 1;
      id = setTimeout(tick, index + 1 < steps.length ? PLAY_STEP_MS : PLAY_HOLD_MS);
    };
    id = setTimeout(tick, firstDelayRef.current);
    firstDelayRef.current = PLAY_STEP_MS;
    return () => clearTimeout(id);
  }, [playing, steps, commit, positionOf, prefetchStep]);

  const startPlayback = () => {
    const currentMs = nowMs - localPositionMs;
    const resumeAt = localPositionMs >= 30_000 ? steps.findIndex((step) => step.atMs > currentMs) : -1;
    if (resumeAt > 0) {
      // Mid-range: carry on from the next change after the playhead.
      nextStepRef.current = resumeAt;
      firstDelayRef.current = PLAY_STEP_MS / 3;
      prefetchStep(steps[resumeAt]);
    } else {
      // From the top: rewind to just before the first change and hold there.
      const first = steps[0];
      if (first === undefined) return;
      nextStepRef.current = 0;
      firstDelayRef.current = PLAY_LEAD_MS;
      commit(positionOf(first.atMs - BEFORE_STEP_MS), { immediate: true });
      prefetchStep(first);
    }
    setShownStep(null);
    setPlaying(true);
  };

  const stopPlayback = () => {
    setPlaying(false);
    setShownStep(null);
  };

  const isPast = localPositionMs >= 30_000;
  const currentDate = new Date(nowMs - localPositionMs);

  const positionFromClientX = (clientX: number): number => {
    const track = trackRef.current;
    if (track === null) return localPositionMs;
    const rect = track.getBoundingClientRect();
    const fraction = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    // Right edge = now (position 0); left edge = the start of the range.
    return (1 - fraction) * totalMs;
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    setScrubbing(true);
    stopPlayback();
    event.currentTarget.setPointerCapture(event.pointerId);
    commit(positionFromClientX(event.clientX), { immediate: false });
  };
  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbing) return;
    commit(positionFromClientX(event.clientX), { immediate: false });
  };
  const handlePointerUp = () => setScrubbing(false);

  const jumpToEvent = (direction: "prev" | "next") => {
    const currentMs = nowMs - localPositionMs;
    const candidates = events
      .map((event) => new Date(event.createdAt).getTime())
      .filter((ms) => (direction === "next" ? ms > currentMs : ms < currentMs))
      .sort((a, b) => (direction === "next" ? a - b : b - a));
    const target = candidates[0];
    if (target === undefined) return;
    commit(nowMs - target, { immediate: true });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = localPositionMs + (event.shiftKey ? STEP_HOUR_MS : STEP_MIN_MS);
    if (event.key === "ArrowRight" || event.key === "ArrowUp") next = localPositionMs - (event.shiftKey ? STEP_HOUR_MS : STEP_MIN_MS);
    if (event.key === "Home") next = totalMs;
    if (event.key === "End") next = 0;
    if (event.key === "PageUp") return jumpToEvent("prev");
    if (event.key === "PageDown") return jumpToEvent("next");
    if (next !== null) {
      event.preventDefault();
      stopPlayback();
      commit(next, { immediate: true });
    }
  };

  const backToNow = () => {
    stopPlayback();
    commit(0, { immediate: true });
  };

  const caption = useMemo(() => {
    if (playing) {
      const first = shownStep?.events[0];
      if (shownStep === null || first === undefined) return `Replaying ${moveCount} ${moveCount === 1 ? "move" : "moves"}…`;
      const more = shownStep.events.length - 1;
      return `${fmtClock(new Date(first.createdAt))} · ${describeMove(first)}${more > 0 ? ` · +${more} more` : ""}`;
    }
    const currentMs = nowMs - localPositionMs;
    // The feed is newest-first, so a plain `find` would always name the latest
    // event; the caption wants the earliest one at or after the playhead.
    const upcoming = events.reduce<TaskEvent | undefined>(
      (found, event) => (new Date(event.createdAt).getTime() >= currentMs ? event : found),
      undefined,
    );
    if (upcoming === undefined) return isPast ? "Nothing recorded before this point." : "You're viewing now.";
    return `${fmtClock(new Date(upcoming.createdAt))} · ${describeMove(upcoming)}`;
  }, [events, localPositionMs, isPast, nowMs, playing, shownStep, moveCount]);

  // A light sparkline of activity across the whole range, bucketed client-side.
  const sparkline = useMemo(() => {
    const bins = new Array(BINS).fill(0);
    for (const event of events) {
      const ms = new Date(event.createdAt).getTime();
      const bin = clamp(Math.floor(((ms - rangeStartMs) / totalMs) * BINS), 0, BINS - 1);
      bins[bin] += 1;
    }
    const max = Math.max(1, ...bins);
    return bins.map((count) => count / max);
  }, [events, rangeStartMs, totalMs]);

  /**
   * Discrete event markers along the axis — the prototype's `MARK` table,
   * simplified to one dot per `task.status_changed` event, coloured by what it
   * moved *to* (waiting-on-you/blocked read hot, everything else neutral).
   */
  const markers = useMemo(() => {
    const colorFor = (to: unknown): string => {
      if (to === "needs_user_decision" || to === "needs_user_action") return "var(--map-pool-attn)";
      if (to === "blocked") return "var(--map-pool-block)";
      if (to === "needs_qa" || to === "done") return "var(--map-ok)";
      return "var(--map-ink-3)";
    };
    return moves.map((event) => {
      const ms = new Date(event.createdAt).getTime();
      const x = clamp(((ms - rangeStartMs) / totalMs) * 100, 0, 100);
      return { x, color: colorFor((event.payload as { to?: unknown }).to) };
    });
  }, [moves, rangeStartMs, totalMs]);

  const knobFraction = 1 - localPositionMs / totalMs;

  const playLabel = playing
    ? "Pause"
    : moveCount === 0
      ? "Nothing to replay"
      : `Replay ${moveCount} ${moveCount === 1 ? "move" : "moves"}`;
  const playButton = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0"
      disabled={!playing && moveCount === 0}
      aria-label={compact ? playLabel : undefined}
      onClick={() => (playing ? stopPlayback() : startPlayback())}
    >
      {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
      {compact ? null : playLabel}
    </Button>
  );

  const timeReadout = (
    <div className="flex shrink-0 flex-col leading-tight">
      <span className="font-mono text-lg font-semibold tabular-nums">{fmtClock(currentDate)}</span>
      <span className="font-mono text-[10.5px] text-muted-foreground">
        {isPast ? fmtAgo(localPositionMs) : "now"}
      </span>
    </div>
  );

  const nowButton = compact ? (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className="shrink-0"
      onClick={backToNow}
      disabled={!isPast}
      aria-label="Back to now"
    >
      <RotateCcw aria-hidden="true" />
    </Button>
  ) : (
    <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={backToNow} disabled={!isPast}>
      Now
    </Button>
  );

  const track = (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label="Replay time. Arrow keys move ten minutes (shift: one hour), Page Up and Page Down jump between events."
      aria-valuemin={0}
      aria-valuemax={Math.round(totalMs / 60_000)}
      aria-valuenow={Math.round(localPositionMs / 60_000)}
      aria-valuetext={isPast ? `${fmtClock(currentDate)}, ${fmtAgo(localPositionMs)}` : "Now"}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
      className="relative h-11 min-w-0 flex-1 cursor-pointer touch-none rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <svg viewBox={`0 0 100 44`} preserveAspectRatio="none" className="absolute inset-0 size-full" aria-hidden="true">
        <polyline
          points={sparkline.map((v, i) => `${(i / (BINS - 1)) * 100},${36 - v * 26}`).join(" ")}
          fill="none"
          stroke="var(--map-water-edge)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        <line x1={0} x2={100} y1={38} y2={38} stroke="var(--map-line-2)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {markers.map((marker, i) => (
          <circle key={i} cx={marker.x} cy={38} r={1.6} fill={marker.color} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <div className="absolute top-0 bottom-2 w-0.5 bg-foreground" style={{ left: `${knobFraction * 100}%` }}>
        <span className="absolute -bottom-2 -left-2 size-4 rounded-full border-2 border-map-panel bg-foreground" />
      </div>
    </div>
  );

  if (compact) {
    return (
      <div className={cn("flex flex-col gap-2 rounded-2xl border border-border bg-map-panel px-3 py-2", className)}>
        <div className="flex flex-nowrap items-center gap-2">
          {playButton}
          {timeReadout}
          {nowButton}
        </div>
        <div className="flex items-center">{track}</div>
        <p className="min-h-[1.4em] truncate font-mono text-[11px] text-muted-foreground">{caption}</p>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-2 rounded-2xl border border-border bg-map-panel px-4 py-3 shadow-raised", className)}>
      <div className="flex flex-wrap items-center gap-3">
        {playButton}
        {timeReadout}
        {track}
        {nowButton}
      </div>

      <p className="min-h-[1.4em] truncate font-mono text-xs text-muted-foreground">{caption}</p>
    </div>
  );
};
