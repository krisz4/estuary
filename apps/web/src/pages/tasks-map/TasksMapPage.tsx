import {
  ANONYMOUS_ACTOR,
  HUMAN_ATTENTION_STATUSES,
  slugifyActorName,
  TERMINAL_TASK_STATUSES,
  type FloorTask,
  type TaskRef,
  type TaskStatus,
  type TransitionInput,
} from "@estuary/contracts";
import { Map as MapIcon, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useFloorQuery, usePrefetchFloorAt } from "@/api/floor";
import { isApiClientError } from "@/api/http";
import { useInboxQuery, useTaskFacetsQuery, useTransitionTaskMutation } from "@/api/tasks";
import { EmptyState } from "@/components/EmptyState";
import { ErrorPanel } from "@/components/ErrorPanel";
import { Button, Skeleton } from "@/components/ui";
import { errorCopy, errorDescription } from "@/lib/errorMessages";
import { TASK_STATUS_LABELS } from "@/lib/formatting";
import { transitionNeedsInput } from "@/lib/statusTransition";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import {
  buildMapLayout,
  computeDefaultBeltsMode,
  computeDensityScale,
  computeMaxPerCluster,
  computeViewportScale,
  countWorkingAgents,
  sortedProjectKeys,
} from "@/features/floor/layout";
import { formatLiveStatusLine } from "@/features/floor/liveMotion";
import { useLiveMotion } from "@/features/floor/useLiveMotion";
import { TaskWorkspaceDialog } from "@/features/tasks/TaskWorkspaceDialog";
import { TransitionDialog } from "@/features/tasks/TransitionDialog";
import { DEFAULT_TASK_LIST_PARAMS } from "@/pages/tasks-list/useTaskListParams";
import { AllTasksSection } from "@/pages/tasks-map/sections/AllTasksSection";
import { Hero } from "@/pages/tasks-map/sections/Hero";
import { computeInFlightCount, InFlightSection } from "@/pages/tasks-map/sections/InFlightSection";
import { MiniNav } from "@/pages/tasks-map/sections/MiniNav";
import { NeedsYouSection } from "@/pages/tasks-map/sections/NeedsYouSection";
import { RecentlySection } from "@/pages/tasks-map/sections/RecentlySection";
import { useFloorParams, type MapGroupBy } from "@/pages/tasks-map/useFloorParams";
import { useRememberProjectScope } from "@/stores/projectScope";
import { useRememberTaskView } from "@/stores/taskView";
import { useSessionStore } from "@/stores/session";
import { useMapLastVisit } from "@/stores/mapVisit";

/** The briefing never looks back less than this, even when the last visit was a moment ago. */
const BRIEFING_MIN_WINDOW_MS = 12 * 60 * 60 * 1000;
/** The tide scrubber's range floor — wider than the briefing's, so its sparkline always has something to show. */
const SCRUBBER_MIN_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Never look back more than a week, even if the last visit — or the floor above — asks for more. */
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The "since" bound for a summary window: **at least** `minWindowMs` back
 * (so a visit recorded a moment ago still produces a window with content —
 * this is the actual fix for "since 37 seconds ago · nothing has moved yet"),
 * further back when the last visit was longer ago than that, but never more
 * than `MAX_WINDOW_MS`. Exported for tests.
 */
export const computeSince = (
  lastVisit: string | null,
  minWindowMs: number,
  now = Date.now(),
): string => {
  const floor = now - minWindowMs;
  const cap = now - MAX_WINDOW_MS;
  if (lastVisit === null) return new Date(floor).toISOString();
  const visitedMs = new Date(lastVisit).getTime();
  return new Date(Math.max(Math.min(visitedMs, floor), cap)).toISOString();
};

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((entry) => b.includes(entry));

/**
 * The station/tile list dialog's title: a briefing tile's own name for its
 * status set ("Waiting on you", "Shipped"), else the status labels. Exported
 * for tests.
 */
export const statusListTitle = (statuses: readonly TaskStatus[]): string => {
  if (sameSet(statuses, HUMAN_ATTENTION_STATUSES)) return "Waiting on you";
  if (sameSet(statuses, TERMINAL_TASK_STATUSES)) return "Shipped";
  return statuses.map((status) => TASK_STATUS_LABELS[status]).join(" · ");
};

