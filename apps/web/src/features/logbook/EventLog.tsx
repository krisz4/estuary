import { TASK_EVENT_TYPES, type EventsResponse, type TaskEvent, type TaskEventType } from "@helpdesk/contracts";
import { Route } from "lucide-react";
import { Link } from "react-router-dom";
import { type InfiniteData, type UseInfiniteQueryResult } from "@tanstack/react-query";
import { EmptyState } from "@/components/EmptyState";
import { ErrorPanel } from "@/components/ErrorPanel";
import { Button, Input, Select, Skeleton } from "@/components/ui";
import { ActorBadge } from "@/features/tasks/ActorBadge";
import { describeEvent } from "@/features/tasks/ActivityTimeline";
import { formatAbsolute, formatDate, formatRelative, toDateTimeAttribute } from "@/lib/formatting";

const EVENT_TYPE_ANY = "__any__";

const EVENT_TYPE_LABELS: Record<TaskEventType, string> = {
  "task.created": "Task created",
  "task.updated": "Task updated",
  "task.deleted": "Task deleted",
  "task.status_changed": "Status changed",
  "task.claimed": "Claimed",
  "task.released": "Released",
  "comment.created": "Comment added",
  "comment.deleted": "Comment deleted",
  "decision.requested": "Decision requested",
  "decision.answered": "Decision answered",
  "decision.withdrawn": "Decision withdrawn",
  "dependency.added": "Dependency added",
  "dependency.removed": "Dependency removed",
  "github.pull_request": "GitHub pull request",
};

export type EventLogFilters = {
  actor: string;
  type: TaskEventType[];
};

export type EventLogProps = {
  query: UseInfiniteQueryResult<InfiniteData<EventsResponse, number | undefined>>;
  filters: EventLogFilters;
  onFiltersChange: (filters: EventLogFilters) => void;
  hasAnyFilter: boolean;
};

/**
 * Groups newest-first events by calendar day, in the viewer's local time zone.
 *
 * `formatDate` (not `formatDateOnly`, which expects a bare `YYYY-MM-DD` filter
 * bound) — `createdAt` is a full instant, and the local calendar day it falls
 * on is exactly what a reader means by "grouped by day".
 */
const groupByDay = (events: TaskEvent[]): { day: string; events: TaskEvent[] }[] => {
  const groups: { day: string; events: TaskEvent[] }[] = [];
  for (const event of events) {
    const day = formatDate(event.createdAt);
    const last = groups.at(-1);
    if (last !== undefined && last.day === day) last.events.push(event);
    else groups.push({ day, events: [event] });
  }
  return groups;
};

/**
 * Section 7: the event log. Newest first, grouped by day, filterable by actor
 * and type, with "load older" (`useEventLogQuery`'s infinite pages). Each row
 * links to its task and offers "Replay on the map".
 */
export const EventLog = ({ query, filters, onFiltersChange, hasAnyFilter }: EventLogProps) => {
  const events = query.data?.pages.flatMap((page) => page.data) ?? [];
  const groups = groupByDay(events);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Actor</span>
          <Input
            value={filters.actor}
            onChange={(event) => onFiltersChange({ ...filters, actor: event.target.value })}
            placeholder="agent:claude-code"
            className="w-48"
            aria-label="Filter event log by actor"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Type</span>
          <Select
            value={filters.type[0] ?? EVENT_TYPE_ANY}
            onValueChange={(value) =>
              onFiltersChange({ ...filters, type: value === EVENT_TYPE_ANY ? [] : [value as TaskEventType] })
            }
            aria-label="Filter event log by type"
            options={[
              { value: EVENT_TYPE_ANY, label: "Any type" },
              ...TASK_EVENT_TYPES.map((type) => ({ value: type, label: EVENT_TYPE_LABELS[type] })),
            ]}
          />
        </label>
      </div>

      {query.isPending ? (
        <EventLogSkeleton />
      ) : query.error !== null && query.data === undefined ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} isRetrying={query.isFetching} />
      ) : events.length === 0 ? (
        <EmptyState
          title={hasAnyFilter ? "No events match" : "No events in this range"}
          description={
            hasAnyFilter
              ? "Try a different actor, type, or range."
              : "Nothing has been written to the log for this scope and range yet."
          }
          action={
            hasAnyFilter ? (
              <Button variant="outline" onClick={() => onFiltersChange({ actor: "", type: [] })}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {groups.map((group) => (
            <section key={group.day} aria-label={group.day} className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {group.day}
              </h3>
              <ol className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card shadow-raised">
                {group.events.map((event) => (
                  <EventRow key={event.id} event={event} />
                ))}
              </ol>
            </section>
          ))}

          {query.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              isLoading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              Load older events
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
};

const EventRow = ({ event }: { event: TaskEvent }) => {
  const { summary } = describeEvent(event);
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm">
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5">
        <ActorBadge actor={event.actor} plain />
        <span className="text-foreground">{summary}</span>
        {/*
          Mono `#id` + sans title, matching the Map's `RecentlySection`
          convention. `line-clamp-2 sm:line-clamp-1` — 1 line at `sm` and up,
          2 on phone, rather than a hard `truncate` everywhere: the full
          `TASK-000042` reference plus a single truncated line was cutting
          titles down to a handful of characters on a narrow card (see
          `LongestWaitsList` for the same fix). `taskTitle` is `null` once the
          task has been deleted — shown as a muted, non-link-coloured note
          rather than blank space.
        */}
        <Link
          to={`/tasks/${event.taskId}`}
          className="inline-flex min-w-0 max-w-full items-baseline gap-1.5 text-primary hover:underline"
        >
          <span className="shrink-0 font-mono text-xs">#{event.taskId}</span>
          {event.taskTitle === null ? (
            <span className="text-sm font-normal text-muted-foreground italic">deleted task</span>
          ) : (
            <span className="line-clamp-2 min-w-0 text-sm font-normal text-foreground sm:line-clamp-1">
              {event.taskTitle}
            </span>
          )}
        </Link>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <time
          dateTime={toDateTimeAttribute(event.createdAt)}
          title={formatAbsolute(event.createdAt)}
          className="text-xs text-muted-foreground"
        >
          {formatRelative(event.createdAt)}
        </time>
        <Link
          to={`/tasks/map?at=${encodeURIComponent(event.createdAt)}`}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary hover:underline"
        >
          <Route className="size-3.5" aria-hidden="true" />
          Replay on the map
        </Link>
      </div>
    </li>
  );
};

const EventLogSkeleton = () => (
  <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading events">
    {Array.from({ length: 4 }, (_, index) => (
      <Skeleton key={index} className="h-10 w-full" />
    ))}
  </div>
);
