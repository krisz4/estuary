import { ChevronDown, MapPinned } from "lucide-react";
import { useState } from "react";
import { useInboxQuery } from "@/api/tasks";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  MAP_HORIZ_QUERY,
  MAP_RAIL_QUERY,
  MD_BREAKPOINT_QUERY,
  SM_BREAKPOINT_QUERY,
  useMediaQuery,
} from "@/lib/useMediaQuery";
import { Briefing, type BriefingProps } from "@/features/floor/Briefing";
import { DispatchBar, type DispatchBarProps } from "@/features/floor/DispatchBar";
import { FloorCanvas, type FloorCanvasProps } from "@/features/floor/FloorCanvas";
import { formatClockLabel } from "@/features/floor/scene";
import { TideScrubber } from "@/features/floor/TideScrubber";
import { NeedsYouCard } from "@/pages/tasks-map/sections/NeedsYouCard";

const RAIL_CAP_DESKTOP = 4;
const RAIL_CAP_PHONE = 3;

export type HeroProps = {
  briefingProps: BriefingProps;
  dispatchProps: Omit<DispatchBarProps, "compact" | "toolbar">;
  canvasProps: Omit<FloorCanvasProps, "className" | "legendVisible">;
  scrubberProps: {
    rangeStart: string;
    at: string | undefined;
    onChange: (at: string | undefined) => void;
    onPrefetch: (at: string) => void;
    project: readonly string[];
  };
  project: readonly string[];
  hoveredTaskId: number | null;
  onHoverTask: (taskId: number | null) => void;
  onOpenTask: (taskId: number) => void;
  /**
   * The map **card**'s own ref, for `TasksMapPage`'s `ResizeObserver` (bead
   * layout is sized off this element's width). It must sit on this specific
   * div, not a wrapper further out: an ancestor using `display: contents`
   * (or one that also contains the rail) would report the wrong box, or one
   * that never actually resizes.
   */
  mapCardRef: React.RefObject<HTMLDivElement | null>;
};

/**
 * Section 1, the hero — "first look… harmonic, only the most relevant data".
 * **Exactly** `100dvh` minus the app header at `>=768px` (`h-[calc(100dvh-3.5rem)]`,
 * not `min-h`: a `min-h` here just means "at least", which is how the hero
 * grew to 2,778px behind an un-height-bound rail — see `NeedsYouCard`).
 * Allowed to scroll on phones, per spec.
 *
 * The map card is the dominant graphic: a slim, **non-overlaying** toolbar row
 * (clock, legend toggle, search, Filters, View, active-filter chips) sits
 * above the canvas — nothing draws on top of the river any more — then
 * `FloorCanvas` fills the remaining height via a `min-h-0 flex-1` chain, then
 * the tide scrubber as a single compact row.
 */