/**
 * `/tasks/map` — the app's landing page. Spec: `docs/pages/Tasks_Map.md`.
 *
 * One long-scrolling page, five stacked sections with hash anchors: the hero
 * (`#hero`, everything a glance needs — the briefing, the river map, the
 * top-priority "needs you" rail, all `100dvh` tall at `>=768px`), then
 * progressive disclosure into `#needs-you` (the full queue), `#in-flight`
 * (live claims + blocked dependency chains), `#all` (the dense, filterable
 * everything-view — the Dispatch bar and the List⇄Map switch live in *this*
 * section's sticky header now, not the page header), and `#recent` (the last
 * day, plus a Logbook link). A `MiniNav` scroll-spies between them once the
 * hero scrolls out of view.
 *
 * Owns no list state of its own beyond scroll position: everything else is
 * `useFloorParams()`, the URL — shared between the hero's map and `#all`'s
 * Dispatch bar/Ledger, so filtering one filters the other.
 */
export const TasksMapPage = () => {
  useDocumentTitle("Map");
  useRememberTaskView("map");
  const dropMutation = useTransitionTaskMutation();
  const [dropDialog, setDropDialog] = useState<{ task: FloorTask; target: TaskStatus } | null>(
    null,
  );

  const {
    params,
    setFilters,
    clearFilters,
    setGroup,
    setLinks,
    setMatch,
    setShipped,
    toggleFold: _toggleFold,
    setSelectedTask,
    setStatusList,
    setAt,
    applyPreset,
    activeFilterCount,
  } = useFloorParams();
  void _toggleFold; // folding a group is phase-3 UI not yet exposed as a control on the map itself
  useRememberProjectScope(params.project);

  const [hoveredTaskId, setHoveredTaskId] = useState<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const facetsQuery = useTaskFacetsQuery();
  const floorQuery = useFloorQuery(params);
  const prefetchFloorAt = usePrefetchFloorAt(params);
  const { data: snapshot, error, isPending, isFetching, refetch } = floorQuery;

  const lastVisit = useMapLastVisit();
  const briefingSince = useMemo(() => computeSince(lastVisit, BRIEFING_MIN_WINDOW_MS), [lastVisit]);
  const scrubberSince = useMemo(() => computeSince(lastVisit, SCRUBBER_MIN_WINDOW_MS), [lastVisit]);

  const group: MapGroupBy =
    params.group ??
    (snapshot === undefined ? "project" : computeDefaultBeltsMode(params.project, snapshot.tasks));

  const panelRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState(0);
  const [panelHeight, setPanelHeight] = useState(0);
  useEffect(() => {
    const el = panelRef.current;
    if (el === null) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect === undefined) return;
      setPanelWidth(Math.round(rect.width));
      setPanelHeight(Math.round(rect.height));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  void panelHeight; // the canvas's own aspect logic is width-driven today (see FloorCanvas); height is measured for a future pass that fits the hero's available height exactly.

  const projectOrder = facetsQuery.data?.projects ?? sortedProjectKeys(snapshot?.tasks ?? []);

  const layout = useMemo(() => {
    if (snapshot === undefined) return null;
    const horiz = panelWidth >= 600;
    const viewportScale = computeViewportScale(Math.max(280, panelWidth), horiz);
    const densityScale = computeDensityScale(snapshot.tasks.length);
    const maxPerCluster = computeMaxPerCluster(viewportScale, densityScale);
    return buildMapLayout({
      tasks: snapshot.tasks,
      edges: snapshot.edges,
      refs: snapshot.refs,
      group,
      match: params.match,
      hasActiveFilters: activeFilterCount > 0,
      selectedTaskId: params.task,
      olderClosedCount: snapshot.meta.olderClosedCount,
      maxPerCluster,
      // Live: when this snapshot was fetched (a pure value, unlike
      // `Date.now()` in render, and it advances with every poll). Replaying:
      // the playhead, so done beads settle exactly as they had at that time.
      now: params.at === undefined ? floorQuery.dataUpdatedAt : Date.parse(params.at),
    });
  }, [
    snapshot,
    panelWidth,
    group,
    params.match,
    params.task,
    params.at,
    activeFilterCount,
    floorQuery.dataUpdatedAt,
  ]);

  const displayName = useSessionStore((state) => state.displayName);
  const currentActor = (() => {
    const slug = slugifyActorName(displayName);
    return slug === null ? ANONYMOUS_ACTOR : `human:${slug}`;
  })();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (typing) return;
      if (event.key === "/") {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const dispatchProps = {
    params,
    facets: facetsQuery.data,
    onFiltersChange: setFilters,
    onClear: clearFilters,
    activeFilterCount,
    onSetGroup: (value: MapGroupBy | undefined) =>
      setGroup(
        snapshot === undefined || value === computeDefaultBeltsMode(params.project, snapshot.tasks)
          ? undefined
          : value,
      ),
    onSetLinks: setLinks,
    onSetMatch: setMatch,
    onSetShipped: setShipped,
    onApplyPreset: applyPreset,
    groupValue: group,
    isNeedsMeActive: params.assignee === currentActor,
    onToggleNeedsMe: () =>
      setFilters(
        params.assignee === currentActor
          ? { assignee: undefined }
          : { assignee: currentActor, assigneeIsNull: undefined },
      ),
    searchInputRef,
  };

  const reducedMotion = useMemo(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );
  const { syncedSecondsAgo } = useLiveMotion({
    lastEventId: snapshot?.meta.lastEventId ?? 0,
    project: params.project,
    enabled: snapshot !== undefined && params.at === undefined,
    reducedMotion,
  });
  const workingAgentCount = snapshot === undefined ? 0 : countWorkingAgents(snapshot.tasks);

  /**
   * A bead dropped on a station. Every status may move to any other (no
   * transition table — see `lib/statusTransition.ts`), so the only question
   * is whether the target's payload needs something from a human.
   *
   * `transitionNeedsInput` takes `{ acceptanceCriteria }`, which `FloorTask`
   * doesn't carry (it's the map's compact shape) — passing `null`
   * conservatively means a drop onto `todo` always opens the dialog rather
   * than risk a direct move the server would 422 on. Every other target's
   * requirement doesn't depend on that field at all, so this only costs an
   * extra click in the one case the client can't be sure about.
   */
  const handleDropTask = (task: FloorTask, target: TaskStatus) => {
    if (transitionNeedsInput(target, { acceptanceCriteria: null })) {
      setDropDialog({ task, target });
      return;
    }
    // `transitionNeedsInput` being false here means `target` is one of the
    // three statuses whose payload is an optional `reason` only (`backlog`,
    // `in_progress`, `done`) — safe to assert, since TypeScript can't narrow
    // `TaskStatus` from that runtime check the way a literal switch would.
    const input = { to: target, expectedVersion: task.version } as TransitionInput;
    dropMutation.mutate(
      { taskId: task.id, input },
      {
        onSuccess: () => toast.success(`${task.reference} moved to ${TASK_STATUS_LABELS[target]}`),
        onError: (error) => {
          if (isApiClientError(error) && error.code === "VERSION_CONFLICT") {
            toast.error("Someone else changed this task", {
              description: "Refresh the map and try again.",
            });
            return;
          }
          toast.error(errorCopy(error).title, { description: errorDescription(error) });
        },
      },
    );
  };

  // Shares the query key/cache with the hero rail and `NeedsYouSection`
  // (same `project`) — React Query dedupes it, so this is a read of the
  // already-in-flight/cached data, not a third network request, purely so
  // the mini-nav's "Needs you (N)" badge can't fall out of sync with the
  // section it links to.
  const inboxQuery = useInboxQuery(params.project);
  const needsYouCount = inboxQuery.data?.meta.total;
  const inFlightCount = snapshot === undefined ? undefined : computeInFlightCount(snapshot);

  return (
    // `-mt-6 md:-mt-8` cancels `AppLayout`'s shared `<main>` top padding
    // (`py-6`/`md:py-8`) — every other page wants that breathing room below
    // the header, but the map is a landing page whose hero wants to start
    // right under it. Only the *top* padding is cancelled (a plain negative
    // margin, not touching `main`'s own bottom padding), so the space after
    // the last section before the footer is unaffected. `Hero`'s own `py-3`
    // supplies the actual ~16px gap.
    <div className="mx-[calc(50%-50vw)] -mt-6 max-w-none px-4 md:-mt-8 md:px-6">
      <div className="mx-auto flex max-w-[1760px] flex-col gap-10">
        {isPending ? (
          <MapSkeleton />
        ) : error !== null && snapshot === undefined ? (
          <ErrorPanel error={error} onRetry={() => void refetch()} isRetrying={isFetching} />
        ) : snapshot === undefined || layout === null ? null : (
          <>
            {error !== null ? (
              <ErrorPanel error={error} onRetry={() => void refetch()} isRetrying={isFetching} />
            ) : null}

            {snapshot.tasks.length === 0 && activeFilterCount === 0 ? (
              <EmptyState
                icon={MapIcon}
                title="Nothing on the map"
                description="File the first task — it shows up here whether a human or an agent creates it."
                action={
                  <Button asChild>
                    <Link to="/tasks/new">
                      <Plus aria-hidden="true" />
                      File the first task
                    </Link>
                  </Button>
                }
              />
            ) : (
              <div className="flex flex-col gap-10">
                <MiniNav
                  heroSentinelId="hero-end"
                  sections={[
                    { id: "needs-you", label: "Needs you", count: needsYouCount },
                    { id: "in-flight", label: "In flight", count: inFlightCount },
                    { id: "all", label: "All tasks", count: snapshot.meta.total },
                    { id: "recent", label: "Recently" },
                  ]}
                />
                <Hero
                  briefingProps={{
                    snapshot,
                    onOpenStatuses: setStatusList,
                    onSelectTask: (taskId) => setSelectedTask(taskId),
                    project: params.project,
                    since: briefingSince,
                    shippedWindow: params.shipped,
                    ...(params.at === undefined
                      ? {
                          liveStatusLine: formatLiveStatusLine(workingAgentCount, syncedSecondsAgo),
                          liveMotionEnabled: !reducedMotion && workingAgentCount > 0,
                        }
                      : {}),
                  }}
                  dispatchProps={dispatchProps}
                  canvasProps={{
                    layout,
                    projectOrder,
                    groupMode: group,
                    links: params.links,
                    selectedTaskId: params.task,
                    hoveredTaskId,
                    onHoverTask: setHoveredTaskId,
                    onSelectTask: (task) => setSelectedTask(task.id),
                    onSelectGhost: (ref: TaskRef) => setSelectedTask(ref.id),
                    onOpenStation: (status) => setStatusList([status]),
                    clockAt: params.at,
                    // Drag-to-transition: no writes while replaying — a snapshot
                    // from the past isn't where a write belongs.
                    ...(params.at === undefined ? { onDropTask: handleDropTask } : {}),
                  }}
                  scrubberProps={{
                    rangeStart: scrubberSince,
                    at: params.at,
                    // Leaving "now" pushes one history entry; every move after
                    // that (a drag, a replay tick) replaces it, so Back returns
                    // to the live map instead of stepping through each frame.
                    onChange: (at) => setAt(at, { replace: params.at !== undefined }),
                    onPrefetch: prefetchFloorAt,
                    project: params.project,
                  }}
                  project={params.project}
                  hoveredTaskId={hoveredTaskId}
                  onHoverTask={setHoveredTaskId}
                  onOpenTask={(taskId) => setSelectedTask(taskId)}
                  mapCardRef={panelRef}
                />

                <NeedsYouSection project={params.project} projectOrder={projectOrder} />

                <InFlightSection
                  snapshot={snapshot}
                  onSelectTask={(taskId) => setSelectedTask(taskId)}
                />

                <AllTasksSection
                  snapshot={snapshot}
                  projectOrder={projectOrder}
                  dispatchProps={dispatchProps}
                  hasActiveFilters={activeFilterCount > 0}
                  selectedTaskId={params.task}
                  hoveredTaskId={hoveredTaskId}
                  onSelectTask={(task) => setSelectedTask(task.id)}
                  onHoverTask={setHoveredTaskId}
                  onClearFilters={clearFilters}
                />

                <RecentlySection project={params.project} snapshot={snapshot} />
              </div>
            )}
          </>
        )}

        {/* One large dialog for both a station's list and a task — see
            `TaskWorkspaceDialog`. Keyed by the list, so opening a different
            one starts from its own filters. */}
        {params.list.length === 0 && params.task === undefined ? null : (
          <TaskWorkspaceDialog
            key={params.list.join(",")}
            list={
              params.list.length === 0
                ? undefined
                : {
                    title: statusListTitle(params.list),
                    initialParams: {
                      ...DEFAULT_TASK_LIST_PARAMS,
                      status: params.list,
                      project: params.project,
                    },
                  }
            }
            taskId={params.task}
            onOpenTask={(taskId) => setSelectedTask(taskId)}
            onBackToList={() => setSelectedTask(undefined)}
            onClose={() => applyPreset({ list: [], task: undefined })}
            replayingAt={params.at}
            onBackToNow={() => setAt(undefined, { replace: true })}
          />
        )}

        {dropDialog === null ? null : (
          <TransitionDialog
            key={`${dropDialog.task.id}-${dropDialog.target}`}
            // `TransitionDialog` wants `acceptanceCriteria` (`TaskSummary`'s
            // shape); `FloorTask` doesn't carry it — see `handleDropTask`.
            // `null` is the same conservative stand-in used to decide
            // whether the dialog opens at all.
            task={{ ...dropDialog.task, acceptanceCriteria: null }}
            target={dropDialog.target}
            onSubmit={(input) =>
              dropMutation
                .mutateAsync({
                  taskId: dropDialog.task.id,
                  input: { ...input, expectedVersion: dropDialog.task.version },
                })
                .then(() => {
                  toast.success(
                    `${dropDialog.task.reference} moved to ${TASK_STATUS_LABELS[dropDialog.target]}`,
                  );
                  setDropDialog(null);
                })
            }
            onCancel={() => setDropDialog(null)}
          />
        )}
      </div>
    </div>
  );
};

const MapSkeleton = () => (
  <div className="flex flex-col gap-4 py-4">
    <Skeleton className="h-14 w-full rounded-2xl" />
    <Skeleton className="h-[calc(100dvh-10rem)] w-full rounded-2xl" />
  </div>
);
