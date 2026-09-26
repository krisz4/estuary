import { formatReference, type PaginatedTasks, type TaskSummary } from "@helpdesk/contracts";
import { type UseQueryResult } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { EmptyState } from "@/components/EmptyState";
import { ErrorPanel } from "@/components/ErrorPanel";
import { Pagination } from "@/components/Pagination";
import { Input, Skeleton } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatAbsolute, formatDate, toDateTimeAttribute } from "@/lib/formatting";
import { PriorityBadge } from "@/features/tasks/PriorityBadge";
import { StatusBadge } from "@/features/tasks/StatusBadge";

export type ArchiveTableProps = {
  query: UseQueryResult<PaginatedTasks>;
  q: string;
  onQChange: (q: string) => void;
  page: number;
  onPageChange: (page: number) => void;
  pageSize: number;
  onPageSizeChange: (pageSize: number) => void;
};

/**
 * Section 8: done/deferred tasks, sorted by `completedAt` desc — where the
 * Shipped shelf's "+N in the Logbook" crate leads.
 */
export const ArchiveTable = ({
  query,
  q,
  onQChange,
  onPageChange,
  onPageSizeChange,
}: ArchiveTableProps) => {
  const tasks = query.data?.data ?? [];

  return (
    <div id="archive" className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm sm:max-w-xs">
        <span className="text-xs font-medium text-muted-foreground">Search</span>
        <Input
          value={q}
          onChange={(event) => onQChange(event.target.value)}
          placeholder="Search title or description…"
          aria-label="Search the archive"
        />
      </label>

      {query.isPending ? (
        <ArchiveSkeleton />
      ) : query.error !== null && query.data === undefined ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} isRetrying={query.isFetching} />
      ) : tasks.length === 0 ? (
        <EmptyState
          title={q.trim() === "" ? "Nothing shipped yet" : "No matches"}
          description={
            q.trim() === ""
              ? "Tasks land here once they are done or deferred."
              : "Try a different search term."
          }
        />
      ) : (
        <div
          aria-busy={query.isPlaceholderData}
          className={cn(query.isPlaceholderData && "opacity-60")}
        >
          <table className="hidden w-full text-sm md:table">
            <caption className="sr-only">Archived tasks — done and deferred, most recently completed first</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-2 font-medium">
                  Reference
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  Title
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  Priority
                </th>
                <th scope="col" className="py-2 pl-2 text-right font-medium" aria-sort="descending">
                  Completed
                </th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <ArchiveRow key={task.id} task={task} />
              ))}
            </tbody>
          </table>

          <ul className="flex flex-col gap-2 md:hidden">
            {tasks.map((task) => (
              <li key={task.id} className="flex flex-col gap-1 rounded-lg border border-border bg-card p-3 shadow-raised">
                <Link to={`/tasks/${task.id}`} className="font-medium text-foreground hover:underline">
                  {task.reference} {task.title}
                </Link>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={task.status} />
                  <PriorityBadge priority={task.priority} />
                </div>
                <span className="text-xs text-muted-foreground">
                  {task.completedAt === null ? "—" : `Completed ${formatDate(task.completedAt)}`}
                </span>
              </li>
            ))}
          </ul>

          {query.data !== undefined ? (
            <Pagination meta={query.data.meta} onPageChange={onPageChange} onPageSizeChange={onPageSizeChange} />
          ) : null}
        </div>
      )}
    </div>
  );
};

const ArchiveRow = ({ task }: { task: TaskSummary }) => (
  <tr className="border-b border-border last:border-0">
    <td className="py-2 pr-2">
      <Link to={`/tasks/${task.id}`} className="font-mono text-xs text-primary hover:underline">
        {formatReference(task.id)}
      </Link>
    </td>
    <td className="px-2 py-2">
      <Link to={`/tasks/${task.id}`} className="text-foreground hover:underline">
        {task.title}
      </Link>
    </td>
    <td className="px-2 py-2">
      <StatusBadge status={task.status} />
    </td>
    <td className="px-2 py-2">
      <PriorityBadge priority={task.priority} />
    </td>
    <td className="py-2 pl-2 text-right">
      {task.completedAt === null ? (
        "—"
      ) : (
        <time dateTime={toDateTimeAttribute(task.completedAt)} title={formatAbsolute(task.completedAt)}>
          {formatDate(task.completedAt)}
        </time>
      )}
    </td>
  </tr>
);

const ArchiveSkeleton = () => (
  <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading the archive">
    {Array.from({ length: 5 }, (_, index) => (
      <Skeleton key={index} className="h-10 w-full" />
    ))}
  </div>
);
