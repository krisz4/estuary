import { formatReference, type TicketSummary } from "@helpdesk/contracts";
import { Link, useLocation } from "react-router-dom";
import { Skeleton } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatAbsolute, formatRelative, toDateTimeAttribute } from "@/lib/formatting";
import { PRIORITY_STRIPE, PriorityBadge } from "@/features/tickets/PriorityBadge";
import { StatusBadge } from "@/features/tickets/StatusBadge";

/**
 * The mobile (below `md`) ticket list.
 *
 * The table is **replaced**, not shrunk and scrolled sideways — a horizontally
 * scrolled table on a phone is the failure this component exists to prevent, and
 * the brief calls out mobile explicitly.
 *
 * Here the whole card is one `<a>`, which is the tradeoff the table cannot make:
 * a card has no columns to select text from, so wrapping it entirely keeps a
 * thumb-sized target *and* middle-click, long-press, and "open in new tab".
 *
 * Priority is a coloured left stripe **plus** the badge. The stripe is what makes
 * a stacked list scannable; the badge is what makes it readable without colour.
 */

export type TicketCardListProps = {
  tickets: TicketSummary[];
};

export const TicketCardList = ({ tickets }: TicketCardListProps) => {
  /*
    The search string the list is rendered under, carried into the detail page's
    history state so its "Back to tickets" link returns to *this* filtered,
    sorted, paged view rather than to a bare `/tickets`. It is state rather than
    a query param on the detail URL because the detail URL is meant to be
    shareable, and a pasted link should not resurrect a stranger's filters.
  */
  const { search } = useLocation();

  return (
    <ul className="flex flex-col gap-2">
      {tickets.map((ticket) => (
        <li key={ticket.id}>
          <Link
            to={`/tickets/${ticket.id}`}
            state={{ from: search }}
            className={cn(
              "flex flex-col gap-2 rounded-lg border border-l-4 border-border bg-card p-3",
              "transition-colors hover:bg-muted/40",
              PRIORITY_STRIPE[ticket.priority],
            )}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-xs text-primary">{formatReference(ticket.id)}</span>
              <time
                dateTime={toDateTimeAttribute(ticket.createdAt)}
                title={formatAbsolute(ticket.createdAt)}
                className="text-xs text-muted-foreground"
              >
                {formatRelative(ticket.createdAt)}
              </time>
            </div>

            <p className="line-clamp-2 text-sm font-medium text-foreground">{ticket.title}</p>

            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={ticket.status} />
              <PriorityBadge priority={ticket.priority} />
              <span className="ml-auto truncate text-xs text-muted-foreground">
                {ticket.assignee ?? "Unassigned"}
              </span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
};

/** Card-shaped placeholder, matching the real card's height so nothing jumps. */
export const TicketCardListSkeleton = ({ rows = 6 }: { rows?: number }) => (
  <div className="flex flex-col gap-2">
    {Array.from({ length: rows }, (_, index) => (
      <div
        key={index}
        className="flex flex-col gap-2 rounded-lg border border-l-4 border-border bg-card p-3"
      >
        <div className="flex justify-between gap-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-16" />
        </div>
        <Skeleton className="h-4 w-3/4" />
        <div className="flex gap-2">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      </div>
    ))}
  </div>
);
