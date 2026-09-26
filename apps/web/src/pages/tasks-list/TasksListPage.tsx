import { FilterX, GitPullRequest, Inbox, Plus } from "lucide-react";
import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { EmptyState } from "@/components/EmptyState";
import { ErrorPanel } from "@/components/ErrorPanel";
import { Pagination } from "@/components/Pagination";
import { Button } from "@/components/ui";
import { useGithubIntegrationQuery } from "@/api/github";
import { useTaskFacetsQuery, useTasksQuery } from "@/api/tasks";
import { TaskCardList, TaskCardListSkeleton } from "@/features/tasks/TaskCardList";
import { TaskFilterBar } from "@/features/tasks/TaskFilterBar";
import { TaskTable, TaskTableSkeleton } from "@/features/tasks/TaskTable";
import { ViewSwitch } from "@/features/tasks/ViewSwitch";
import { GithubImportDialog } from "@/features/tasks/GithubImportDialog";
import { cn } from "@/lib/cn";
import { formatCount } from "@/lib/formatting";
import { MD_BREAKPOINT_QUERY, useMediaQuery } from "@/lib/useMediaQuery";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { useTaskListParams } from "@/pages/tasks-list/useTaskListParams";
import { useRememberProjectScope } from "@/stores/projectScope";
import { useRememberTaskView } from "@/stores/taskView";

/**
 * `/tasks` — the landing screen. Spec: `docs/pages/Tasks_List.md`.
 *
 * The page owns no list state of its own. Everything a user can change lives in
 * the URL through `useTaskListParams()`, which is what makes a filtered view
 * shareable, survive reload, and step backwards correctly. Nothing here is
 * mirrored into `useState`, and no fetched data is copied out of TanStack Query.
 *
 * The page polls (`api/polling.ts`), so tasks an agent files or moves appear
 * without a reload; `keepPreviousData` means a poll dims nothing that was not
 * already on screen.
 *
 * **There is no default status filter.** A bare `/tasks` shows everything, so
 * "nothing exists" and "nothing matches" stay distinguishable and a shared
 * link means exactly what it says. The filter bar's "Open work" preset is the
 * one-click "hide the closed lane".
 */
