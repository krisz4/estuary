import { type TicketStatus } from "@helpdesk/contracts";
import { useDroppable } from "@dnd-kit/core";
import { Button } from "@/components/ui";
import { ErrorPanel } from "@/components/ErrorPanel";
import { cn } from "@/lib/cn";
import { TICKET_STATUS_LABELS } from "@/lib/formatting";
import { isTicketStatus } from "@/lib/statusTransition";
import { BoardCard, BoardCardSkeleton } from "@/features/tickets/BoardCard";
import {
  BOARD_COLUMN_MAX,
  type BoardColumn as BoardColumnData,
} from "@/pages/tickets-board/useBoardTickets";

/**
 * One status column: a heading with a live count, its cards, and its own
 * loading / error / empty states.
 *
 * **The three async states are per column, not per board.** The columns are four
 * separate requests, so "Resolved failed to load" must not blank the three that
 * succeeded — a board where one column is an error panel and the rest are usable
 * is the honest rendering of what happened.
 *
 * The drop target is the whole column including its heading and its empty space,
 * not the list of cards: dropping onto an empty column is the most common move
 * on a fresh board, and a target that only exists where cards already are makes
 * the first one impossible.
 */

/** `useDroppable` ids are global to the context; the prefix keeps them off ticket ids. */
export const COLUMN_DROPPABLE_PREFIX = "column:";

export const columnDroppableId = (status: TicketStatus): string =>
  `${COLUMN_DROPPABLE_PREFIX}${status}`;

/**
 * The dropped-on column, or `undefined` when the pointer was not over one.
 *
 * Parsed through `isTicketStatus` rather than cast: the id round-trips through
 * dnd-kit as an opaque `UniqueIdentifier`, and a value that is not in the enum
 * must not reach a PATCH body typed as though it could not happen.
 */
export const statusFromDroppableId = (
  id: string | number | undefined,
): TicketStatus | undefined => {
  if (typeof id !== "string" || !id.startsWith(COLUMN_DROPPABLE_PREFIX)) return undefined;
  const value = id.slice(COLUMN_DROPPABLE_PREFIX.length);
  return isTicketStatus(value) ? value : undefined;
};

export type BoardColumnProps = {
  column: BoardColumnData;
  onMove: (ticketId: number, status: TicketStatus) => void;
  pendingMoves: ReadonlyMap<number, TicketStatus>;
};

export const BoardColumn = ({ column, onMove, pendingMoves }: BoardColumnProps) => {
  const { status, tickets, total } = column;
  const label = TICKET_STATUS_LABELS[status];

  const { setNodeRef, isOver } = useDroppable({ id: columnDroppableId(status) });

  return (
    <section
      ref={setNodeRef}
      aria-label={`${label} — ${total} ${total === 1 ? "ticket" : "tickets"}`}
      className={cn(
        "flex w-[85vw] shrink-0 snap-start flex-col rounded-lg border border-border bg-muted/30",
        // The board scrolls sideways below `lg`; above it, four equal columns.
        "sm:w-[19rem] lg:w-auto lg:flex-1 lg:snap-align-none",
        "transition-colors",
        isOver && "border-primary bg-primary-subtle/40",
      )}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold text-foreground">{label}</h2>
        {/*
          The count is `aria-hidden` and repeated in the section's own label:
          a screen reader reading the region announces "Open — 12 tickets" once,
          rather than the heading and then a bare number with no noun.
        */}
        <span
          aria-hidden="true"
          className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground tabular-nums"
        >
          {column.isPending ? "—" : total}
        </span>
      </header>

      <div
        className={cn(
          "flex flex-col gap-2 p-2",
          // Tall columns scroll inside themselves so the four headings stay put
          // — a board whose headings scroll away stops being a board.
          "max-h-[calc(100vh-19rem)] min-h-32 overflow-y-auto lg:max-h-[calc(100vh-17rem)]",
          column.isRefreshing && "opacity-60",
        )}
        aria-busy={column.isRefreshing || undefined}
      >
        {column.isPending ? (
          <>
            <BoardCardSkeleton />
            <BoardCardSkeleton />
            <BoardCardSkeleton />
          </>
        ) : column.error !== null && column.error !== undefined ? (
          <ErrorPanel error={column.error} onRetry={column.refetch} className="px-3 py-3" />
        ) : tickets.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            Nothing {label.toLowerCase()}. Drop a ticket here to move it.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {tickets.map((ticket) => (
              <BoardCard
                key={ticket.id}
                ticket={ticket}
                status={status}
                onMove={onMove}
                isMoving={pendingMoves.has(ticket.id)}
              />
            ))}
          </ul>
        )}

        {column.hasMore ? (
          column.canLoadMore ? (
            <Button variant="outline" size="sm" onClick={column.loadMore} className="w-full">
              Load more
            </Button>
          ) : (
            /*
              `BOARD_COLUMN_MAX` is `MAX_PAGE_SIZE`, which the API *rejects*
              rather than clamps. So the column stops asking and says what the
              user can do instead — a "Load more" that would 422 is worse than
              none, and silently showing 100 of 300 with no note is worse still.
            */
            <p className="px-1 py-2 text-center text-xs text-muted-foreground">
              Showing the first {BOARD_COLUMN_MAX} of {total}. Narrow the filters to see the rest.
            </p>
          )
        ) : null}
      </div>
    </section>
  );
};
