import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useEventLogQuery } from "@/api/events";
import { useHistoryQuery } from "@/api/history";
import { useArchiveQuery } from "@/api/tasks";
import { ErrorPanel } from "@/components/ErrorPanel";
import { Skeleton } from "@/components/ui";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { AgentsTable } from "@/features/logbook/AgentsTable";
import { ArchiveTable } from "@/features/logbook/ArchiveTable";
import { cfdByStatus, cfdByZone } from "@/features/logbook/cfd";
import { CumulativeFlowChart } from "@/features/logbook/CumulativeFlowChart";
import { statusColor, zoneColor } from "@/features/logbook/chartColors";
import { CycleTimeDotStrip } from "@/features/logbook/CycleTimeDotStrip";
import { groupCycleTimesByAgent } from "@/features/logbook/cycleTime";
import { EventLog } from "@/features/logbook/EventLog";
import { KpiRow } from "@/features/logbook/KpiRow";
import { LogbookMiniNav, type LogbookMiniNavSection } from "@/features/logbook/LogbookMiniNav";
import { LongestWaitsList } from "@/features/logbook/LongestWaitsList";
import { RangeControl } from "@/features/logbook/RangeControl";
import { resolveLogbookWindow } from "@/features/logbook/range";
import { sinceYouLeftSummary } from "@/features/logbook/sinceYouLeft";
import { SinceYouLeftPanel } from "@/features/logbook/SinceYouLeftPanel";
import { throughputSeries } from "@/features/logbook/throughput";
import { ThroughputChart } from "@/features/logbook/ThroughputChart";
import { waitingSeries } from "@/features/logbook/waiting";
import { WaitingChart } from "@/features/logbook/WaitingChart";
import { useLastVisit } from "@/stores/logbookVisit";
import { useLogbookParams } from "@/pages/logbook/useLogbookParams";
import { useRememberProjectScope } from "@/stores/projectScope";
import { SectionHeader } from "@/pages/tasks-map/sections/SectionHeader";

const NAV_SECTIONS: LogbookMiniNavSection[] = [
  { id: "flow", label: "Flow" },
  { id: "throughput", label: "Throughput" },
  { id: "waiting", label: "Waiting" },
  { id: "cycle-time", label: "Cycle time" },
  { id: "agents", label: "Agents" },
  { id: "event-log", label: "Event log" },
  { id: "archive", label: "Archive" },
];

/**
 * `/logbook` — the history companion to the floor. Spec: `docs/pages/Logbook.md`.
 *
 * "First look… harmonic, only the most relevant data": the top area (range +
 * since-you-left sentence, then four KPI tiles) fits in one glance before the
 * Flow chart — the hero graphic — anchors the fold. Everything past that is
 * the same eight-section structure the page always had, now under
 * `SectionHeader`s that match the Map's, with a sticky scroll-spy nav once
 * the top area scrolls out of view.
 *
 * One `useHistoryQuery` backs the KPI tiles and the four charts + the agents
 * table: they are all views over the same bucketed response, so a single
 * loading/error state (and a single retry) covers all of them. The event log
 * and archive are independently paged/filterable sections with their own
 * queries, per the plan.
 */
