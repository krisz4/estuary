import {
  HUMAN_ATTENTION_STATUSES,
  TERMINAL_TASK_STATUSES,
  type FloorShippedWindow,
  type FloorSnapshot,
  type FloorTask,
  type TaskStatus,
} from "@estuary/contracts";
import { useMemo } from "react";
import { useEventLogQuery } from "@/api/events";
import { cn } from "@/lib/cn";
import { formatRelative } from "@/lib/formatting";
import { projectColorIndex } from "@/features/floor/layout";
import { laneColor, readFloorColors } from "@/features/floor/scene";

/**
 * The briefing: "Since you left…" built from the real events feed (not the
 * prototype's fake overnight simulation), plus the tide stats row — five
 * clickable tiles that set the Map's URL filters. `docs/pages/Tasks_Floor.md`.
 */
export type BriefingProps = {
  snapshot: FloorSnapshot;
  /** A tile was clicked — the page opens those statuses' full list (it does not filter the map). */
  onOpenStatuses: (statuses: TaskStatus[]) => void;
  onSelectTask: (taskId: number) => void;
  project: readonly string[];
  /** ISO timestamp to summarise since — the page computes this once (`useMapLastVisit`). */
  since: string;
  /** The map's `shipped` window — the Shipped tile's count must agree with the same window the mouth shows, not an all-time total. */
  shippedWindow: FloorShippedWindow;
  /** "3 agents working · synced 12s ago" — omitted entirely while replaying (there is nothing "live" about a past snapshot). */
  liveStatusLine?: string;
  /** Whether to pulse the live dot — off under `prefers-reduced-motion`. */
  liveMotionEnabled?: boolean;
};

/**
 * One tide-stat tile — the number on top, the label below it, on a lifted
 * tile with a left edge in the stat's own colour. `border-l-[3px]` on a
 * `<button>`/`<div>` rather than a `<dl>` row: the tiles sit in one CSS grid
 * that has to reflow without any tile's edge detaching from its number.
 *
 * The edge always carries the tone; the **number** only takes it for the
 * stats that want a human (`attention`, and `destructive` when something is
 * blocked). Everything else stays foreground-coloured, so the eye lands on
 * "waiting on you" first instead of four equally loud numbers.
 */
type TileTone = "attention" | "info" | "destructive" | "success";

const TILE_EDGE: Record<TileTone, string> = {
  attention: "border-l-attention",
  info: "border-l-info",
  destructive: "border-l-destructive",
  success: "border-l-success",
};

const Tile = ({
  label,
  value,
  sublabel,
  tone,
  loud = false,
  onClick,
}: {
  label: string;
  value: number | string;
  sublabel?: string;
  tone: TileTone;
  /** Colour the number too — reserved for stats that need a human. */
  loud?: boolean;
  onClick?: () => void;
}) => {
  const content = (
    <div
      className={cn(
        "flex h-full flex-col gap-1 rounded-lg border border-border border-l-[3px] bg-card px-3 py-2 shadow-raised",
        TILE_EDGE[tone],
        loud && tone === "attention" && "bg-attention-subtle/40",
      )}
    >
      <span
        className={cn(
          "font-mono text-2xl leading-none font-bold tabular-nums",
          loud ? (tone === "attention" ? "text-attention" : "text-destructive") : "text-foreground",
        )}
      >
        {value}
      </span>
      <span className="flex flex-col text-xs leading-tight text-muted-foreground">
        <span className="font-semibold tracking-wide text-foreground uppercase">{label}</span>
        {sublabel === undefined ? null : <span className="truncate">{sublabel}</span>}
      </span>
    </div>
  );

  if (onClick === undefined) return content;

  return (
    <button
      type="button"
      onClick={onClick}
      className="min-w-0 rounded-lg text-left transition-transform hover:-translate-y-px [&>div]:transition-shadow hover:[&>div]:shadow-floating"
    >
      {content}
    </button>
  );
};

const TaskChip = ({
  task,
  onClick,
  projectOrder,
}: {
  task: FloorTask;
  onClick: () => void;
  projectOrder: readonly string[];
}) => (
  <button
    type="button"
    onClick={onClick}
    title={task.title}
    className="mx-0.5 inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-1.5 py-0 align-[1px] font-mono text-xs hover:border-input"
  >
    <span
      className="size-1.5 rounded-full"
      style={{
        backgroundColor: laneColor(
          projectColorIndex(task.project, projectOrder),
          readFloorColors(),
        ),
      }}
      aria-hidden="true"
    />
    #{task.id}
  </button>
);

