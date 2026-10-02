import { type FloorSnapshot, type FloorTask, type TaskStatus } from "@estuary/contracts";
import { useState } from "react";
import { toast } from "sonner";
import { useReleaseTaskMutation } from "@/api/tasks";
import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { errorCopy, errorDescription } from "@/lib/errorMessages";
import { formatRelative } from "@/lib/formatting";
import { buildBlockedChains, type BlockedChain } from "@/features/floor/layout";
import { SectionHeader } from "@/pages/tasks-map/sections/SectionHeader";

/** Below this many minutes left on the lease, a claim card reads as urgent; at or below zero it's "stalled". */
const EXPIRING_SOON_MINUTES = 5;
const CHAIN_CAP = 6;

/**
 * Colour by status "zone" for the chain node pills — **not** the map's
 * `MapRegionKey` (which lumps `blocked`/`needs_user_decision`/`needs_user_action`
 * into one "waiting" region): the coordinator specifically asked for blocked
 * (pool-block) to read differently from needs-you (pool-attn).
 */
const STATUS_ZONE_CLASS: Record<TaskStatus, string> = {
  backlog: "border-border bg-map-panel-2 text-foreground",
  needs_refinement: "border-border bg-map-panel-2 text-foreground",
  todo: "border-border bg-map-panel-2 text-foreground",
  in_progress: "border-map-ok/60 bg-map-ok/10 text-foreground",
  needs_qa: "border-map-ok/60 bg-map-ok/10 text-foreground",
  blocked: "border-map-pool-block/60 bg-map-pool-block/10 text-foreground",
  needs_user_decision: "border-attention/60 bg-attention-subtle text-attention-subtle-foreground",
  needs_user_action: "border-attention/60 bg-attention-subtle text-attention-subtle-foreground",
  done: "border-border bg-map-panel-3 text-muted-foreground",
  deferred: "border-border bg-map-panel-3 text-muted-foreground",
};

const minutesLeftOf = (task: FloorTask): number | null =>
  task.claim === null
    ? null
    : Math.round((new Date(task.claim.expiresAt).getTime() - Date.now()) / 60_000);

/** A live claim whose lease has not expired. Everything else in progress (no claim, or an expired one) is "stalled" — the seed data is mostly the latter. */
const isLiveClaim = (task: FloorTask): boolean => {
  const minutesLeft = minutesLeftOf(task);
  return minutesLeft !== null && minutesLeft > 0;
};

/** `working + stalled + chains` — the same count the section header shows, exported so `MiniNav`'s badge can't drift from it. */
export const computeInFlightCount = (snapshot: FloorSnapshot): number => {
  const inProgress = snapshot.tasks.filter((task) => task.status === "in_progress");
  const chains = buildBlockedChains(snapshot.tasks, snapshot.edges);
  return inProgress.length + chains.length;
};

/**
 * Section 3, "In flight" — two columns at `>=1100px`: every `in_progress`
 * task (working vs. stalled), and the dependency graph's blocked chains.
 * Both read straight off the `FloorSnapshot` already fetched for the hero's
 * map card; no second query. The section's own count is `working.length +
 * stalled.length + chains.length` — exactly what's listed below it.
 */