export const LogbookPage = () => {
  useDocumentTitle("Logbook");

  const params = useLogbookParams();
  useRememberProjectScope(params.project);
  const lastVisitAt = useLastVisit();
  const [cfdMode, setCfdMode] = useState<"zones" | "all">("zones");

  const window = resolveLogbookWindow(params.range, { from: params.from, to: params.to });

  const historyQuery = useHistoryQuery({
    project: params.project,
    from: window.from,
    to: window.to,
    bucket: window.bucket,
  });

  const eventLogQuery = useEventLogQuery({
    project: params.project,
    actor: params.actor === "" ? undefined : params.actor,
    type: params.type,
  });

  const archiveQuery = useArchiveQuery({
    project: params.project,
    q: params.archiveQ,
    page: params.archivePage,
    pageSize: params.archivePageSize,
  });

  const events = eventLogQuery.data?.pages.flatMap((page) => page.data) ?? [];
  const sinceYouLeft = sinceYouLeftSummary(events, lastVisitAt);

  return (
    <div className="flex flex-col gap-10">
      <div id="logbook-top" className="flex flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-foreground">Logbook</h1>
          <p className="text-sm text-muted-foreground">
            History for {params.project.length > 0 ? params.project.join(", ") : "every project"}.{" "}
            <Link to="/logbook#archive" className="font-medium text-primary underline-offset-4 hover:underline">
              Jump to the archive
            </Link>
          </p>
        </header>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <SinceYouLeftPanel summary={sinceYouLeft} lastVisitAt={lastVisitAt} />
          </div>
          <RangeControl range={params.range} onRangeChange={(range) => params.setRange(range)} />
        </div>

        <KpiRow data={historyQuery.data} isPending={historyQuery.isPending} />
      </div>

      {/*
       * `LogbookMiniNav`'s sentinel — mirrors the Map's `#hero-end`: an
       * out-of-flow marker at the bottom of the "first screen" area, so the
       * nav appears exactly once that area has scrolled past.
       */}
      <div id="logbook-top-end" aria-hidden="true" className="pointer-events-none -mt-10 h-px" />
      <LogbookMiniNav sections={NAV_SECTIONS} topSentinelId="logbook-top-end" />

      <Section
        id="flow"
        eyebrow="Cumulative flow diagram"
        title="Flow"
        description="Banded by the floor's four zones. A widening Waiting dock band is a bottleneck you can see."
        action={
          <div role="group" aria-label="Flow detail" className="inline-flex gap-1 rounded-md border border-border p-1 text-xs">
            {(["zones", "all"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={cfdMode === mode}
                onClick={() => setCfdMode(mode)}
                className={
                  "rounded px-2 py-1 font-medium " +
                  (cfdMode === mode ? "bg-primary text-primary-foreground" : "text-muted-foreground")
                }
              >
                {mode === "zones" ? "4 zones" : "All statuses"}
              </button>
            ))}
          </div>
        }
      >
        <HistorySection query={historyQuery} empty="No task activity in this range yet.">
          {(data) =>
            cfdMode === "zones" ? (
              <CumulativeFlowChart
                series={cfdByZone(data.buckets)}
                colorOf={zoneColor}
                title="Tasks per zone over time"
              />
            ) : (
              <CumulativeFlowChart
                series={cfdByStatus(data.buckets)}
                colorOf={statusColor}
                title="Tasks per status over time"
              />
            )
          }
        </HistorySection>
      </Section>

      <Section
        id="throughput"
        eyebrow="Created vs. shipped"
        title="Throughput"
        description="Created versus shipped tasks per bucket, and how many were sent back from QA."
      >
        <HistorySection query={historyQuery} empty="Nothing was created or shipped in this range.">
          {(data) => <ThroughputChart points={throughputSeries(data.buckets)} />}
        </HistorySection>
      </Section>

      <Section
        id="waiting"
        eyebrow="Median · p90 · longest waits"
        title="Waiting on humans"
        description="Median and p90 minutes spent in a decide, act, or review status, plus the longest waits in range."
      >
        <HistorySection query={historyQuery} empty="No one waited on a human in this range.">
          {(data) => (
            <div className="flex flex-col gap-6">
              <WaitingChart points={waitingSeries(data.buckets)} />
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-foreground">Longest waits</h3>
                <LongestWaitsList waits={data.longestWaits} />
              </div>
            </div>
          )}
        </HistorySection>
      </Section>

      <Section
        id="cycle-time"
        eyebrow="In progress → done / needs QA"
        title="Cycle time"
        description="One dot per finished pass, split by agent."
      >
        <HistorySection query={historyQuery} empty="No cycle times finished in this range.">
          {(data) => <CycleTimeDotStrip lanes={groupCycleTimesByAgent(data.cycleTimes)} />}
        </HistorySection>
      </Section>

      <Section
        id="agents"
        eyebrow="Per-agent activity"
        title="Agents"
        count={historyQuery.data?.agents.length}
        description="Tasks shipped, QA pass rate, decisions asked, claims and releases."
      >
        <HistorySection query={historyQuery} empty="No agent activity in this range.">
          {(data) => <AgentsTable agents={data.agents} />}
        </HistorySection>
      </Section>

      <Section id="event-log" eyebrow="Every write, newest first" title="Event log" description="Grouped by day.">
        <EventLog
          query={eventLogQuery}
          filters={{ actor: params.actor, type: params.type }}
          onFiltersChange={(next) => {
            params.setActor(next.actor);
            params.setType(next.type);
          }}
          hasAnyFilter={params.actor !== "" || params.type.length > 0}
        />
      </Section>

      <Section
        id="archive"
        eyebrow="Done & deferred"
        title="Archive"
        count={archiveQuery.data?.meta.total}
        description="Most recently completed first."
      >
        <ArchiveTable
          query={archiveQuery}
          q={params.archiveQ}
          onQChange={params.setArchiveQ}
          page={params.archivePage}
          onPageChange={params.setArchivePage}
          pageSize={params.archivePageSize}
          onPageSizeChange={params.setArchivePageSize}
        />
      </Section>
    </div>
  );
};

const Section = ({
  id,
  eyebrow,
  title,
  count,
  description,
  action,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  count?: number;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) => (
  <section id={id} aria-label={title} className="scroll-mt-28">
    <SectionHeader eyebrow={eyebrow} title={title} count={count} action={action} />
    {description === undefined ? null : (
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{description}</p>
    )}
    <div className="mt-4">{children}</div>
  </section>
);

/** Shared loading/error/empty wiring for the sections driven by `useHistoryQuery`. */
const HistorySection = ({
  query,
  empty,
  children,
}: {
  query: ReturnType<typeof useHistoryQuery>;
  empty: string;
  children: (data: NonNullable<typeof query.data>) => ReactNode;
}) => {
  if (query.isPending) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-52 w-full" />
      </div>
    );
  }
  if (query.error !== null && query.data === undefined) {
    return <ErrorPanel error={query.error} onRetry={() => void query.refetch()} isRetrying={query.isFetching} />;
  }
  if (query.data === undefined) return null;
  if (query.data.buckets.every((bucket) => bucket.created === 0 && bucket.completed === 0 && bucket.deferred === 0)) {
    return <p className="text-sm text-muted-foreground">{empty}</p>;
  }
  return <>{children(query.data)}</>;
};