export const TasksListPage = () => {
  useDocumentTitle("Tasks");

  /*
    The one piece of *user* state this screen records: which view they are in,
    so a task opened from here comes back to here rather than to the map.
    The list's own state stays in the URL — see `stores/taskView.ts` for why
    the view is the exception.
  */
  useRememberTaskView("list");

  const { params, setPage, setPageSize, setSort, setFilters, clearFilters, activeFilterCount } =
    useTaskListParams();
  useRememberProjectScope(params.project);

  /**
   * `md` decides which of two different components renders — not which of two
   * rendered components is visible. See `MD_BREAKPOINT_QUERY`.
   */
  const isWide = useMediaQuery(MD_BREAKPOINT_QUERY);

  const facetsQuery = useTaskFacetsQuery();
  const tasksQuery = useTasksQuery(params);

  const githubIntegrationQuery = useGithubIntegrationQuery();
  const isGithubEnabled = githubIntegrationQuery.data?.enabled === true;
  const [isImportOpen, setImportOpen] = useState(false);

  const { data, error, isPending, isFetching, isPlaceholderData, refetch } = tasksQuery;

  const tasks = data?.data ?? [];
  const meta = data?.meta;

  /**
   * The *previous* page's rows on screen while the next one loads: dim them and
   * mark them busy rather than tearing them down for a skeleton.
   * `isPlaceholderData` is true exactly when `keepPreviousData` is showing the
   * last page's rows for a new request — a page or filter change.
   *
   * Deliberately **not** `isFetching`: the list polls every fifteen seconds, and
   * a table that dims itself on a timer, for a refresh that usually changes
   * nothing, reads as broken.
   */
  const isRefreshing = isPlaceholderData;

  const hasFilters = activeFilterCount > 0;

  return (
    <div className="flex flex-col gap-4">
      {/*
        No "New task" button here: `AppHeader` already renders one on every
        screen, and the design guidelines allow one primary action per view. Two
        identical buttons 60px apart is not redundancy, it is a question about
        whether they do the same thing.
      */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Tasks</h1>
          <p className="text-sm text-muted-foreground">
            Everything humans and agents are working on, newest first by default.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isGithubEnabled ? (
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <GitPullRequest aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">Import issue</span>
            </Button>
          ) : null}

          {/*
            The switch carries the current search string to `/tasks/map`,
            which reads the same filters out of the URL — see `ViewSwitch`.
          */}
          <ViewSwitch />
        </div>
      </header>

      {isGithubEnabled ? (
        <GithubImportDialog open={isImportOpen} onOpenChange={setImportOpen} />
      ) : null}

      <TaskFilterBar
        params={params}
        facets={facetsQuery.data}
        onFiltersChange={setFilters}
        onSortChange={setSort}
        onClear={clearFilters}
        activeFilterCount={activeFilterCount}
        isWide={isWide}
      />

      {/*
        Announced, not shown — the visible count already sits in the pager's
        "Showing 1–20 of 63". A screen-reader user gets no layout to scan, so a
        filter change would otherwise be silent.
      */}
      <p aria-live="polite" className="sr-only">
        {meta === undefined ? "" : `${formatCount(meta.total, "task")} found`}
      </p>

      {/* A failed background refresh keeps the stale rows and explains itself above them. */}
      {error !== null && data !== undefined ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} isRetrying={isFetching} />
      ) : null}

      {isPending ? (
        isWide ? (
          <TaskTableSkeleton />
        ) : (
          <TaskCardListSkeleton />
        )
      ) : error !== null && data === undefined ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} isRetrying={isFetching} />
      ) : tasks.length === 0 ? (
        <ListEmptyState
          hasFilters={hasFilters}
          isPastEnd={meta !== undefined && meta.total > 0 && params.page > 1}
          onClearFilters={clearFilters}
          onFirstPage={() => setPage(1)}
        />
      ) : (
        <div
          aria-busy={isRefreshing || undefined}
          className={cn("transition-opacity", isRefreshing && "opacity-60")}
        >
          {isWide ? (
            <TaskTable
              tasks={tasks}
              sort={params.sort}
              onSortChange={setSort}
              searchQuery={params.q}
            />
          ) : (
            <TaskCardList tasks={tasks} searchQuery={params.q} />
          )}
        </div>
      )}

      {meta === undefined || (tasks.length === 0 && meta.total === 0) ? null : (
        <Pagination meta={meta} onPageChange={setPage} onPageSizeChange={setPageSize} />
      )}
    </div>
  );
};

/**
 * The empty state, in its three genuinely different flavours.
 *
 * "Nothing exists" and "nothing matches" are not the same screen: offering
 * "Create the first task" to someone whose filter is too narrow is the wrong
 * answer, and offering "Clear filters" to someone with an empty database is a
 * dead end. The third case — a real result set, but the URL points past its last
 * page — has its own action again, because clearing filters would throw away a
 * query that is working fine.
 */
const ListEmptyState = ({
  hasFilters,
  isPastEnd,
  onClearFilters,
  onFirstPage,
}: {
  hasFilters: boolean;
  isPastEnd: boolean;
  onClearFilters: () => void;
  onFirstPage: () => void;
}) => {
  const { search } = useLocation();

  if (isPastEnd) {
    return (
      <EmptyState
        icon={Inbox}
        title="Nothing on this page"
        description="This page is past the end of the current result set."
        action={<Button onClick={onFirstPage}>Back to page 1</Button>}
      />
    );
  }

  if (hasFilters) {
    return (
      <EmptyState
        icon={FilterX}
        title="No tasks match these filters"
        description="Try removing a filter or widening the date range."
        action={
          <Button variant="outline" onClick={onClearFilters}>
            Clear filters
          </Button>
        }
      />
    );
  }

  return (
    <EmptyState
      icon={Inbox}
      title="No tasks yet"
      description="Create one here, or let an agent file them through the MCP server — they show up here either way."
      action={
        <Button asChild>
          {/* Same `{ from }` the rows attach, so cancelling out of the form
              comes back to this URL rather than a bare `/tasks`. */}
          <Link to="/tasks/new" state={search === "" ? undefined : { from: search }}>
            <Plus aria-hidden="true" />
            Create the first task
          </Link>
        </Button>
      }
    />
  );
};
