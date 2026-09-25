import { type TaskStatus } from "@helpdesk/contracts";
import { useDroppable } from "@dnd-kit/core";
import { Button } from "@/components/ui";
import { ErrorPanel } from "@/components/ErrorPanel";
import { cn } from "@/lib/cn";
import { TASK_STATUS_DESCRIPTIONS, TASK_STATUS_LABELS } from "@/lib/formatting";
import { isTaskStatus } from "@/lib/statusTransition";
import { BoardCard, BoardCardSkeleton } from "@/features/tasks/BoardCard";
import {
  BOARD_COLUMN_MAX,
  type BoardColumn as BoardColumnData,
} from "@/pages/tasks-board/useBoardTasks";

/**
 * One status column: a heading with a live count, its cards, and its own
 * loading / error / empty states.
 *
 * **The three async states are per column, not per board.** The columns are
 * separate requests, so "Needs QA failed to load" must not blank the nine that
 * succeeded — a board where one column is an error panel and the rest are
 * usable is the honest rendering of what happened.
 *
 * The drop target is the whole column including its heading and its empty space,
 * not the list of cards: dropping onto an empty column is the most common move
 * on a fresh board, and a target that only exists where cards already are makes
 * the first one impossible.
 */

/** `useDroppable` ids are global to the context; the prefix keeps them off task ids. */
export const COLUMN_DROPPABLE_PREFIX = "column:";

export const columnDroppableId = (status: TaskStatus): string =>
  `${COLUMN_DROPPABLE_PREFIX}${status}`;

/**
 * The dropped-on column, or `undefined` when the pointer was not over one.
 *
 * Parsed through `isTaskStatus` rather than cast: the id round-trips through
 * dnd-kit as an opaque `UniqueIdentifier`, and a value that is not in the enum
 * must not reach a PATCH body typed as though it could not happen.
 */
export const statusFromDroppableId = (id: string | number | undefined): TaskStatus | undefined => {
  if (typeof id !== "string" || !id.startsWith(COLUMN_DROPPABLE_PREFIX)) return undefined;
  const value = id.slice(COLUMN_DROPPABLE_PREFIX.length);
  return isTaskStatus(value) ? value : undefined;
};

export type BoardColumnProps = {
  column: BoardColumnData;
  onMove: (taskId: number, status: TaskStatus) => void;
  pendingMoves: ReadonlyMap<number, TaskStatus>;
};

export const BoardColumn = ({ column, onMove, pendingMoves }: BoardColumnProps) => {
  const { status, tasks, total } = column;
  const label = TASK_STATUS_LABELS[status];

  const { setNodeRef, isOver } = useDroppable({ id: columnDroppableId(status) });

  return (
    <section
      ref={setNodeRef}
      aria-label={`${label} — ${total} ${total === 1 ? "task" : "tasks"}`}
      className={cn(
        "flex w-[85vw] shrink-0 snap-start flex-col rounded-lg border border-border bg-muted/30",
        // A lane scrolls sideways below `lg`; above it, its columns share the width.
        "sm:w-[19rem] lg:w-auto lg:min-w-0 lg:flex-1 lg:snap-align-none",
        "transition-colors",
        isOver && "border-primary bg-primary-subtle/40",
      )}
    >
      {/*
        From `lg`, sticky under the app header (`h-14`): the column scrolls with
        the page now, and a kanban whose headings scroll away stops being a
        kanban. Opaque `bg-muted` and `rounded-t-lg` because it slides over the
        cards — a translucent heading would have card text reading through it.

        **Only from `lg`, and that is a CSS constraint rather than a choice.**
        Below it the board is a horizontal scroll container, and a sticky
        element sticks to its nearest scrollport, not the window — so on a phone
        `top-14` pinned the heading to a box that scrolls with the page and it
        drifted up over the first card instead of staying put. A heading that
        sticks to nothing is worse than one that scrolls honestly with its
        column, so below `lg` it is a plain heading.
      */}
      <header className="flex items-center justify-between gap-2 rounded-t-lg border-b border-border bg-muted px-3 py-2 lg:sticky lg:top-14 lg:z-10">
        {/* `h3`: the lane heading above it is the `h2`. The description is the
            `title` only — it is repeated in the empty state, where it matters. */}
        <h3
          className="text-sm font-semibold text-foreground"
          title={TASK_STATUS_DESCRIPTIONS[status]}
        >
          {label}
        </h3>
        {/*
          The count is `aria-hidden` and repeated in the section's own label:
          a screen reader reading the region announces "To do — 12 tasks" once,
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
          /*
            The column is as tall as its cards and the *page* scrolls it — no
            inner scrollbar and no viewport cap.

            It used to be capped at `calc(100vh - 19rem)`, and that is what put
            a screenful of dead space under the board: the cap made the board
            window-height whatever it held, while the document kept the height
            of whichever view was rendered before it. Growing with the content
            means the document height is the board's height, so there is nothing
            underneath it to explain.

            `min-h-32` is the floor that keeps an empty column a droppable
            target rather than a 1px line.
          */
          "min-h-32",
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
        ) : tasks.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            {TASK_STATUS_DESCRIPTIONS[status]} Nothing here — drop a task to move it.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {tasks.map((task) => (
              <BoardCard
                key={task.id}
                task={task}
                status={status}
                onMove={onMove}
                isMoving={pendingMoves.has(task.id)}
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
