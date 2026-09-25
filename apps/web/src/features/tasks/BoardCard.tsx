import { formatReference, type TicketStatus, type TicketSummary } from "@helpdesk/contracts";
import { useDraggable } from "@dnd-kit/core";
import { GripVertical, MessageSquare } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { Select, Skeleton } from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  formatAbsolute,
  formatRelative,
  statusOptions,
  toDateTimeAttribute,
} from "@/lib/formatting";
import { PRIORITY_STRIPE, PriorityBadge } from "@/features/tickets/PriorityBadge";
import { isTicketStatus } from "@/lib/statusTransition";

/**
 * One ticket on the board.
 *
 * ## Two ways to move a card, and why both are here
 *
 * Dragging is the feature; the **"Move to" select is not a fallback bolted on
 * afterwards**, it is the only path that works for a keyboard or screen-reader
 * user, and it is the reliable one on a phone. `@dnd-kit` ships a
 * `KeyboardSensor`, but without `@dnd-kit/sortable`'s coordinate getter it moves
 * a floating card by 25px per arrow press across a horizontally scrolling board
 * — an interaction that technically responds to the keyboard while being
 * unusable with one. A real `<select>` announces the four targets, commits in
 * two keystrokes, and goes through exactly the same `onMove` as a drop, so there
 * is one code path to be correct rather than two to keep in step.
 *
 * The select shows the card's *current* status rather than a "Move to…"
 * placeholder. It is a value control, not a menu: it reports where the ticket
 * is, and changing it is the move. A placeholder would leave a screen-reader
 * user with a control whose value never reflects what happened.
 *
 * ## No status badge
 *
 * The column heading is the status, and repeating it on all 25 cards spends the
 * one strong colour the design guidelines allow this screen on information the
 * card's position already carries. Priority keeps the coloured stripe and the
 * badge, exactly as on the mobile list card.
 */

export type BoardCardProps = {
  ticket: TicketSummary;
  /** Where the card is *shown* — during an in-flight move, not `ticket.status`. */
  status: TicketStatus;
  onMove: (ticketId: number, status: TicketStatus) => void;
  /** A move is in flight for this card: dimmed, and the control is locked. */
  isMoving?: boolean;
};

const cardClassName =
  "flex flex-col gap-2 rounded-lg border border-l-4 border-border bg-card p-3 text-left shadow-xs";

