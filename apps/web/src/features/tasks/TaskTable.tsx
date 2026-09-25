import {
  formatReference,
  type TicketSort,
  type TicketSortField,
  type TicketSummary,
} from "@helpdesk/contracts";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { Skeleton } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatAbsolute, formatRelative, toDateTimeAttribute } from "@/lib/formatting";
import { PriorityBadge } from "@/features/tickets/PriorityBadge";
import { StatusBadge } from "@/features/tickets/StatusBadge";

/**
 * The desktop (`md` and up) ticket table.
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

const SORTABLE: Partial<Record<string, TicketSortField>> = {
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
  { key: "status", label: "Status", className: "w-[7rem]" },
  { key: "priority", label: "Priority", className: "w-[7rem]" },
  { key: "requester", label: "Requester", className: "w-[7.5rem]" },
  { key: "assignee", label: "Assignee", className: "hidden w-[9rem] lg:table-cell" },
  { key: "created", label: "Created", className: "w-[7rem]" },
];

const DIRECTION_LABEL = { asc: "ascending", desc: "descending" } as const;

export type TicketTableProps = {
  tickets: TicketSummary[];
  sort: TicketSort;
  onSortChange: (sort: TicketSort) => void;
};

export const TicketTable = ({ tickets, sort, onSortChange }: TicketTableProps) => {
  /*
    The search string this list is rendered under, carried into the detail page's
    history state so its "Back to tickets" link returns to *this* filtered,
    sorted, paged view rather than to a bare `/tickets`. State rather than a
    query param on the detail URL: that URL is meant to be shareable, and a
    pasted link should not resurrect a stranger's filters.
  */
  const { search } = useLocation();

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full table-fixed border-collapse text-sm">
        <caption className="sr-only">
          Tickets, sorted by {sort.field} {DIRECTION_LABEL[sort.direction]}
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
          {tickets.map((ticket) => (
            <tr key={ticket.id} className="border-t border-border align-top hover:bg-muted/40">
              <td className="px-3 py-3">
                <Link
                  to={`/tickets/${ticket.id}`}
                  state={{ from: search }}
                  className="font-mono text-xs text-primary hover:underline"
                >
                  {formatReference(ticket.id)}
                </Link>
              </td>

              <td className="px-3 py-3">
                <Link
                  to={`/tickets/${ticket.id}`}
                  state={{ from: search }}
                  className="text-foreground hover:underline"
                >
                  <span className="line-clamp-2">{ticket.title}</span>
                </Link>
                {ticket.commentCount > 0 ? (
                  <span className="mt-0.5 block text-xs whitespace-nowrap text-muted-foreground">
                    {ticket.commentCount} {ticket.commentCount === 1 ? "comment" : "comments"}
                  </span>
                ) : null}
              </td>

              <td className="px-3 py-3">
                <StatusBadge status={ticket.status} />
              </td>

              <td className="px-3 py-3">
                <PriorityBadge priority={ticket.priority} />
              </td>

              <td className="px-3 py-3">
                <span className="block truncate text-foreground" title={ticket.requesterEmail}>
                  {ticket.requesterName}
                </span>
              </td>

              <td className="hidden px-3 py-3 lg:table-cell">
                {ticket.assignee === null ? (
                  <span className="text-muted-foreground">Unassigned</span>
                ) : (
                  <span className="block truncate">{ticket.assignee}</span>
                )}
              </td>

              <td className="px-3 py-3 whitespace-nowrap text-muted-foreground">
                <time
                  dateTime={toDateTimeAttribute(ticket.createdAt)}
                  title={formatAbsolute(ticket.createdAt)}
                >
                  {formatRelative(ticket.createdAt)}
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
  field: TicketSortField;
  sort: TicketSort;
  onSortChange: (sort: TicketSort) => void;
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
export const TicketTableSkeleton = ({ rows = 8 }: { rows?: number }) => (
  <div className="overflow-hidden rounded-lg border border-border">
    <table className="w-full table-fixed border-collapse text-sm">
      <caption className="sr-only">Loading tickets</caption>
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