export const Hero = ({
  briefingProps,
  dispatchProps,
  canvasProps,
  scrubberProps,
  project,
  hoveredTaskId,
  onHoverTask,
  onOpenTask,
  mapCardRef,
}: HeroProps) => {
  const hasRail = useMediaQuery(MAP_RAIL_QUERY);
  const isPhone = !useMediaQuery(MD_BREAKPOINT_QUERY);
  const isHoriz = useMediaQuery(MAP_HORIZ_QUERY);
  const isNarrowToolbar = !useMediaQuery(SM_BREAKPOINT_QUERY);

  // Collapsed by default on phone (a legend panel is one more thing to
  // scroll past on a 390px screen); everywhere else it starts open.
  // `useMediaQuery` reads `matchMedia` synchronously on first render (it's
  // `useSyncExternalStore`, not an effect), so this lazy initializer sees the
  // real width immediately rather than flashing open first.
  const [legendVisible, setLegendVisible] = useState(() => !isNarrowToolbar);
  // Beads travel during replay only while it is *playing* — see `FloorCanvas`'s `animateReplay`.
  const [replayPlaying, setReplayPlaying] = useState(false);

  const mapCard = (
    <div
      ref={mapCardRef}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-2xl border border-border bg-map-panel p-2 shadow-raised",
        // Only the one-screen hero (`>=1280px`, with the rail beside the map)
        // gives the map card a *flexible* height that fills the fixed hero.
        // At `600–1279px` (horizontal river, hero flows) it gets a fixed CSS
        // height of its own — `flex-1` in a non-fixed-height ancestor
        // resolves to the content's own size, and the canvas (see
        // `FloorCanvas`) has no intrinsic size to contribute, which is
        // exactly how the map went missing (phone) or got squeezed to ~130px
        // by the needs-you row (tablet). Below `600px` (vertical river) the
        // card itself is auto-height — see the canvas's own `aspect-[1/2.1]`
        // below, which derives the canvas's height from its own width
        // instead, matching `computeCanvasHeight`'s vertical-mode formula
        // exactly (a fixed-height *card* here would fight that ratio and
        // either squash or letterbox the river).
        hasRail ? "min-h-[360px] flex-1" : isHoriz ? "h-[clamp(420px,62vh,640px)]" : "",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          aria-hidden="true"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 font-mono text-xs text-foreground"
        >
          {formatClockLabel(canvasProps.clockAt)}
        </span>
        {isNarrowToolbar ? null : (
          <Button
            type="button"
            variant={legendVisible ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2 text-xs"
            aria-pressed={legendVisible}
            onClick={() => setLegendVisible((prev) => !prev)}
          >
            <MapPinned className="size-3.5" aria-hidden="true" />
            Legend
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <DispatchBar {...dispatchProps} toolbar narrow={isNarrowToolbar} />
        </div>
      </div>
      <FloorCanvas
        {...canvasProps}
        className={cn(
          "rounded-none border-0",
          hasRail || isHoriz ? "min-h-0 flex-1" : "aspect-[1/2.1] max-h-[900px] w-full flex-none",
        )}
        legendVisible={legendVisible}
        animateReplay={replayPlaying}
      />
      <div className="rounded-lg border border-border bg-background/50 p-1.5">
        <TideScrubber
          rangeStart={scrubberProps.rangeStart}
          at={scrubberProps.at}
          onChange={scrubberProps.onChange}
          onPrefetch={scrubberProps.onPrefetch}
          onPlayingChange={setReplayPlaying}
          project={scrubberProps.project}
          compact={isNarrowToolbar}
        />
      </div>
    </div>
  );

  return (
    <section
      id="hero"
      aria-label="Map"
      className="relative scroll-mt-14 flex flex-col gap-3 py-3 xl:h-[calc(100dvh-3.5rem)]"
    >
      <h1 className="sr-only">Map — the task river</h1>

      {/*
       * `MiniNav`'s sentinel — **not** the last flex child any more. Every
       * section below starts `scroll-mt-28` (7rem) short of the true
       * document top so it lands clear of the sticky header + this very
       * nav; landing exactly there left ~40–70px of the hero still on
       * screen above it, which read to `IntersectionObserver` as "hero
       * still in view" and the nav never appeared at `#needs-you`,
       * `#in-flight`, or `#all` — precisely the *scrolled* state it exists
       * for. Anchoring it `bottom-40` (10rem) up from the hero's own bottom,
       * absolutely positioned (out of flow, so it doesn't reserve space or
       * reorder the "Details ↓" cue after it), clears the viewport well
       * before a section-anchor jump lands — generous on purpose, since
       * `IntersectionObserver` callbacks are not synchronous with the
       * scroll that triggers them, and a margin only a few pixels past the
       * threshold left a real, observed race where the callback for a
       * `scrollIntoView()` jump hadn't landed yet by the time the nav
       * needed to be visible.
       */}
      <div id="hero-end" aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-40 h-px" />

      <Briefing {...briefingProps} />

      <div className="flex flex-col gap-3 xl:min-h-0 xl:flex-1 xl:flex-row">
        {mapCard}
        {hasRail ? (
          <NeedsYouRail project={project} cap={RAIL_CAP_DESKTOP} hoveredTaskId={hoveredTaskId} onHoverTask={onHoverTask} onOpenTask={onOpenTask} />
        ) : null}
      </div>

      {!hasRail ? (
        <NeedsYouRail
          project={project}
          cap={isPhone ? RAIL_CAP_PHONE : RAIL_CAP_DESKTOP}
          hoveredTaskId={hoveredTaskId}
          onHoverTask={onHoverTask}
          onOpenTask={onOpenTask}
          horizontal
        />
      ) : null}

      <div className="flex shrink-0 justify-center text-xs text-muted-foreground">
        <a href="#needs-you" className="inline-flex items-center gap-1 hover:text-foreground">
          Details <ChevronDown className="size-3.5" aria-hidden="true" />
        </a>
      </div>
    </section>
  );
};

/**
 * The hero's "Needs you" rail — the top-priority items, one click deep.
 * `NeedsYouCard` is compact (~90–120px); the rail itself is height-bound
 * (`min-h-0` + `overflow-y-auto` on the vertical layout) so a long list
 * scrolls inside its own column instead of stretching `#hero` past one
 * screen — the actual fix for the 2,778px hero.
 */
const NeedsYouRail = ({
  project,
  cap,
  hoveredTaskId,
  onHoverTask,
  onOpenTask,
  horizontal = false,
}: {
  project: readonly string[];
  cap: number;
  hoveredTaskId: number | null;
  onHoverTask: (taskId: number | null) => void;
  onOpenTask: (taskId: number) => void;
  horizontal?: boolean;
}) => {
  const { data, isPending } = useInboxQuery(project);
  const tasks = (data?.data ?? []).slice(0, cap);
  const total = data?.meta.total ?? 0;

  if (isPending) return null;

  return (
    <aside
      aria-label="Needs you"
      className={horizontal ? "flex shrink-0 flex-col gap-2" : "flex min-h-0 w-full flex-col gap-2 xl:w-72 xl:shrink-0"}
    >
      <h2 className="flex shrink-0 items-center gap-2 text-sm font-semibold text-foreground">
        <span aria-hidden="true" className="size-2 rounded-full bg-attention shadow-[0_0_0_3px_var(--attention-subtle)]" />
        Needs you
        {total > 0 ? (
          <span className="rounded-full bg-attention-subtle px-1.5 font-mono text-xs text-attention-subtle-foreground tabular-nums">
            {total}
          </span>
        ) : null}
      </h2>
      {tasks.length === 0 ? (
        <EmptyState title="Nothing needs you." description="Agents are on it." />
      ) : (
        <div
          className={
            horizontal
              ? "grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4"
              : "flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
          }
        >
          {tasks.map((task) => (
            <div
              key={task.id}
              onMouseEnter={() => onHoverTask(task.id)}
              onMouseLeave={() => onHoverTask(null)}
              className={hoveredTaskId === task.id ? "rounded-lg ring-2 ring-attention" : undefined}
            >
              <NeedsYouCard task={task} onOpen={onOpenTask} />
            </div>
          ))}
        </div>
      )}
      {total > tasks.length ? (
        <a href="#needs-you" className="shrink-0 text-xs font-medium text-primary hover:underline">
          See all {total} ↓
        </a>
      ) : null}
    </aside>
  );
};
