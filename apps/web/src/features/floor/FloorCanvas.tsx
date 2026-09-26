import { type FloorTask, type TaskRef, type TaskStatus } from "@helpdesk/contracts";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import {
  beadColorIndex,
  computeDensityScale,
  computeViewportScale,
  isValidDropTarget,
  POOL_STATIONS,
  type MapLayout,
} from "@/features/floor/layout";
import { MapLegend } from "@/features/floor/MapLegend";
import {
  computeAnimationDurationMs,
  diffMovedTasks,
  easeInOutCubic,
  pathLength,
  pickRouteKind,
  pointAtFraction,
  ROUTE_SNAP_THRESHOLD,
  sampleQuadratic,
  sliceMainChannel,
  type Point,
} from "@/features/floor/route";
import { type FloorLinksMode, type MapGroupBy } from "@/pages/tasks-map/useFloorParams";
import {
  buildStaticLayer,
  computeGeometry,
  drawFrame,
  hitTest,
  laneColor,
  placeBeads,
  readFloorColors,
  STATION,
  tipInfoFor,
  type FadingOutBoat,
  type FloorHitTarget,
  type RenderedArrival,
  type RenderedBeadAnimation,
} from "@/features/floor/scene";

/** How long the splash + station-flash effect lasts after a bead arrives. */
const ARRIVAL_EFFECT_MS = 550;
/** How long a boat takes to fade in (a claim appearing) or out (one released) — the prototype's `boats[id].a` ramp. */
const BOAT_FADE_MS = 400;
/** Samples behind the bead's current position that make up its fading trail. */
const TRAIL_SAMPLES = 20;
/** How far back (as a fraction of the whole route) the trail reaches. */
const TRAIL_SPAN_FRACTION = 0.18;

type ActiveBeadTravel = {
  taskId: number;
  points: Point[];
  startTime: number;
  durationMs: number;
  toStation: TaskStatus;
  radius: number;
  colorHex: string;
};

type PendingArrival = { x: number; y: number; station: TaskStatus; startTime: number; colorHex: string };

/** Backlog/needs_refinement/todo — the planning stations quick-add appears on. */
const PLANNING_STATUSES: readonly TaskStatus[] = ["backlog", "needs_refinement", "todo"];

/**
 * The Estuary map canvas: the river, its ten stations, and every task as a
 * bead. `role="img"` with a text summary — the Ledger is this view's full
 * accessible twin — and focusable/keyboard-operable on top of that (arrow keys
 * cycle through the visible beads, Enter opens the focused one).
 *
 * **Height comes from width alone** (`computeCanvasHeight`, `clamp(w·0.58,
 * 410, 580)` when horizontal) and is never fed back into anything the layout
 * measures — the bug from the Foundry pass (the pane's own height feeding a
 * fit calculation, which fed the pane's height…) does not exist here because
 * nothing here reads the canvas's rendered height as an input.
 */
export type FloorCanvasProps = {
  layout: MapLayout;
  projectOrder: readonly string[];
  groupMode: MapGroupBy;
  links: FloorLinksMode;
  selectedTaskId?: number | null;
  hoveredTaskId?: number | null;
  onHoverTask: (taskId: number | null) => void;
  onSelectTask: (task: FloorTask) => void;
  onSelectGhost: (ref: TaskRef) => void;
  onToggleStatus: (status: TaskStatus) => void;
  /** `at`, when replaying — drives the day/night light instead of the real clock. Read-only mode is the caller's concern. */
  clockAt?: string;
  /**
   * Animate bead travel even though `clockAt` is set — true while the tide
   * scrubber is *playing* a replay, where each step is one change worth
   * watching. A drag or keyboard scrub stays a plain redraw: those jumps can
   * cover hours of changes at once.
   */
  animateReplay?: boolean;
  className?: string;
  /** Whether `MapLegend` renders below the canvas — the hero's toolbar has its own toggle for this. Defaults to visible. */
  legendVisible?: boolean;
  /**
   * Quick add — a small "+" next to a planning station's plate (backlog /
   * needs_refinement / todo), shown on hover or keyboard focus. `project` is
   * the cluster's own dominant group when grouped by project, else
   * `undefined` (the create page falls back to the header's scope).
   * Omit to not render quick-add at all (e.g. while replaying).
   */
  onQuickAdd?: (status: TaskStatus, project: string | undefined) => void;
  /**
   * Drag-to-transition: pointer-drag a bead onto a station to move it there.
   * Omit to disable dragging entirely (the caller does this while replaying —
   * `clockAt !== undefined` already makes every write read-only elsewhere).
   * Every status may move to any other (`lib/statusTransition.ts` — there is
   * no transition table), so the only invalid drop is the bead's own current
   * station; the caller decides whether the move needs `TransitionDialog` or
   * can post directly.
   */
  onDropTask?: (task: FloorTask, target: TaskStatus) => void;
};

