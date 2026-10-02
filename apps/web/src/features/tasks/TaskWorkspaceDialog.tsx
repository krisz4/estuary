import { CREATABLE_TASK_STATUSES, type TaskStatus } from "@estuary/contracts";
import { ArrowLeft, FilterX, Inbox, List, Plus, SlidersHorizontal } from "lucide-react";
import { useCallback, useId, useState } from "react";
import { Link } from "react-router-dom";
import { useTaskFacetsQuery, useTasksQuery } from "@/api/tasks";
import { EmptyState } from "@/components/EmptyState";
import { ErrorPanel } from "@/components/ErrorPanel";
import { Pagination } from "@/components/Pagination";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatCount } from "@/lib/formatting";
import { LG_BREAKPOINT_QUERY, MD_BREAKPOINT_QUERY, useMediaQuery } from "@/lib/useMediaQuery";
import { TaskCardList, TaskCardListSkeleton } from "@/features/tasks/TaskCardList";
import { TaskDetailView } from "@/features/tasks/TaskDetailView";
import { ActiveFilterChips, FilterControls, SearchInput } from "@/features/tasks/TaskFilterBar";
import { TaskTable, TaskTableSkeleton } from "@/features/tasks/TaskTable";
import {
  useLocalTaskListParams,
  type LocalTaskListParamsApi,
} from "@/features/tasks/useLocalTaskListParams";
import {
  DEFAULT_TASK_LIST_PARAMS,
  serializeTaskListParams,
  type TaskListParams,
} from "@/pages/tasks-list/useTaskListParams";

export type TaskWorkspaceDialogProps = {
  /**
   * The list it was opened for, from a station or briefing tile: its title
   * ("Backlog", "Waiting on you" — it stays put while filters change) and the
   * params it opens on. Absent when a task was opened directly (a bead).
   */
  list?: { title: string; initialParams: TaskListParams };
  /** The open task, if any — shown in place of the list. */
  taskId?: number;
  /** Open a task in place: a list row, or the task view's chain navigator. */
  onOpenTask: (taskId: number) => void;
  /** Task view → back to the list it came from (only offered with `list`). */
  onBackToList: () => void;
  /** Close the whole dialog. */
  onClose: () => void;
  /** The map's replay instant — the task view goes read-only while set. */
  replayingAt?: string;
  onBackToNow?: () => void;
};

const DIALOG_CLASSES = cn(
  "gap-0 overflow-hidden p-0",
  // Full screen on a phone; a large centred panel from `sm`.
  "inset-0 h-dvh max-h-none rounded-none",
  "sm:inset-auto sm:top-1/2 sm:left-1/2 sm:h-[90vh] sm:w-[min(96vw,1600px)] sm:max-w-none sm:rounded-xl sm:p-0",
);

/**
 * The map's one large dialog — a list of tasks and the tasks themselves share
 * it; nothing stacks a second dialog on top. Spec: `docs/pages/Tasks_Map.md`
 * § Task modal.
 *
 * - **List view** (`list`, no `taskId`): filters in a left rail, the list
 *   taking the rest of the width. Opened from a station or briefing tile
 *   **instead of** filtering the map — the map behind keeps showing everything.
 * - **Task view** (`taskId`): `TaskDetailView`'s `dialog` variant, full width —
 *   description, criteria, decision, comments, activity beside a properties
 *   column. From a list, "← Backlog" (or Escape) goes back to it with its
 *   filters intact; a task opened straight from a bead has no list to go back
 *   to, so Escape closes.
 *
 * The list's refinements live in `useLocalTaskListParams` here — above both
 * views, so they survive a trip into a task — not in the URL, because the
 * URL's list keys belong to the map underneath. What *is* in the URL is which
 * view is open: the map's `?list=` and `?task=` keys, so Back steps between
 * them. Below `md` it is a full-screen sheet and the filter rail folds behind a
 * "Filters" toggle.
 */
