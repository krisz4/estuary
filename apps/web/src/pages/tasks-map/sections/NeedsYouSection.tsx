import { type TaskSummary } from "@estuary/contracts";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { useInboxQuery } from "@/api/tasks";
import { EmptyState } from "@/components/EmptyState";
import { ErrorPanel } from "@/components/ErrorPanel";
import { Button, Skeleton } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatRelative } from "@/lib/formatting";
import { laneColor, readFloorColors } from "@/features/floor/scene";
import { projectColorIndex } from "@/features/floor/layout";
import { InboxItem } from "@/pages/inbox/InboxItem";
import { groupByAttentionKind } from "@/pages/inbox/attentionGroups";
import { SectionHeader } from "@/pages/tasks-map/sections/SectionHeader";
import { KindPill } from "@/pages/tasks-map/sections/KindPill";
import { useNeedsYouActions } from "@/pages/tasks-map/sections/useNeedsYouActions";

/**
 * Section 2, "Needs you" — the full human-attention queue, grouped
 * Decide/Act/Review. Each item is a **compact row**, collapsed by default
 * (one row per item, not one 400+px `InboxItem` card per item — twelve of
 * those ran to ~6,000px). Clicking a row — or `Enter` on it — expands it
 * inline into the real `InboxItem` (still **reused wholesale**, not
 * reimplemented: the expanded content is exactly what `/inbox` renders, so
 * `DecisionAnswer`, the transition mutations, and version-conflict handling
 * are the same code, not a copy). Only one row is expanded at a time.
 *
 * `docs/pages/Inbox.md` documents that this section is a second consumer.
 *
 * Grouped by `attentionKindOf` (`groupByAttentionKind`), the same partition
 * `/inbox` uses — six possible groups, not three: a question, a manual step,
 * or work to review are still the most common, but a task stuck in
 * `needs_refinement`, an agent-filed suggestion nobody triaged, or a `blocked`
 * task with no open dependency show up here too, so nothing an agent leaves
 * behind is invisible from the map.
 */

export const NeedsYouSection = ({
  project,
  projectOrder,
}: {
  project: readonly string[];
  projectOrder: readonly string[];
}) => {
  const { data, error, isPending, isFetching, refetch } = useInboxQuery(project);
  const tasks = data?.data ?? [];
  const total = data?.meta.total ?? 0;
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const groups = groupByAttentionKind(tasks);

  return (
    <section id="needs-you" className="scroll-mt-28">
      <SectionHeader eyebrow="Waiting on you" title="Needs you" count={total} tone="attention" />

      {error !== null && data !== undefined ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} isRetrying={isFetching} />
      ) : null}

      {isPending ? (
        <NeedsYouSkeleton />
      ) : error !== null && data === undefined ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} isRetrying={isFetching} />
      ) : groups.length === 0 ? (
        <EmptyState art="still-water" title="Nothing needs you." description="Slack water. Agents are on it." />
      ) : (
        <div className="mt-4 flex flex-col gap-6">
          {groups.map((group) => (
            <NeedsYouGroup
              key={group.kind}
              title={group.title}
              hint={group.hint}
              tasks={group.tasks}
              projectOrder={projectOrder}
              expandedId={expandedId}
              onToggle={(id) => setExpandedId((current) => (current === id ? null : id))}
            />
          ))}
        </div>
      )}
    </section>
  );
};

const NeedsYouGroup = ({
  title,
  hint,
  tasks,
  projectOrder,
  expandedId,
  onToggle,
}: {
  title: string;
  hint: string;
  tasks: TaskSummary[];
  projectOrder: readonly string[];
  expandedId: number | null;
  onToggle: (id: number) => void;
}) => (
  <div className="flex flex-col gap-2">
    <div className="flex flex-col gap-0.5">
      <h3 className="text-sm font-semibold text-foreground">
        {title} <span className="font-normal text-muted-foreground">({tasks.length})</span>
      </h3>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
    <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border border-l-[3px] border-l-attention bg-card shadow-raised">
      {tasks.map((task) => (
        <li key={task.id}>
          <NeedsYouRow
            task={task}
            projectOrder={projectOrder}
            expanded={expandedId === task.id}
            onToggle={() => onToggle(task.id)}
          />
        </li>
      ))}
    </ul>
  </div>
);

const NeedsYouRow = ({
  task,
  projectOrder,
  expanded,
  onToggle,
}: {
  task: TaskSummary;
  projectOrder: readonly string[];
  expanded: boolean;
  onToggle: () => void;
}) => {
  const { kind, runPrimary, primaryLabel, isPrimaryPending } = useNeedsYouActions(task);
  const dotColor = laneColor(projectColorIndex(task.project, projectOrder), readFloorColors());

  return (
    <div>
      {/* Two siblings, not one interactive element nested inside another: the
          row toggle is its own `<button>`, and the quick action is a second,
          separate `<button>` next to it — a real button inside a
          `role="button"` div is invalid nested-interactive markup. */}
      <div className="flex items-center gap-2 px-1 py-1 text-sm">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-muted"
        >
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
            aria-hidden="true"
          />
          {kind === null ? null : <KindPill kind={kind} />}
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{task.reference}</span>
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">{task.title}</span>
          <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
            <span
              className="size-1.5 rounded-full"
              style={{ backgroundColor: dotColor }}
              aria-hidden="true"
            />
            {task.project ?? "no project"}
          </span>
          <time className="hidden shrink-0 text-xs text-muted-foreground md:inline">
            waiting since {formatRelative(task.updatedAt)}
          </time>
        </button>
        {primaryLabel === null || runPrimary === null ? null : (
          <Button
            type="button"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs"
            isLoading={isPrimaryPending}
            onClick={runPrimary}
          >
            {primaryLabel}
          </Button>
        )}
      </div>
      {expanded ? (
        <div className="border-t border-border bg-background/60 p-3">
          <InboxItem task={task} />
        </div>
      ) : null}
    </div>
  );
};

const NeedsYouSkeleton = () => (
  <div className="mt-4 flex flex-col gap-3" aria-busy="true" aria-label="Loading needs you">
    {[1, 2].map((n) => (
      <Skeleton key={n} className="h-10 w-full rounded-lg" />
    ))}
  </div>
);