export const Briefing = ({
  snapshot,
  onOpenStatuses,
  onSelectTask,
  project,
  since,
  shippedWindow,
  liveStatusLine,
  liveMotionEnabled = true,
}: BriefingProps) => {
  const eventsQuery = useEventLogQuery({
    project,
    type: ["task.status_changed"],
    from: since,
  });
  const events = eventsQuery.data?.pages[0]?.data ?? [];

  const taskById = new Map(snapshot.tasks.map((task) => [task.id, task] as const));
  const projectOrder = useMemo(
    () =>
      [
        ...new Set(snapshot.tasks.map((t) => t.project).filter((p): p is string => p !== null)),
      ].sort(),
    [snapshot.tasks],
  );

  const idsTo = (to: string): number[] => [
    ...new Set(
      events
        .filter((event) => (event.payload as { to?: unknown }).to === to)
        .map((event) => event.taskId),
    ),
  ];

  // "Agents picked up N tasks" — agents only. A human claiming a task (the
  // drawer's "Claim this task", or testing via the API with a `human:*`
  // actor) is real activity, but not what this sentence is about; counting
  // it in made "Agents picked up 6 tasks" true when every one of those
  // claims was actually a human.
  const claimedCount = events.filter(
    (event) =>
      (event.payload as { to?: unknown }).to === "in_progress" && event.actor.startsWith("agent:"),
  ).length;
  const sentToReview = idsTo("needs_qa");
  const closed = idsTo("done");
  const askedDecision = idsTo("needs_user_decision");
  const askedAction = idsTo("needs_user_action");
  const gotBlocked = idsTo("blocked");

  const chips = (ids: number[]) =>
    ids
      .slice(0, 3)
      .map((id) => taskById.get(id))
      .filter((task): task is FloorTask => task !== undefined)
      .map((task) => (
        <TaskChip
          key={task.id}
          task={task}
          projectOrder={projectOrder}
          onClick={() => onSelectTask(task.id)}
        />
      ));

  const sentences: React.ReactNode[] = [];
  if (claimedCount > 0 || sentToReview.length > 0) {
    sentences.push(
      <span key="picked-up">
        Agents picked up <b>{claimedCount}</b> task{claimedCount === 1 ? "" : "s"}
        {sentToReview.length > 0 ? (
          <>
            {" "}
            and sent <b>{sentToReview.length}</b> to review {chips(sentToReview)}
          </>
        ) : null}
        .
      </span>,
    );
  }
  if (closed.length > 0) {
    sentences.push(
      <span key="closed">
        <b>{closed.length}</b> closed {chips(closed)}.
      </span>,
    );
  }
  if (askedDecision.length > 0 || askedAction.length > 0) {
    sentences.push(
      <span key="needs-you">
        They need you for{" "}
        {askedDecision.length > 0 ? (
          <>
            <b>{askedDecision.length}</b> decision{askedDecision.length === 1 ? "" : "s"}{" "}
            {chips(askedDecision)}
          </>
        ) : null}
        {askedDecision.length > 0 && askedAction.length > 0 ? " and " : null}
        {askedAction.length > 0 ? (
          <>
            <b>{askedAction.length}</b> manual step{askedAction.length === 1 ? "" : "s"}{" "}
            {chips(askedAction)}
          </>
        ) : null}
        .
      </span>,
    );
  }
  if (gotBlocked.length > 0) {
    sentences.push(
      <span key="blocked">
        <b>{gotBlocked.length}</b> got blocked {chips(gotBlocked)}.
      </span>,
    );
  }

  const { statusCounts } = snapshot.meta;
  const needsYou = HUMAN_ATTENTION_STATUSES.reduce(
    (sum, status) => sum + (statusCounts[status] ?? 0),
    0,
  );
  const building = statusCounts.in_progress ?? 0;
  const blockedTasks = snapshot.tasks.filter((task) => task.status === "blocked");
  const blockedOnTasks = blockedTasks.filter((task) => task.openBlockerCount > 0).length;
  const blockedExternal = blockedTasks.length - blockedOnTasks;
  const terminalStatuses: readonly TaskStatus[] = TERMINAL_TASK_STATUSES;
  // `snapshot.tasks` already only carries closed tasks *within* the `shipped`
  // window (the DONE/DEFERRED beads on the map) — `meta.statusCounts` counts
  // every closed task regardless of window, which is a different number and
  // was showing up as "Shipped 16" next to a map with nothing at the mouth.
  const shippedInWindow = snapshot.tasks.filter((task) =>
    terminalStatuses.includes(task.status),
  ).length;
  const shippedAllTime = TERMINAL_TASK_STATUSES.reduce(
    (sum, status) => sum + (statusCounts[status] ?? 0),
    0,
  );

  return (
    <section
      aria-label="What happened"
      className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between lg:gap-6"
    >
      <div className="min-w-0 lg:max-w-[46%]">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
          <span>Since {formatRelative(since)}</span>
          {liveStatusLine === undefined ? null : (
            <span className="inline-flex items-center gap-1.5 normal-case">
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 rounded-full bg-map-ok",
                  liveMotionEnabled && "animate-pulse",
                )}
              />
              {liveStatusLine}
            </span>
          )}
        </p>
        <p className="mt-1 max-w-[68ch] text-sm leading-relaxed text-pretty">
          {sentences.length > 0
            ? sentences.map((node, i) => (
                <span key={i}>
                  {i > 0 ? " " : ""}
                  {node}
                </span>
              ))
            : "Nothing has moved yet."}
        </p>
      </div>
      {/* The bottleneck tile moved to the "In flight" section's blocked-chains
          diagram, where it has a bottleneck *per chain* rather than one
          headline number competing with the tide numbers for attention. */}
      <dl className="grid grid-cols-2 gap-2 min-[480px]:grid-cols-4 lg:flex-1">
        <Tile
          label="Waiting on you"
          value={needsYou}
          tone="attention"
          loud={needsYou > 0}
          onClick={() => onOpenStatuses([...HUMAN_ATTENTION_STATUSES])}
        />
        <Tile
          label="Under way"
          value={building}
          tone="info"
          onClick={() => onOpenStatuses(["in_progress"])}
        />
        <Tile
          label="Blocked"
          value={blockedTasks.length}
          tone="destructive"
          loud={blockedTasks.length > 0}
          sublabel={
            blockedTasks.length > 0
              ? `${blockedOnTasks} on tasks · ${blockedExternal} external`
              : undefined
          }
          onClick={() => onOpenStatuses(["blocked"])}
        />
        <Tile
          label={`Shipped · ${shippedWindow}`}
          value={shippedInWindow}
          tone="success"
          sublabel={`${shippedAllTime} done in total`}
          onClick={() => onOpenStatuses([...TERMINAL_TASK_STATUSES])}
        />
      </dl>
    </section>
  );
};
