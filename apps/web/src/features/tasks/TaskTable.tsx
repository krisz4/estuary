import {
  formatReference,
  type TaskSort,
  type TaskSortField,
  type TaskSummary,
} from "@helpdesk/contracts";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { Skeleton } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatAbsolute, formatRelative, toDateTimeAttribute } from "@/lib/formatting";
import { ActorBadge } from "@/features/tasks/ActorBadge";
import { ClaimIndicator } from "@/features/tasks/ClaimIndicator";
import { HighlightText } from "@/features/tasks/HighlightText";
import { LabelChips } from "@/features/tasks/LabelChips";
import { PriorityBadge } from "@/features/tasks/PriorityBadge";
import { StatusBadge } from "@/features/tasks/StatusBadge";

/**
 * The desktop (`md` and up) task table.
 *
 * A real `<table>` with `<caption class="sr-only">`, `<th scope="col">`, and
 * `aria-sort` on the active header — not a grid of divs. Screen readers announce
 * a table's row and column position; a div grid announces nothing.
 *
 * **There is no `onClick` on the `<tr>`.** Navigation is two real `<a>`
 * elements, in the reference cell and the title cell. A row click handler breaks
 * middle-click, ⌘-click, "open in new tab", and copy-link — and a stretched
 * pseudo-element that restores the hit area breaks text selection instead. Two
 * links is the version where every browser affordance keeps working; the cost is
 * a smaller target, which is why the mobile card is one big link instead.
 */

const SORTABLE: Partial<Record<string, TaskSortField>> = {
  reference: "id",
  title: "title",
  status: "status",
  priority: "priority",
  created: "createdAt",
};

type Column = {
  /** Matches a key in `SORTABLE` when the column can be sorted. */
  key: string;
  label: string;
  /** Extra classes, including the `lg`-only visibility for assignee. */
  className?: string;
};

/**
 * Widths are deliberate and tight, because the layout is `table-fixed`: every
 * fixed column is taken out of the total before Title gets what is left. At the
 * `md` boundary — 768px, so ~720px of content — generous widths left Title with
 * ~24px and the header label overlapping its neighbour. Measured at the
 * breakpoint rather than at 1280 for exactly that reason.
 *
 * `table-fixed` stays because the alternative re-measures every column on every
 * page change, and a table whose columns jump as you page reads as broken.
 */
const COLUMNS: Column[] = [
  { key: "reference", label: "Reference", className: "w-[6.5rem]" },
  { key: "title", label: "Title" },
  // "Needs decision" is the widest label at `text-xs`, and it must not wrap.
  { key: "status", label: "Status", className: "w-[8.5rem]" },
  { key: "priority", label: "Priority", className: "w-[6.5rem]" },
  { key: "project", label: "Project", className: "hidden w-[7.5rem] lg:table-cell" },
  { key: "createdBy", label: "Created by", className: "w-[8rem]" },
  { key: "created", label: "Created", className: "w-[6.5rem]" },
];

const DIRECTION_LABEL = { asc: "ascending", desc: "descending" } as const;

export type TaskTableProps = {
  tasks: TaskSummary[];
  sort: TaskSort;
  onSortChange: (sort: TaskSort) => void;
  /** The active search, for highlighting matched terms in the title column. */
  searchQuery?: string | undefined;
};

