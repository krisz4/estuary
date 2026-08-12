import { useCallback, useState } from "react";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  TICKET_STATUSES,
  formatReference,
  type TicketStatus,
  type TicketSummary,
} from "@helpdesk/contracts";
import { toast } from "sonner";
import { useMoveTicketStatusMutation, useTicketFacetsQuery } from "@/api/tickets";
import { BoardCardOverlay } from "@/features/tickets/BoardCard";
import { BoardColumn, statusFromDroppableId } from "@/features/tickets/BoardColumn";
import { SortSelect } from "@/features/tickets/SortSelect";
import { TicketFilterBar } from "@/features/tickets/TicketFilterBar";
import { ViewSwitch } from "@/features/tickets/ViewSwitch";
import { TICKET_STATUS_LABELS } from "@/lib/formatting";
import { errorCopy } from "@/lib/errorMessages";
import { statusChangeErrorMessage } from "@/lib/statusTransition";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { MD_BREAKPOINT_QUERY, useMediaQuery } from "@/lib/useMediaQuery";
import { useTicketListParams } from "@/pages/tickets-list/useTicketListParams";
import { useBoardTickets } from "@/pages/tickets-board/useBoardTickets";

/**
 * `/tickets/board` — the same tickets as `/tickets`, arranged by status, with
 * drag-and-drop between columns. Spec: `docs/pages/Tickets_Board.md`.
 *
 * ## It shares the list's URL state, and that is the whole design
 *
 * Search, priority, category, assignee, dates, and sort come from the same
 * `useTicketListParams` the list page uses, so a filtered view survives the
 * switch between views in both directions and a shared board link carries the
 * filters the sender was looking at.
 *
 * Two keys behave differently here, and both differences are deliberate:
 *
 * - **`status` selects which columns are shown**, rather than filtering rows
 *   inside them. On a board the columns *are* the status filter, so a status
 *   chip that also removed rows would apply the same constraint twice and leave
 *   the user with columns that are empty for a reason nothing on screen
 *   explains. `?status=open&status=in_progress` is "show me the active half of
 *   the board", which is the thing people actually want from that control here.
 * - **`page` is ignored.** A board pages per column, on its own "Load more"
 *   (`useBoardTickets`), because four queues fill at four different rates. The
 *   key is left in the URL untouched so switching back to the list returns to
 *   the page you were on.
 *
 * ## The client does not know the transition table
 *
 * Every column accepts every card, including `closed → resolved`, which the
 * server rejects with `INVALID_STATUS_TRANSITION`. That is the rule in
 * `lib/statusTransition.ts`: the guard is deliberately permissive and has been
 * loosened before, so a client-side copy of it would forbid something the server
 * allows with nothing failing anywhere to say so. A rejected drop rolls the card
 * back and the toast quotes the server's own `details.allowed`.
 */