export const BoardCard = ({ ticket, status, onMove, isMoving = false }: BoardCardProps) => {
  /*
    The search string the board is rendered under, carried into the detail page
    so its "Back to tickets" link returns to this filtered board rather than to a
    bare `/tickets`. Same contract as the table and the mobile card list.
  */
  const { search } = useLocation();

  /*
    `attributes` is deliberately **not** spread onto the card.

    `useDraggable` returns `role="button"`, `tabIndex={0}`, and
    `aria-roledescription="draggable"` — an accessibility contract for the
    `KeyboardSensor`, which this board does not use. Applied without it they are
    a lie in two directions at once: the `<li>` stops being a list item (a
    screen reader announced this card as a button containing two links and a
    combobox, with no list to count it in), and the card becomes a focusable
    "button" that does nothing at all when activated. The keyboard path is the
    status select below, which is a real control.
  */
  const { listeners, setNodeRef, isDragging } = useDraggable({
    id: ticket.id,
    data: { status },
    disabled: isMoving,
  });

  return (
    <li
      ref={setNodeRef}
      className={cn(
        cardClassName,
        PRIORITY_STRIPE[ticket.priority],
        /*
          `manipulation`, not `none`. dnd-kit asks for `touch-action: none` on a
          draggable, but the board scrolls in both axes on a phone — a column
          scrolls down and the board scrolls sideways — and `none` on every card
          means a finger landing on a card (i.e. anywhere) scrolls nothing at
          all. The `TouchSensor`'s press-and-hold delay is what makes
          `manipulation` sufficient: a drag has already been distinguished from a
          scroll by the time it starts.
        */
        "touch-manipulation",
        isDragging && "opacity-40",
        isMoving && "opacity-60",
      )}
      /*
        The whole card is the drag handle — a 24px grip on a card this size is a
        target people miss. The grip icon is drawn anyway, because a card that is
        draggable and does not look draggable is a feature nobody finds.

        The listeners sit on the `<li>` rather than on a `<button>` wrapper so
        the links inside stay reachable: `PointerSensor`'s distance constraint
        means a click that never moves 6px is a click, not a drag.
      */
      {...listeners}
      aria-busy={isMoving || undefined}
    >
      <div className="flex items-baseline justify-between gap-2">
        <Link
          to={`/tickets/${ticket.id}`}
          state={{ from: search }}
          /*
            Browsers start their own native drag on an `<a>`, which fights the
            pointer sensor and drops a link-shaped ghost image on the board.
          */
          draggable={false}
          className="font-mono text-xs text-primary hover:underline"
        >
          {formatReference(ticket.id)}
        </Link>

        <div className="flex items-center gap-1.5">
          <time
            dateTime={toDateTimeAttribute(ticket.createdAt)}
            title={formatAbsolute(ticket.createdAt)}
            className="text-xs text-muted-foreground"
          >
            {formatRelative(ticket.createdAt)}
          </time>
          <GripVertical className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />
        </div>
      </div>

      <Link
        to={`/tickets/${ticket.id}`}
        state={{ from: search }}
        draggable={false}
        className="text-sm font-medium text-foreground hover:underline"
      >
        <span className="line-clamp-3">{ticket.title}</span>
      </Link>

      <div className="flex flex-wrap items-center gap-2">
        <PriorityBadge priority={ticket.priority} />
        {ticket.commentCount > 0 ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <MessageSquare className="size-3" aria-hidden="true" />
            {ticket.commentCount}
            <span className="sr-only">{ticket.commentCount === 1 ? "comment" : "comments"}</span>
          </span>
        ) : null}
        <span className="ml-auto max-w-[9rem] truncate text-xs text-muted-foreground">
          {ticket.assignee ?? "Unassigned"}
        </span>
      </div>

      {/*
        `onPointerDown`/`onKeyDown` are stopped here, not on the card: the drag
        listeners are on the ancestor, and without this a press on the select
        trigger begins a drag and the listbox never opens.
      */}
      <div
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <Select<TicketStatus>
          options={statusOptions}
          value={status}
          disabled={isMoving}
          onValueChange={(next) => {
            // Radix hands back a bare string, and it fires once on mount to
            // synchronise — `next !== status` is what stops that from posting a
            // PATCH nobody asked for.
            if (isTicketStatus(next) && next !== status) onMove(ticket.id, next);
          }}
          aria-label={`Move ticket ${formatReference(ticket.id)} to another status`}
          /*
            Drawn as a quiet line rather than a boxed field: 25 filled inputs
            stacked down a column read as a form, and the design guidelines allow
            this screen one strong element per card — which the priority stripe
            has already spent. The border and background appear on hover and
            focus, so the control still says "I am a control" the moment anyone
            goes near it, and `focus-visible` keeps it obvious to a keyboard user
            who cannot hover at all.
          */
          className="h-7 w-full border-transparent bg-transparent px-2 text-xs text-muted-foreground hover:border-border hover:bg-muted/50 focus:border-border"
        />
      </div>
    </li>
  );
};

/**
 * The card that follows the cursor, rendered into `<DragOverlay>`.
 *
 * A separate, inert component rather than the real card with a flag: the overlay
 * is a *portalled copy* of a card that is still in the document, so rendering
 * the real one would duplicate both its links and its select — two elements with
 * the same accessible name, one of which is a ghost.
 */
export const BoardCardOverlay = ({ ticket }: { ticket: TicketSummary }) => (
  <div
    className={cn(
      cardClassName,
      PRIORITY_STRIPE[ticket.priority],
      "w-[17rem] rotate-2 shadow-lg ring-2 ring-primary",
    )}
    aria-hidden="true"
  >
    <div className="flex items-baseline justify-between gap-2">
      <span className="font-mono text-xs text-primary">{formatReference(ticket.id)}</span>
      <GripVertical className="size-3.5 text-muted-foreground/60" />
    </div>
    <span className="line-clamp-3 text-sm font-medium text-foreground">{ticket.title}</span>
    <PriorityBadge priority={ticket.priority} />
  </div>
);

/** Card-shaped placeholder, matching the real card's height so nothing jumps. */
export const BoardCardSkeleton = () => (
  <div className={cn(cardClassName, "border-l-border")}>
    <div className="flex justify-between gap-2">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-3 w-12" />
    </div>
    <Skeleton className="h-4 w-4/5" />
    <Skeleton className="h-4 w-2/5" />
    <Skeleton className="h-8 w-full" />
  </div>
);