export const TaskTable = ({ tasks, sort, onSortChange, searchQuery }: TaskTableProps) => {
  /*
    The search string this list is rendered under, carried into the detail page's
    history state so its "Back to tasks" link returns to *this* filtered,
    sorted, paged view rather than to a bare `/tasks`. State rather than a
    query param on the detail URL: that URL is meant to be shareable, and a
    pasted link should not resurrect a stranger's filters.
  */
  const { search } = useLocation();

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-raised">
      <table className="w-full table-fixed border-collapse text-sm">
        <caption className="sr-only">
          Tasks, sorted by {sort.field} {DIRECTION_LABEL[sort.direction]}
        </caption>

        <thead className="bg-muted/60">
          <tr>
            {COLUMNS.map((column) => {
              const field = SORTABLE[column.key];
              const isActive = field !== undefined && field === sort.field;

              return (
                <th
                  key={column.key}
                  scope="col"
                  className={cn(
                    "px-3 py-2 text-left text-xs font-medium text-muted-foreground",
                    column.className,
                  )}
                  aria-sort={isActive ? DIRECTION_LABEL[sort.direction] : undefined}
                >
                  {field === undefined ? (
                    column.label
                  ) : (
                    <SortButton
                      label={column.label}
                      field={field}
                      sort={sort}
                      onSortChange={onSortChange}
                    />
                  )}
                </th>
              );
            })}
          </tr>
        </thead>

        <tbody>
          {tasks.map((task) => (
            <tr key={task.id} className="border-t border-border align-top hover:bg-muted/40">
              <td className="px-3 py-3">
                <Link
                  to={`/tasks/${task.id}`}
                  state={{ from: search }}
                  className="font-mono text-xs text-primary hover:underline"
                >
                  {formatReference(task.id)}
                </Link>
              </td>

              <td className="px-3 py-3">
                <Link
                  to={`/tasks/${task.id}`}
                  state={{ from: search }}
                  className="text-foreground hover:underline"
                >
                  <span className="line-clamp-2">
                    <HighlightText text={task.title} query={searchQuery} />
                  </span>
                </Link>
                <LabelChips
                  labels={task.labels}
                  linkTo={(label) => `/tasks?label=${encodeURIComponent(label)}`}
                  className="mt-1"
                />
                <TaskRowMeta task={task} linkSubtasks />
              </td>

              <td className="px-3 py-3">
                <StatusBadge status={task.status} />
              </td>

              <td className="px-3 py-3">
                <PriorityBadge priority={task.priority} />
              </td>

              <td className="hidden px-3 py-3 lg:table-cell">
                {task.project === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <span className="block truncate" title={task.project}>
                    {task.project}
                  </span>
                )}
              </td>

              <td className="px-3 py-3">
                <ActorBadge actor={task.createdBy} plain className="text-foreground" />
              </td>

              <td className="px-3 py-3 whitespace-nowrap text-muted-foreground">
                <time
                  dateTime={toDateTimeAttribute(task.createdAt)}
                  title={formatAbsolute(task.createdAt)}
                >
                  {formatRelative(task.createdAt)}
                </time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/**
 * The line under a title: who is on it, what it waits on, what it asks.
 *
 * Only what is *true* is drawn — a task with no claim, no open dependencies,
 * no question and no comments gets no line at all. These are the facts an
 * agent-driven task list changes most, and the ones a human scanning the list
 * is looking for.
 */
export const TaskRowMeta = ({
  task,
  linkSubtasks = false,
}: {
  task: TaskSummary;
  /**
   * `true` only where this is **not** nested inside another `<a>` — the table
   * row (the reference and title cells are their own links, this text sits in
   * a plain `<td>`). The mobile card wraps its whole body in one link, so
   * there the count renders as plain text; a nested `<a>` is invalid HTML.
   */
  linkSubtasks?: boolean;
}) => {
  const subtaskLabel = `${task.childCount} ${task.childCount === 1 ? "subtask" : "subtasks"}`;

  const parts = [
    task.claim === null ? null : <ClaimIndicator key="claim" claim={task.claim} />,
    task.childCount === 0 ? null : linkSubtasks ? (
      <Link
        key="subtasks"
        to={`/tasks?parentId=${task.id}`}
        onClick={(event) => event.stopPropagation()}
        className="hover:text-foreground hover:underline"
      >
        {subtaskLabel}
      </Link>
    ) : (
      <span key="subtasks">{subtaskLabel}</span>
    ),
    task.openDependencyCount === 0 ? null : (
      <span key="deps">
        Waits on {task.openDependencyCount} {task.openDependencyCount === 1 ? "task" : "tasks"}
      </span>
    ),
    task.openDecision === null ? null : (
      <span key="decision" className="text-primary-subtle-foreground">
        Question open
      </span>
    ),
    task.commentCount === 0 ? null : (
      <span key="comments">
        {task.commentCount} {task.commentCount === 1 ? "comment" : "comments"}
      </span>
    ),
  ].filter((part) => part !== null);

  if (parts.length === 0) return null;

  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
      {parts}
    </span>
  );
};

/**
 * A sortable header.
 *
 * A `<button>` inside the `<th>`, not a click handler on the `<th>` itself —
 * only the button is focusable and operable from the keyboard, and its
 * `aria-label` spells out what the click will *do* ("Sort by priority,
 * descending") rather than what the column currently is.
 */
const SortButton = ({
  label,
  field,
  sort,
  onSortChange,
}: {
  label: string;
  field: TaskSortField;
  sort: TaskSort;
  onSortChange: (sort: TaskSort) => void;
}) => {
  const isActive = sort.field === field;
  // Clicking the active column flips it; clicking a new one starts descending —
  // "newest / highest first" is what someone scanning a queue wants.
  const nextDirection = isActive && sort.direction === "desc" ? "asc" : "desc";
  const Icon = !isActive ? ChevronsUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown;

  return (
    <button
      type="button"
      onClick={() => onSortChange({ field, direction: nextDirection })}
      aria-label={`Sort by ${label.toLowerCase()}, ${DIRECTION_LABEL[nextDirection]}`}
      className={cn(
        "-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5",
        "transition-colors hover:text-foreground",
        isActive && "text-foreground",
      )}
    >
      {label}
      <Icon className={cn("size-3", isActive ? "opacity-100" : "opacity-40")} aria-hidden="true" />
    </button>
  );
};

/**
 * First-load placeholder.
 *
 * Renders the real table chrome with skeleton cells rather than a spinner, so
 * the header row, column widths, and row height are already correct when the
 * data lands and nothing jumps.
 */
export const TaskTableSkeleton = ({ rows = 8 }: { rows?: number }) => (
  <div className="overflow-hidden rounded-lg border border-border bg-card shadow-raised">
    <table className="w-full table-fixed border-collapse text-sm">
      <caption className="sr-only">Loading tasks</caption>
      <thead className="bg-muted/60">
        <tr>
          {COLUMNS.map((column) => (
            <th
              key={column.key}
              scope="col"
              className={cn(
                "px-3 py-2 text-left text-xs font-medium text-muted-foreground",
                column.className,
              )}
            >
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }, (_, index) => (
          <tr key={index} className="border-t border-border">
            {COLUMNS.map((column) => (
              <td key={column.key} className={cn("px-3 py-3", column.className)}>
                <Skeleton className="h-4 w-full" />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