const summaryFor = (layout: MapLayout): string => {
  const total = Object.values(layout.clusters).reduce((sum, cluster) => sum + cluster.totalCount, 0);
  const regionSummary = ["backlog,needs_refinement,todo:Planning", "in_progress,needs_qa:Under way", "blocked,needs_user_decision,needs_user_action:Waiting", "done,deferred:Shipped"]
    .map((entry) => {
      const [statuses, label] = entry.split(":") as [string, string];
      const count = statuses
        .split(",")
        .reduce((sum, status) => sum + (layout.clusters[status as TaskStatus]?.totalCount ?? 0), 0);
      return `${label}: ${count}`;
    })
    .join(", ");
  return `Flow map. ${total} tasks, one bead each, clustered at their status station. ${regionSummary}. The ledger lists the same tasks.`;
};

/** All beads in a stable order, for keyboard cycling and the initial focus target. */
const orderedBeadIds = (layout: MapLayout): number[] => {
  const ids: number[] = [];
  for (const cluster of Object.values(layout.clusters)) {
    for (const bead of cluster.beads) ids.push(bead.task.id);
  }
  return ids;
};

export const FloorCanvas = ({
  layout,
  projectOrder,
  groupMode,
  links,
  selectedTaskId,
  hoveredTaskId,
  onHoverTask,
  onSelectTask,
  onSelectGhost,
  onToggleStatus,
  clockAt,
  animateReplay = false,
  className,
  legendVisible = true,
  onQuickAdd,
  onDropTask,
}: FloorCanvasProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const staticLayerRef = useRef<HTMLCanvasElement | null>(null);
  const hitsRef = useRef<FloorHitTarget[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hoverTarget, setHoverTarget] = useState<FloorHitTarget | null>(null);
  const [keyboardTaskId, setKeyboardTaskId] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");

  // Drag-to-transition. `dragCandidate` is set on pointerdown over a bead —
  // not yet a drag, just a possible one — and promoted to `drag` (the actual
  // dragging state, driving the ghost + station highlights) once the pointer
  // moves past a small threshold (mouse) or a ~350ms long-press elapses
  // (touch). Splitting the two is what keeps an ordinary click on a bead
  // working exactly as before: `dragCandidate` alone never fires anything.
  const [drag, setDrag] = useState<{ task: FloorTask; x: number; y: number; overStatus: TaskStatus | null } | null>(
    null,
  );
  const dragCandidateRef = useRef<{ task: FloorTask; clientX: number; clientY: number; pointerId: number } | null>(
    null,
  );
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canDrag = onDropTask !== undefined && clockAt === undefined;

  // Bead travel: refs, not state — every field here changes at rAF cadence
  // (mid-animation) or from a diff most renders don't need to re-render for,
  // and the draw loop already reads fresh refs every frame regardless of
  // React's render cycle. `prevRenderedRef` is what a new layout is diffed
  // against — status *and* resting position, both from the last frame this
  // component actually drew — to notice a task moved without caring whether
  // a poll, a drag-drop, a rail quick action, or the drawer caused it.
  const prevRenderedRef = useRef<Map<number, { status: TaskStatus; x: number; y: number }>>(new Map());
  const activeTravelsRef = useRef<ActiveBeadTravel[]>([]);
  const arrivalsRef = useRef<PendingArrival[]>([]);
  /** Lets a caller (drag-drop) seed a travel animation starting from an arbitrary drop point instead of the bead's last resting position. */
  const pendingDropOriginRef = useRef<{ taskId: number; x: number; y: number } | null>(null);

  // Boat fade in/out — a live claim appearing or disappearing, ~400ms either
  // way (the prototype's `boats[id].a`). `prevClaimedRef` is "who had a live
  // claim last time this diffed", so the *next* diff can tell an appearing
  // claim from a disappearing one; `boatFadeRef` is the in-flight ramps the
  // draw loop reads every frame.
  const prevClaimedRef = useRef<Map<number, string>>(new Map());
  const boatFadeRef = useRef<Map<number, { startTime: number; direction: "in" | "out"; actor: string }>>(new Map());

  const clearLongPress = () => {
    if (longPressRef.current !== null) {
      clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  };

  const reducedMotion = useMemo(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  // Measures `containerRef`'s own box — never the canvas's rendered size (the
  // canvas is `position: absolute`, below, specifically so it cannot
  // contribute to this element's content size and feed back into the
  // geometry this effect drives). `containerRef`'s size comes purely from its
  // ancestors' flex layout (a `min-h-0 flex-1` chain up to the hero's
  // viewport-bound height), so there is no loop to break.
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect === undefined) return;
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const geometry = useMemo(
    () => computeGeometry(Math.max(280, size.width), size.height > 0 ? size.height : undefined),
    [size.width, size.height],
  );

  const totalVisible = useMemo(
    () => Object.values(layout.clusters).reduce((sum, cluster) => sum + cluster.beads.length, 0),
    [layout],
  );
  const viewportScale = computeViewportScale(geometry.W, geometry.horiz);
  const densityScale = computeDensityScale(totalVisible);
  const showAllCallouts = totalVisible <= 30;

  const placement = useMemo(
    () => placeBeads(layout, geometry, viewportScale, densityScale),
    [layout, geometry, viewportScale, densityScale],
  );

  /**
   * The route a bead travels between two stations: the main channel's own
   * sampled points when moving forward on `MAIN_ORDER`, otherwise a quadratic
   * hop arc bowed the same way a dependency arc is (`drawEdges`) — see
   * `route.ts`'s `pickRouteKind`.
   */
  const buildRoutePoints = (fromStation: TaskStatus, toStation: TaskStatus, fromPoint: Point): Point[] => {
    const toPoint = geometry.P(STATION[toStation]);
    if (pickRouteKind(fromStation, toStation) === "main") {
      const us = geometry.mainPx.map((p) => geometry.uOf(p));
      const slice = sliceMainChannel(geometry.mainPx, us, geometry.uOf(fromPoint), geometry.uOf(toPoint));
      if (slice.length >= 2) return [fromPoint, ...slice, toPoint];
    }
    const mx = (fromPoint[0] + toPoint[0]) / 2;
    const my = (fromPoint[1] + toPoint[1]) / 2;
    const d = Math.hypot(toPoint[0] - fromPoint[0], toPoint[1] - fromPoint[1]);
    return sampleQuadratic(fromPoint, [mx, my - d * 0.4 - 24], toPoint, 24);
  };

  // Diffs the previous frame's rendered status/position against the new
  // layout whenever it changes — the one mechanism behind bead travel for
  // *every* source of a status change (a poll, a drag-drop, a rail quick
  // action, the drawer): none of those call into this component directly,
  // they all just eventually produce a new `layout`.
  useEffect(() => {
    const prevRendered = prevRenderedRef.current;
    const isFirstPaint = prevRendered.size === 0;
    const currentTasks = [...placement.beads.values()].map(({ bead }) => ({ id: bead.task.id, status: bead.task.status }));
    const prevStatus = new Map([...prevRendered.entries()].map(([id, v]) => [id, v.status] as const));
    const moved = isFirstPaint ? [] : diffMovedTasks(prevStatus, currentTasks);
    const motionAllowed = !reducedMotion && (clockAt === undefined || animateReplay);
    const canAnimate = motionAllowed && moved.length > 0 && moved.length <= ROUTE_SNAP_THRESHOLD;

    if (canAnimate) {
      for (const move of moved) {
        const toPlaced = placement.beads.get(move.taskId);
        if (toPlaced === undefined) continue; // left scope entirely — nothing to animate to
        const dropOrigin = pendingDropOriginRef.current?.taskId === move.taskId ? pendingDropOriginRef.current : null;
        const prev = prevRendered.get(move.taskId);
        const fromPoint: Point | null = dropOrigin !== null ? [dropOrigin.x, dropOrigin.y] : prev !== undefined ? [prev.x, prev.y] : null;
        if (fromPoint === null) continue;
        const points = buildRoutePoints(move.from, move.to, fromPoint);
        const colorIndex = beadColorIndex(toPlaced.bead.task, toPlaced.bead.groupKey, toPlaced.bead.groupIndex, groupMode, projectOrder);
        activeTravelsRef.current.push({
          taskId: move.taskId,
          points,
          startTime: performance.now(),
          durationMs: computeAnimationDurationMs(pathLength(points)),
          toStation: move.to,
          radius: toPlaced.r,
          colorHex: laneColor(colorIndex, readFloorColors()),
        });
      }
    }
    pendingDropOriginRef.current = null;

    // Boat fade: who has a live claim *now*, diffed against last time.
    const currentClaimed = new Map<number, string>();
    for (const { bead } of placement.beads.values()) {
      if (bead.task.status === "in_progress" && bead.task.claim !== null) currentClaimed.set(bead.task.id, bead.task.claim.actor);
    }
    if (!isFirstPaint && motionAllowed) {
      const nowMs = performance.now();
      for (const [id, actor] of currentClaimed) {
        if (!prevClaimedRef.current.has(id)) boatFadeRef.current.set(id, { startTime: nowMs, direction: "in", actor });
      }
      for (const [id, actor] of prevClaimedRef.current) {
        if (!currentClaimed.has(id)) boatFadeRef.current.set(id, { startTime: nowMs, direction: "out", actor });
      }
    }
    prevClaimedRef.current = currentClaimed;

    const nextRendered = new Map<number, { status: TaskStatus; x: number; y: number }>();
    for (const { bead, x, y } of placement.beads.values()) nextRendered.set(bead.task.id, { status: bead.task.status, x, y });
    prevRenderedRef.current = nextRendered;
    // `buildRoutePoints`/`geometry` are stable for the render this effect runs in; re-running this diff on every geometry recompute (a resize) would treat "the same tasks, redrawn at a new size" as a batch of moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placement, reducedMotion, clockAt, animateReplay, groupMode, projectOrder]);

  /** The one cluster (if any) whose sector dividers/labels should draw this frame. */
  const stationOf = (taskId: number | null | undefined): TaskStatus | null => {
    if (taskId === null || taskId === undefined) return null;
    return layout.taskPosition.get(taskId)?.station ?? null;
  };
  const sectorLabelStation: TaskStatus | null =
    (hoverTarget?.kind === "station" || hoverTarget?.kind === "shoal" ? hoverTarget.station : null) ??
    stationOf(hoveredTaskId) ??
    stationOf(selectedTaskId);

  useEffect(() => {
    staticLayerRef.current = buildStaticLayer(geometry, readFloorColors());
  }, [geometry]);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      staticLayerRef.current = buildStaticLayer(geometry, readFloorColors());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [geometry]);

  const draw = useCallback(
    (time: number) => {
      const canvas = canvasRef.current;
      const staticLayer = staticLayerRef.current;
      if (canvas === null || staticLayer === null) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(geometry.W * dpr);
      canvas.height = Math.round(geometry.H * dpr);
      const ctx = canvas.getContext("2d");
      if (ctx === null) return;

      const now = Date.now();
      const clockDate = clockAt !== undefined ? new Date(clockAt) : new Date();
      const nowMs = performance.now();

      // Advance every active travel; anything that's reached its target
      // becomes an arrival effect and drops out of the travel list.
      const stillTravelling: ActiveBeadTravel[] = [];
      const renderedAnimations: RenderedBeadAnimation[] = [];
      for (const travel of activeTravelsRef.current) {
        const elapsed = nowMs - travel.startTime;
        const rawT = Math.min(1, elapsed / travel.durationMs);
        const eased = easeInOutCubic(rawT);
        const [x, y] = pointAtFraction(travel.points, eased);
        if (rawT >= 1) {
          arrivalsRef.current.push({
            x,
            y,
            station: travel.toStation,
            startTime: nowMs,
            colorHex: travel.colorHex,
          });
          continue;
        }
        stillTravelling.push(travel);
        const trail: Point[] = [];
        for (let i = 0; i < TRAIL_SAMPLES; i += 1) {
          const backT = Math.max(0, eased - (TRAIL_SPAN_FRACTION * (TRAIL_SAMPLES - i)) / TRAIL_SAMPLES);
          trail.push(pointAtFraction(travel.points, backT));
        }
        renderedAnimations.push({ taskId: travel.taskId, x, y, trail, radius: travel.radius, colorHex: travel.colorHex });
      }
      activeTravelsRef.current = stillTravelling;

      const renderedArrivals: RenderedArrival[] = [];
      const stillArriving: PendingArrival[] = [];
      for (const arrival of arrivalsRef.current) {
        const elapsedMs = nowMs - arrival.startTime;
        if (elapsedMs >= ARRIVAL_EFFECT_MS) continue;
        stillArriving.push(arrival);
        renderedArrivals.push({
          x: arrival.x,
          y: arrival.y,
          station: arrival.station,
          elapsedMs,
          durationMs: ARRIVAL_EFFECT_MS,
          isPool: POOL_STATIONS[arrival.station] !== undefined,
          colorHex: arrival.colorHex,
        });
      }
      arrivalsRef.current = stillArriving;

      // Boat fade: advance every in-flight ramp, dropping a fade-out once
      // it reaches 0 (an "in" ramp is left in place at alpha 1 rather than
      // removed at completion — harmless, and cheaper than another map
      // write every frame for a boat that isn't moving any more).
      const boatAlpha = new Map<number, number>();
      const fadingOutBoats: FadingOutBoat[] = [];
      const stillFading = new Map<number, { startTime: number; direction: "in" | "out"; actor: string }>();
      for (const [taskId, fade] of boatFadeRef.current) {
        const t = Math.min(1, (nowMs - fade.startTime) / BOAT_FADE_MS);
        const alpha = fade.direction === "in" ? t : 1 - t;
        boatAlpha.set(taskId, alpha);
        if (fade.direction === "in" && t < 1) stillFading.set(taskId, fade);
        if (fade.direction === "out") {
          if (t < 1) stillFading.set(taskId, fade);
          const placed = placement.beads.get(taskId);
          if (placed !== undefined) fadingOutBoats.push({ taskId, x: placed.x, y: placed.y, r: placed.r, actor: fade.actor });
        }
      }
      boatFadeRef.current = stillFading;

      hitsRef.current = drawFrame({
        ctx,
        staticLayer,
        layout,
        geometry,
        placement,
        colors: readFloorColors(),
        projectOrder,
        groupMode,
        hoveredTaskId,
        selectedTaskId,
        keyboardTaskId,
        sectorLabelStation,
        links,
        now,
        clockDate,
        time,
        dpr,
        showAllCallouts,
        isLive: clockAt === undefined,
        activeAnimations: renderedAnimations,
        arrivals: renderedArrivals,
        boatAlpha,
        fadingOutBoats,
      });
    },
    [
      geometry,
      layout,
      placement,
      projectOrder,
      groupMode,
      hoveredTaskId,
      selectedTaskId,
      keyboardTaskId,
      sectorLabelStation,
      links,
      clockAt,
      showAllCallouts,
    ],
  );

  useEffect(() => {
    if (reducedMotion) {
      draw(0);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const loop = (now: number) => {
      draw((now - start) / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [draw, reducedMotion]);

  /** Client coordinates → canvas-geometry space (which is also the container's own CSS px space — see `computeGeometry`). */
  const canvasPoint = (clientX: number, clientY: number): { x: number; y: number } => {
    const canvas = canvasRef.current;
    if (canvas === null) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = geometry.W / rect.width;
    const scaleY = geometry.H / rect.height;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  };

  const hitAt = (clientX: number, clientY: number): FloorHitTarget | undefined => {
    const { x, y } = canvasPoint(clientX, clientY);
    return hitTest(hitsRef.current, x, y);
  };

  const pointerTarget = (event: React.PointerEvent<HTMLCanvasElement>): FloorHitTarget | undefined =>
    hitAt(event.clientX, event.clientY);

  /**
   * The drop target under `(x, y)` while dragging — a generous radius
   * (`clusterR + 12`, the same as the ring drawn around each valid station
   * below) rather than `hitTest`'s tight ~10px pin radius, which is tuned
   * for click precision, not for "drop somewhere inside the highlighted
   * ring." A drop target smaller than its own visual affordance is a real
   * usability bug, not just a cosmetic one.
   */
  const stationNear = (x: number, y: number): TaskStatus | null => {
    for (const status of Object.keys(STATION) as TaskStatus[]) {
      const [px, py] = geometry.P(STATION[status]);
      const r = (placement.clusterRadius[status] ?? 10) + 12;
      if (Math.hypot(x - px, y - py) <= r) return status;
    }
    return null;
  };

  const handleMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (drag !== null) {
      const { x, y } = canvasPoint(event.clientX, event.clientY);
      const overStatus = stationNear(x, y);
      setDrag((current) => (current === null ? current : { ...current, x, y, overStatus }));
      return;
    }
    if (canDrag && dragCandidateRef.current !== null) {
      const candidate = dragCandidateRef.current;
      const moved = Math.hypot(event.clientX - candidate.clientX, event.clientY - candidate.clientY);
      // Mouse: a real drag starts once the pointer has moved a few px — below
      // that, this stays a click. Touch waits for the long-press timer
      // instead (a moving finger before that fires is just an imprecise tap,
      // not a drag).
      if (event.pointerType !== "touch" && moved > 6) {
        const { x, y } = canvasPoint(event.clientX, event.clientY);
        setDrag({ task: candidate.task, x, y, overStatus: null });
      }
      return;
    }
    const target = pointerTarget(event);
    setHoverTarget(target ?? null);
    onHoverTask(target?.kind === "bead" ? target.task.id : null);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canDrag) return;
    const hit = pointerTarget(event);
    if (hit?.kind !== "bead") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragCandidateRef.current = { task: hit.task, clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId };
    if (event.pointerType === "touch") {
      clearLongPress();
      longPressRef.current = setTimeout(() => {
        const candidate = dragCandidateRef.current;
        if (candidate === null) return;
        const { x, y } = canvasPoint(candidate.clientX, candidate.clientY);
        setDrag({ task: candidate.task, x, y, overStatus: null });
      }, 350);
    }
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    clearLongPress();
    const wasDragging = drag !== null;
    if (wasDragging) {
      const currentStation = layout.taskPosition.get(drag.task.id)?.station;
      if (drag.overStatus !== null && isValidDropTarget(currentStation, drag.overStatus)) {
        // The eventual travel animation starts from *here* — where the user
        // actually let go — not from the bead's original station. They just
        // watched the ghost bead travel that far already; replaying the
        // whole trip from the start once the mutation lands would look like
        // it snapped back first.
        pendingDropOriginRef.current = { taskId: drag.task.id, x: drag.x, y: drag.y };
        onDropTask?.(drag.task, drag.overStatus);
      }
      setDrag(null);
      dragCandidateRef.current = null;
      return;
    }
    dragCandidateRef.current = null;
    handleClick(event);
  };

  const cancelDrag = () => {
    clearLongPress();
    setDrag(null);
    dragCandidateRef.current = null;
  };

  const handleClick = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const target = pointerTarget(event);
    if (target === undefined) return;
    if (target.kind === "bead") onSelectTask(target.task);
    else if (target.kind === "shoal" || target.kind === "station") onToggleStatus(target.station);
    else if (target.kind === "ghost") onSelectGhost(target.ghost.ref);
  };

  const announceTask = (taskId: number) => {
    for (const cluster of Object.values(layout.clusters)) {
      const bead = cluster.beads.find((b) => b.task.id === taskId);
      if (bead !== undefined) {
        const tip = tipInfoFor(bead.task);
        setAnnouncement(`${tip.reference}: ${tip.title}, ${tip.statusLabel}`);
        return;
      }
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (event.key === "Escape" && drag !== null) {
      cancelDrag();
      return;
    }
    const ids = orderedBeadIds(layout);
    if (ids.length === 0) return;

    if (event.key === "Enter") {
      if (keyboardTaskId === null) return;
      for (const cluster of Object.values(layout.clusters)) {
        const bead = cluster.beads.find((b) => b.task.id === keyboardTaskId);
        if (bead !== undefined) {
          onSelectTask(bead.task);
          return;
        }
      }
      return;
    }

    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    const backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
    if (!forward && !backward) return;
    event.preventDefault();

    const currentIndex = keyboardTaskId === null ? -1 : ids.indexOf(keyboardTaskId);
    const nextIndex = forward
      ? (currentIndex + 1 + ids.length) % ids.length
      : (currentIndex - 1 + ids.length) % ids.length;
    const nextId = ids[nextIndex];
    if (nextId === undefined) return;
    setKeyboardTaskId(nextId);
    onHoverTask(nextId);
    announceTask(nextId);
  };

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border", className)}>
      {/* No clock overlay here any more — the hero's toolbar row renders one
          above the canvas instead, so nothing ever draws on top of the river
          (this was covering the DEFERRED station plate at the top-right). */}
      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden bg-map-ground-2">
        <canvas
          ref={canvasRef}
          role="img"
          tabIndex={0}
          aria-label={summaryFor(layout)}
          className="absolute inset-0 block size-full cursor-pointer touch-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          onPointerDown={handlePointerDown}
          onPointerMove={handleMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={cancelDrag}
          onPointerLeave={() => {
            if (drag === null) {
              setHoverTarget(null);
              onHoverTask(null);
            }
          }}
          onKeyDown={handleKeyDown}
        />
        {hoverTarget?.kind === "bead" && drag === null ? (
          <HoverTip task={hoverTarget.task} x={hoverTarget.x} y={hoverTarget.y} />
        ) : null}
        {drag === null
          ? null
          : (Object.keys(STATION) as TaskStatus[]).map((status) => {
              const currentStation = layout.taskPosition.get(drag.task.id)?.station;
              if (!isValidDropTarget(currentStation, status)) return null;
              const [px, py] = geometry.P(STATION[status]);
              const r = (placement.clusterRadius[status] ?? 10) + 12;
              const isOver = drag.overStatus === status;
              return (
                <div
                  key={status}
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 transition-colors",
                    isOver ? "border-map-ok bg-map-ok/20" : "border-map-ok/50",
                  )}
                  style={{ left: px, top: py, width: r * 2, height: r * 2 }}
                />
              );
            })}
        {drag === null ? null : (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute z-20 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-foreground bg-map-panel/90 shadow-lg"
            style={{
              left: drag.x,
              top: drag.y,
              width: Math.max(16, (placement.beads.get(drag.task.id)?.r ?? 8) * 2.2),
              height: Math.max(16, (placement.beads.get(drag.task.id)?.r ?? 8) * 2.2),
            }}
          />
        )}
        {onQuickAdd === undefined || drag !== null
          ? null
          : PLANNING_STATUSES.map((status) => {
              const [px, py] = geometry.P(STATION[status]);
              const clusterR = placement.clusterRadius[status] ?? 6;
              const cluster = layout.clusters[status];
              const dominantProject =
                groupMode === "project"
                  ? [...cluster.groups].sort((a, b) => b.count - a.count)[0]?.key
                  : undefined;
              const project =
                dominantProject === undefined || dominantProject.startsWith("__") ? undefined : dominantProject;
              const isNear =
                (hoverTarget?.kind === "station" || hoverTarget?.kind === "shoal") && hoverTarget.station === status;
              return (
                <button
                  key={status}
                  type="button"
                  onClick={() => onQuickAdd(status, project)}
                  aria-label={`Add a task to ${status.replace(/_/g, " ")}`}
                  title={`Add a task to ${status.replace(/_/g, " ")}`}
                  className={cn(
                    "absolute z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-map-panel text-foreground opacity-0 shadow transition-opacity hover:opacity-100 hover:bg-primary hover:text-primary-foreground focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
                    isNear && "opacity-100",
                  )}
                  style={{ left: px + clusterR + 10, top: py }}
                >
                  <Plus className="size-3.5" aria-hidden="true" />
                </button>
              );
            })}
      </div>
      {legendVisible ? <MapLegend layout={layout} groupMode={groupMode} projectOrder={projectOrder} /> : null}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
};

const HoverTip = ({ task, x, y }: { task: FloorTask; x: number; y: number }) => {
  const tip = tipInfoFor(task);
  return (
    <div
      className="pointer-events-none absolute z-10 w-64 rounded-xl border border-border bg-popover p-3 text-xs text-foreground shadow-floating"
      style={{ left: x + 16, top: Math.max(0, y - 8) }}
    >
      <p className="font-mono text-[11px] text-muted-foreground">
        {tip.reference} {tip.project === null ? "" : `· ${tip.project}`}
      </p>
      <p className="mb-1 line-clamp-2 text-sm font-semibold">{tip.title}</p>
      <p className="font-mono text-[11px] text-muted-foreground">
        {tip.statusLabel} · {tip.priority}
      </p>
      {tip.note !== null ? <p className="mt-1 line-clamp-3 text-muted-foreground">{tip.note}</p> : null}
      <p className="mt-1 text-muted-foreground">
        {tip.waitsOn > 0 ? `waits on ${tip.waitsOn} · ` : ""}
        {tip.unblocks > 0 ? `unblocks ${tip.unblocks} · ` : ""}
        {tip.assignee ?? "unassigned"}
      </p>
    </div>
  );
};