export const InFlightSection = ({
  snapshot,
  onSelectTask,
}: {
  snapshot: FloorSnapshot;
  onSelectTask: (taskId: number) => void;
}) => {
  const inProgress = snapshot.tasks.filter((task) => task.status === "in_progress");
  const working = inProgress.filter(isLiveClaim);
  const stalled = inProgress.filter((task) => !isLiveClaim(task));
  const chains = buildBlockedChains(snapshot.tasks, snapshot.edges);

  return (
    <section id="in-flight" className="scroll-mt-28">
      <SectionHeader
        eyebrow="Agents & blockers"
        title="In flight"
        count={working.length + stalled.length + chains.length}
        tone="info"
      />
      <div className="mt-4 grid grid-cols-1 gap-6 min-[1100px]:grid-cols-2">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-foreground">Working ({working.length})</h3>
            {working.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                No agent is working right now.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {working.map((task) => (
                  <AgentCard key={task.id} task={task} onSelectTask={onSelectTask} />
                ))}
              </ul>
            )}
          </div>

          {stalled.length === 0 ? null : (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-attention">Stalled ({stalled.length})</h3>
              <p className="text-xs text-muted-foreground">
                In progress with no live claim — a lease expired, or nobody ever claimed it.
              </p>
              <ul className="flex flex-col divide-y divide-border rounded-lg border border-attention/40 bg-card shadow-raised">
                {stalled.map((task) => (
                  <StalledRow key={task.id} task={task} onSelectTask={onSelectTask} />
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-foreground">
            Blocked chains ({chains.length})
          </h3>
          {chains.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              Nothing is chain-blocked right now.
            </p>
          ) : (
            <BlockedChainsList chains={chains} onSelectTask={onSelectTask} />
          )}
        </div>
      </div>
    </section>
  );
};

const AgentCard = ({
  task,
  onSelectTask,
}: {
  task: FloorTask;
  onSelectTask: (taskId: number) => void;
}) => {
  const minutesLeft = minutesLeftOf(task);
  const expiringSoon =
    minutesLeft !== null && minutesLeft > 0 && minutesLeft <= EXPIRING_SOON_MINUTES;

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelectTask(task.id)}
        className="flex w-full flex-col gap-1 rounded-lg border border-border bg-card p-3 text-left text-sm shadow-raised transition-[background-color,box-shadow] hover:bg-muted hover:shadow-floating"
      >
        <span className="flex items-center justify-between gap-2">
          <span className="font-semibold text-foreground">
            {task.claim?.actor ?? task.assignee ?? "Unclaimed"}
          </span>
          <span className="font-mono text-xs text-muted-foreground">{task.reference}</span>
        </span>
        <span className="truncate text-foreground">{task.title}</span>
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {task.claim === null ? null : <span>claimed {formatRelative(task.updatedAt)}</span>}
          {minutesLeft === null ? null : (
            <span className={cn(expiringSoon && "font-semibold text-attention")}>
              lease {minutesLeft}m left
            </span>
          )}
        </span>
      </button>
    </li>
  );
};

/**
 * A stalled task, one compact row (not a tall card): agent badge/"no claim",
 * `#id title`, the amber lease line, and its actions — "Release" (the same
 * `useReleaseTaskMutation` the drawer's own claim section uses, only shown
 * when there is an actual claim object to release) and "Open".
 */
const StalledRow = ({
  task,
  onSelectTask,
}: {
  task: FloorTask;
  onSelectTask: (taskId: number) => void;
}) => {
  const releaseMutation = useReleaseTaskMutation(task.id);
  const leaseText =
    task.claim === null ? "no claim" : `lease expired ${formatRelative(task.claim.expiresAt)}`;

  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
      <span className="shrink-0 truncate font-medium text-foreground">
        {task.claim?.actor ?? task.assignee ?? "Unassigned"}
      </span>
      <button
        type="button"
        onClick={() => onSelectTask(task.id)}
        className="min-w-0 flex-1 truncate text-left text-foreground hover:underline"
      >
        <span className="font-mono text-xs text-muted-foreground">#{task.id}</span> {task.title}
      </button>
      <span className="shrink-0 text-xs font-semibold text-attention">{leaseText}</span>
      {task.claim === null ? null : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 text-xs"
          isLoading={releaseMutation.isPending}
          onClick={() =>
            releaseMutation.mutate(
              {},
              {
                onSuccess: () => toast.success(`Released — ${task.reference} is back in To do`),
                onError: (error) =>
                  toast.error(errorCopy(error).title, { description: errorDescription(error) }),
              },
            )
          }
        >
          Release
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 shrink-0 px-2 text-xs"
        onClick={() => onSelectTask(task.id)}
      >
        Open
      </Button>
    </li>
  );
};

const BlockedChainsList = ({
  chains,
  onSelectTask,
}: {
  chains: readonly BlockedChain[];
  onSelectTask: (taskId: number) => void;
}) => {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? chains : chains.slice(0, CHAIN_CAP);

  return (
    <div className="flex flex-col gap-3">
      {shown.map((chain) => (
        <ChainDiagram key={chain.key} chain={chain} onSelectTask={onSelectTask} />
      ))}
      {!showAll && chains.length > CHAIN_CAP ? (
        <button
          type="button"
          className="self-start text-xs text-primary hover:underline"
          onClick={() => setShowAll(true)}
        >
          Show all {chains.length}
        </button>
      ) : null}
    </div>
  );
};

/**
 * One chain as a small left→right node-link row, plus a one-line caption
 * ("#27 unblocks 2 · waiting on: in progress") naming the bottleneck and
 * what it's waiting on — the pills alone (2-line, ~180px) don't have room to
 * spell that out.
 */
const ChainDiagram = ({
  chain,
  onSelectTask,
}: {
  chain: BlockedChain;
  onSelectTask: (taskId: number) => void;
}) => {
  // Order nodes by their position in the edge list (blocker before dependent)
  // when possible, falling back to id order — a stable, readable left→right
  // read even though the underlying structure is a graph, not a line.
  const order = new Map<number, number>();
  chain.edges.forEach((edge, index) => {
    if (!order.has(edge.blockerId)) order.set(edge.blockerId, index * 2);
    if (!order.has(edge.dependentId)) order.set(edge.dependentId, index * 2 + 1);
  });
  const ordered = [...chain.nodes].sort(
    (a, b) => (order.get(a.taskId) ?? 999) - (order.get(b.taskId) ?? 999) || a.taskId - b.taskId,
  );

  const bottleneck = chain.nodes.find((node) => node.taskId === chain.bottleneckTaskId) ?? null;
  const statusLabelOf = (status: TaskStatus): string => status.replace(/_/g, " ");
  const waitingOn = [
    ...new Set(
      chain.edges
        .filter((edge) => !edge.satisfied)
        .map((edge) => chain.nodes.find((node) => node.taskId === edge.blockerId)?.status)
        .filter((status): status is TaskStatus => status !== undefined),
    ),
  ]
    .map(statusLabelOf)
    .join(", ");

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3 shadow-raised">
      <div
        role="group"
        aria-label={`Blocked chain of ${chain.nodes.length} tasks`}
        className="flex flex-wrap items-center gap-2"
      >
        {ordered.map((node, index) => (
          <span key={node.taskId} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onSelectTask(node.taskId)}
              title={node.title}
              className={cn(
                "line-clamp-2 h-11 w-[180px] overflow-hidden rounded-lg border px-2 py-1.5 text-left text-xs leading-snug font-medium break-words",
                STATUS_ZONE_CLASS[node.status],
                node.taskId === chain.bottleneckTaskId && "ring-2 ring-destructive",
              )}
            >
              #{node.taskId} {node.title}
            </button>
            {index < ordered.length - 1 ? (
              <span aria-hidden="true" className="shrink-0 text-muted-foreground">
                →
              </span>
            ) : null}
          </span>
        ))}
      </div>
      {bottleneck === null ? null : (
        <p className="text-xs text-muted-foreground">
          #{bottleneck.taskId} unblocks {bottleneck.unblocksCount}
          {waitingOn === "" ? "" : ` · waiting on: ${waitingOn}`}
        </p>
      )}
    </div>
  );
};