export const TicketsBoardPage = () => {
  useDocumentTitle("Board");

  const { params, setSort, setFilters, clearFilters, activeFilterCount } = useTicketListParams();

  const isWide = useMediaQuery(MD_BREAKPOINT_QUERY);

  const facetsQuery = useTicketFacetsQuery();
  const board = useBoardTickets(params);
  const moveMutation = useMoveTicketStatusMutation();

  /** The card under the cursor, for the overlay. `null` when nothing is dragging. */
  const [activeTicket, setActiveTicket] = useState<TicketSummary | null>(null);

  /**
   * One path for both ways of moving a card — a drop and the card's status
   * select land here.
   *
   * The optimistic entry is written before the request and removed when it
   * settles, not on success: a rejected move has to give the card back, and a
   * successful one has to hold the card in its new column until the refetch that
   * `onSettled` awaits has actually landed.
   */
  const move = useCallback(
    (ticketId: number, status: TicketStatus) => {
      board.beginMove(ticketId, status);

      moveMutation
        .mutateAsync({ ticketId, status })
        .then(() => {
          toast.success(`${formatReference(ticketId)} moved to ${TICKET_STATUS_LABELS[status]}`);
        })
        .catch((error: unknown) => {
          toast.error(errorCopy(error).title, {
            // For a 409 this is the server's `details.allowed` rendered as
            // "You can move it to Open or In progress instead."
            description: statusChangeErrorMessage(error),
          });
        })
        .finally(() => board.endMove(ticketId));
    },
    [board, moveMutation],
  );

  /*
    `MouseSensor` + `TouchSensor` rather than the single `PointerSensor`, because
    the two inputs need different activation rules on this screen:

    - Mouse: a 6px distance threshold, so a click on a card's link is a click and
      not a one-pixel drag that swallows the navigation.
    - Touch: a 250ms press-and-hold. A distance threshold on touch cannot tell a
      drag from a scroll, and this board scrolls in both axes on a phone — every
      attempt to scroll a column would pick a card up instead.

    No `KeyboardSensor`: see the note in `BoardCard.tsx` on why the status select
    is the keyboard path rather than a floating card moved 25px per arrow press.
  */
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    const ticket = board.byId.get(Number(event.active.id));
    setActiveTicket(ticket ?? null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveTicket(null);

    const target = statusFromDroppableId(event.over?.id);
    if (target === undefined) return;

    const ticket = board.byId.get(Number(event.active.id));
    if (ticket === undefined) return;

    // Dropping a card back on the column it started in is a no-op, not a PATCH
    // — the API treats `X → X` as a write-free success, but the round trip would
    // still flash the card's busy state for nothing.
    if (board.effectiveStatus(ticket) === target) return;

    move(ticket.id, target);
  };

  /**
   * Screen-reader narration for the drag itself.
   *
   * dnd-kit's defaults announce ids ("Draggable item 42 was dropped over
   * droppable area column:resolved"), which is the internal vocabulary of the
   * library rather than of the app. These name the ticket and the column.
   */
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ticket ${formatReference(Number(active.id))}.`,
    onDragOver: ({ over }) => {
      const status = statusFromDroppableId(over?.id);
      return status === undefined ? "Not over a column." : `Over ${TICKET_STATUS_LABELS[status]}.`;
    },
    onDragEnd: ({ active, over }) => {
      const status = statusFromDroppableId(over?.id);
      return status === undefined
        ? `Ticket ${formatReference(Number(active.id))} was dropped outside a column and did not move.`
        : `Ticket ${formatReference(Number(active.id))} was moved to ${TICKET_STATUS_LABELS[status]}.`;
    },
    onDragCancel: ({ active }) =>
      `Moving ticket ${formatReference(Number(active.id))} was cancelled.`,
  };

  /*
    Which columns are on screen. Enum order, never the order the user happened to
    click the chips in — a board whose columns reorder themselves as you filter
    is unreadable.
  */
  const visibleStatuses =
    params.status.length === 0
      ? TICKET_STATUSES
      : TICKET_STATUSES.filter((status) => params.status.includes(status));

  const visibleColumns = board.columns.filter((column) => visibleStatuses.includes(column.status));

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Board</h1>
          <p className="text-sm text-muted-foreground">
            Drag a ticket between columns to change its status.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/*
            The list gets its sort from the table's column headers, which a board
            does not have. Below `md` the filter bar already renders this control,
            so rendering it here as well would put two of them on a 360px screen.
          */}
          {isWide ? (
            <SortSelect sort={params.sort} onSortChange={setSort} className="w-52" />
          ) : null}
          <ViewSwitch />
        </div>
      </header>

      <TicketFilterBar
        params={params}
        facets={facetsQuery.data}
        onFiltersChange={setFilters}
        onSortChange={setSort}
        onClear={clearFilters}
        activeFilterCount={activeFilterCount}
        isWide={isWide}
      />

      {/*
        The column counts are visible, but only as four numbers in four corners.
        A screen-reader user gets one sentence for the whole board instead of
        having to walk it to find out that a filter emptied it.
      */}
      <p aria-live="polite" className="sr-only">
        {board.isPending
          ? ""
          : visibleColumns
              .map(
                (column) =>
                  `${TICKET_STATUS_LABELS[column.status]}: ${column.total} ${
                    column.total === 1 ? "ticket" : "tickets"
                  }`,
              )
              .join(", ")}
      </p>

      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        accessibility={{ announcements }}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveTicket(null)}
      >
        {/*
          Four columns do not fit at 360px and must not be squeezed into it: the
          board scrolls sideways with scroll-snap below `lg`, one column at a
          time, and becomes four equal columns above it. This is the one place in
          the app where horizontal scrolling is the right answer rather than the
          failure — a kanban column is a queue, and a queue that reflows into a
          stack is just the list page again.
        */}
        {/*
          Two classes here are load-bearing rather than defensive, and both were
          measured against the 375px spec in `e2e/board.spec.ts` rather than
          reasoned about:

          - **`min-w-0`.** This div is a flex *item* of the page's column, and a
            flex item's default `min-width: auto` refuses to shrink below its
            content — so `overflow-x-auto` had nothing to clip and the four
            columns pushed the whole document 740px wide.
          - **`relative`.** Even once the box clipped, the document still
            scrolled sideways: the cards contain `sr-only` spans, which are
            `position: absolute`, and an absolutely positioned element is only
            clipped by an ancestor that is in its *containing block* chain.
            With no positioned ancestor between them and the page, those 1px
            spans resolved against the initial containing block and stretched the
            document to the full width of all four columns — invisible, and a
            sideways scroll on every phone. Making the scroller the containing
            block puts them back inside the box that clips them.
        */}
        <div className="relative -mx-1 flex min-w-0 snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2 lg:snap-none lg:overflow-x-visible">
          {visibleColumns.map((column) => (
            <BoardColumn
              key={column.status}
              column={column}
              onMove={move}
              pendingMoves={board.pendingMoves}
            />
          ))}
        </div>

        {/*
          The dragged card is drawn once, in a portal above everything, instead of
          the original being transformed in place. Inside a column that scrolls,
          a transformed card is clipped by its own `overflow-y: auto` the moment
          it leaves — you would watch the card you are dragging get cut in half.
        */}
        <DragOverlay dropAnimation={null}>
          {activeTicket === null ? null : <BoardCardOverlay ticket={activeTicket} />}
        </DragOverlay>
      </DndContext>
    </div>
  );
};