export const TaskWorkspaceDialog = ({
  list,
  taskId,
  onOpenTask,
  onBackToList,
  onClose,
  replayingAt,
  onBackToNow,
}: TaskWorkspaceDialogProps) => {
  const listApi = useLocalTaskListParams(list?.initialParams ?? DEFAULT_TASK_LIST_PARAMS);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        className={DIALOG_CLASSES}
        // Escape in a task opened from a list steps back to that list first.
        onEscapeKeyDown={(event) => {
          if (taskId !== undefined && list !== undefined) {
            event.preventDefault();
            onBackToList();
          }
        }}
      >
        {taskId !== undefined ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-4 pt-4 pr-12 sm:p-6 sm:pr-14">
            <TaskDetailView
              // A new task starts clean — no half-open transition dialog carried over.
              key={taskId}
              taskId={taskId}
              variant="dialog"
              headerStart={
                list === undefined ? undefined : (
                  <Button variant="ghost" size="sm" className="-ml-2 w-fit" onClick={onBackToList}>
                    <ArrowLeft aria-hidden="true" />
                    {list.title}
                  </Button>
                )
              }
              onNavigate={onOpenTask}
              onDeleted={list === undefined ? onClose : onBackToList}
              replayingAt={replayingAt}
              onBackToNow={onBackToNow}
            />
          </div>
        ) : list !== undefined ? (
          <ListView title={list.title} listApi={listApi} onOpenTask={onOpenTask} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
};

const ListView = ({
  title,
  listApi,
  onOpenTask,
}: {
  title: string;
  listApi: LocalTaskListParamsApi;
  onOpenTask: (taskId: number) => void;
}) => {
  const {
    params,
    setPage,
    setPageSize,
    setSort,
    setFilters,
    clearFilters,
    resetFilters,
    isInitialFilters,
    activeFilterCount,
  } = listApi;

  const isWide = useMediaQuery(MD_BREAKPOINT_QUERY);
  const showTable = useMediaQuery(LG_BREAKPOINT_QUERY);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersId = useId();

  const facetsQuery = useTaskFacetsQuery();
  const tasksQuery = useTasksQuery(params);
  const { data, error, isPending, isFetching, isPlaceholderData, refetch } = tasksQuery;
  const tasks = data?.data ?? [];
  const meta = data?.meta;

  // Stable, so `SearchInput`'s debounce effect isn't torn down every render.
  const commitSearch = useCallback(
    (next: string | undefined) => setFilters({ q: next }),
    [setFilters],
  );

  const fullListHref = `/tasks?${serializeTaskListParams(params).toString()}`;
  const onlyStatus = params.status.length === 1 ? params.status[0] : undefined;
  const createStatus: TaskStatus | undefined =
    onlyStatus !== undefined &&
    (CREATABLE_TASK_STATUSES as readonly TaskStatus[]).includes(onlyStatus)
      ? onlyStatus
      : undefined;

  return (
    <>
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3 pr-12 sm:px-6">
        <div className="flex min-w-0 flex-col">
          <DialogTitle className="text-lg">{title}</DialogTitle>
          <DialogDescription>
            {meta === undefined ? "Loading tasks…" : formatCount(meta.total, "task")}
          </DialogDescription>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {isWide ? null : (
            <Button
              variant="outline"
              size="sm"
              aria-expanded={filtersOpen}
              aria-controls={filtersId}
              onClick={() => setFiltersOpen((open) => !open)}
            >
              <SlidersHorizontal aria-hidden="true" />
              Filters
              {activeFilterCount > 0 ? (
                <span className="ml-1 rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
                  {activeFilterCount}
                </span>
              ) : null}
            </Button>
          )}
          <Button variant="ghost" size="sm" asChild>
            <Link to={fullListHref}>
              <List aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">Open as page</span>
            </Link>
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {isWide || filtersOpen ? (
          <aside
            id={filtersId}
            aria-label="Filters"
            className={cn(
              "flex shrink-0 flex-col gap-4 overflow-y-auto border-border bg-muted/30 p-4",
              isWide ? "w-72 border-r" : "max-h-[55%] border-b",
            )}
          >
            <SearchInput value={params.q} onCommit={commitSearch} placeholder="Search tasks…" />
            <FilterControls
              params={params}
              facets={facetsQuery.data}
              onFiltersChange={setFilters}
              layout="sidebar"
            />
            {isInitialFilters ? null : (
              <Button variant="outline" size="sm" onClick={resetFilters}>
                Reset filters
              </Button>
            )}
          </aside>
        ) : null}

        <section
          aria-label="Tasks"
          className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4 sm:px-6"
        >
          <ActiveFilterChips params={params} onFiltersChange={setFilters} onClear={clearFilters} />

          <p aria-live="polite" className="sr-only">
            {meta === undefined ? "" : `${formatCount(meta.total, "task")} found`}
          </p>

          {error !== null && data !== undefined ? (
            <ErrorPanel error={error} onRetry={() => void refetch()} isRetrying={isFetching} />
          ) : null}

          {isPending ? (
            showTable ? (
              <TaskTableSkeleton />
            ) : (
              <TaskCardListSkeleton />
            )
          ) : error !== null && data === undefined ? (
            <ErrorPanel error={error} onRetry={() => void refetch()} isRetrying={isFetching} />
          ) : tasks.length === 0 ? (
            meta !== undefined && meta.total > 0 && params.page > 1 ? (
              <EmptyState
                icon={Inbox}
                title="Nothing on this page"
                description="This page is past the end of the current result set."
                action={<Button onClick={() => setPage(1)}>Back to page 1</Button>}
              />
            ) : !isInitialFilters ? (
              <EmptyState
                icon={FilterX}
                title="No tasks match these filters"
                description="Try removing a filter or searching for something else."
                action={
                  <Button variant="outline" onClick={resetFilters}>
                    Reset filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={Inbox}
                title={`Nothing in ${title}`}
                description="File one here, or let an agent file it through the MCP server."
                action={
                  <Button asChild>
                    <Link
                      to={
                        createStatus === undefined
                          ? "/tasks/new"
                          : `/tasks/new?status=${createStatus}`
                      }
                    >
                      <Plus aria-hidden="true" />
                      New task
                    </Link>
                  </Button>
                }
              />
            )
          ) : (
            <div
              aria-busy={isPlaceholderData || undefined}
              className={cn("transition-opacity", isPlaceholderData && "opacity-60")}
            >
              {showTable ? (
                <TaskTable
                  tasks={tasks}
                  sort={params.sort}
                  onSortChange={setSort}
                  searchQuery={params.q}
                  onOpenTask={onOpenTask}
                />
              ) : (
                <TaskCardList tasks={tasks} searchQuery={params.q} onOpenTask={onOpenTask} />
              )}
            </div>
          )}

          {meta === undefined || (tasks.length === 0 && meta.total === 0) ? null : (
            <Pagination meta={meta} onPageChange={setPage} onPageSizeChange={setPageSize} />
          )}
        </section>
      </div>
    </>
  );
};
