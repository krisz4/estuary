import { type FloorSnapshot, type TaskEvent } from "@helpdesk/contracts";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useEventLogQuery } from "@/api/events";
import { useHistoryQuery } from "@/api/history";
import { ErrorPanel } from "@/components/ErrorPanel";
import { Skeleton } from "@/components/ui";
import { ActorBadge } from "@/features/tasks/ActorBadge";
import { describeEvent } from "@/features/tasks/ActivityTimeline";
import { throughputSeries } from "@/features/logbook/throughput";
import { formatAbsolute, formatRelative, toDateTimeAttribute } from "@/lib/formatting";
import { SectionHeader } from "@/pages/tasks-map/sections/SectionHeader";

const RECENT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const RECENT_EVENT_CAP = 12;

/**
 * "9am" / "2pm" — the hour a group of events falls in, in the viewer's local
 * time zone (matching the Logbook's own day/hour grouping conventions).
 */
const hourLabel = (iso: string): string => {
  const date = new Date(iso);
  const hour = date.getHours();
  const period = hour < 12 ? "am" : "pm";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}${period}`;
};

const groupByHour = (events: readonly TaskEvent[]): { label: string; events: TaskEvent[] }[] => {
  const groups: { label: string; events: TaskEvent[] }[] = [];
  for (const event of events) {
    const label = hourLabel(event.createdAt);
    const last = groups.at(-1);
    if (last !== undefined && last.label === label) last.events.push(event);
    else groups.push({ label, events: [event] });
  }
  return groups;
};

/**
 * Section 5, "Recently" — the last 24 hours as a compact timeline, grouped by
 * hour, plus a 7-day created-vs-shipped sparkline and a Logbook link.
 *
 * Reuses two pieces of the Logbook wholesale rather than rebuilding them:
 * `describeEvent` (the human-sentence formatter — "moved it from To do to In
 * progress", here with the task's ref/title appended since, unlike the
 * detail page's timeline, this list spans many tasks and "it" alone would be
 * ambiguous) and `throughputSeries` (the same pure created-vs-shipped
 * transform the Logbook's own throughput chart uses), fed by the same
 * `useEventLogQuery`/`useHistoryQuery` hooks the Logbook and hero briefing
 * already use.
 */
export const RecentlySection = ({ project, snapshot }: { project: readonly string[]; snapshot: FloorSnapshot }) => {
  // Fixed at mount rather than recomputed every render — recomputing it live
  // would shift the query's `from` on every render (a fresh `Date.now()` each
  // time), churning the query key and refetching for no reason.
  const [since] = useState(() => new Date(Date.now() - RECENT_LOOKBACK_MS).toISOString());
  const query = useEventLogQuery({ project, type: [], from: since });
  const events = (query.data?.pages[0]?.data ?? []).slice(0, RECENT_EVENT_CAP);
  const groups = groupByHour(events);

  const history = useHistoryQuery({ project, bucket: "day" });
  const points = history.data === undefined ? [] : throughputSeries(history.data.buckets);

  const taskById = new Map(snapshot.tasks.map((task) => [task.id, task] as const));
  const refById = new Map(snapshot.refs.map((ref) => [ref.id, ref] as const));
  const titleFor = (taskId: number): string | null => taskById.get(taskId)?.title ?? refById.get(taskId)?.title ?? null;

  return (
    <section id="recent" className="scroll-mt-28">
      <SectionHeader
        eyebrow="Last 24 hours"
        title="Recently"
        action={
          <Link to="/logbook" className="text-sm font-medium text-primary hover:underline">
            Open the Logbook →
          </Link>
        }
      />

      <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_260px]">
        <div>
          {query.isPending ? (
            <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading recent activity">
              {[1, 2, 3].map((n) => (
                <Skeleton key={n} className="h-8 w-full" />
              ))}
            </div>
          ) : query.error !== null && query.data === undefined ? (
            <ErrorPanel error={query.error} onRetry={() => void query.refetch()} isRetrying={query.isFetching} />
          ) : events.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing happened in the last 24 hours.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {groups.map((group) => (
                <div key={group.label} className="flex flex-col gap-1">
                  <p className="font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
                    {group.label}
                  </p>
                  <ul className="flex flex-col divide-y divide-border">
                    {group.events.map((event) => {
                      const { summary } = describeEvent(event);
                      return (
                        <li key={event.id} className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 py-1.5 text-sm">
                          <ActorBadge actor={event.actor} plain />
                          <span className="text-foreground">{summary}</span>
                          <Link
                            to={`/tasks/${event.taskId}`}
                            className="inline-flex min-w-0 items-baseline gap-1 text-primary hover:underline"
                          >
                            <span className="shrink-0 font-mono text-xs">#{event.taskId}</span>
                            {titleFor(event.taskId) === null ? null : (
                              <span className="truncate text-sm font-normal">{titleFor(event.taskId)}</span>
                            )}
                          </Link>
                          <time
                            dateTime={toDateTimeAttribute(event.createdAt)}
                            title={formatAbsolute(event.createdAt)}
                            className="ml-auto shrink-0 text-xs text-muted-foreground"
                          >
                            {formatRelative(event.createdAt)}
                          </time>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>

        <ThroughputSparkline points={points} isPending={history.isPending} />
      </div>
    </section>
  );
};

const ThroughputSparkline = ({
  points,
  isPending,
}: {
  points: ReturnType<typeof throughputSeries>;
  isPending: boolean;
}) => {
  if (isPending) return <Skeleton className="h-24 w-full rounded-lg" />;
  if (points.length === 0) return null;

  const max = Math.max(1, ...points.map((point) => Math.max(point.created, point.shipped)));
  const width = 240;
  const height = 72;
  const barWidth = width / (points.length * 2.5);

  return (
    <div className="rounded-lg border border-border bg-card p-3 shadow-raised">
      <p className="mb-2 text-xs font-semibold text-foreground">Created vs. shipped, last 7 days</p>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-16 w-full" role="img" aria-label="Created versus shipped tasks per day, last 7 days">
        {points.map((point, index) => {
          const groupX = (index / points.length) * width;
          const createdH = (point.created / max) * height;
          const shippedH = (point.shipped / max) * height;
          return (
            <g key={point.start}>
              <rect
                x={groupX}
                y={height - createdH}
                width={barWidth}
                height={createdH}
                className="fill-map-lane-1"
              />
              <rect
                x={groupX + barWidth + 1}
                y={height - shippedH}
                width={barWidth}
                height={shippedH}
                className="fill-map-ok"
              />
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-sm bg-map-lane-1" aria-hidden="true" /> Created
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-sm bg-map-ok" aria-hidden="true" /> Shipped
        </span>
      </div>
    </div>
  );
};
