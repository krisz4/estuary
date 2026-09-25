import { useState } from "react";
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
  TASK_STATUS_LANES,
  TASK_STATUSES,
  formatReference,
  type TaskStatus,
  type TaskStatusLane,
  type TaskSummary,
  type TransitionInput,
} from "@helpdesk/contracts";
import { toast } from "sonner";
import { isApiClientError } from "@/api/http";
import { useTaskFacetsQuery, useTaskStatsQuery, useTransitionTaskMutation } from "@/api/tasks";
import { BoardCardOverlay } from "@/features/tasks/BoardCard";
import { BoardColumn, statusFromDroppableId } from "@/features/tasks/BoardColumn";
import { BoardLane } from "@/features/tasks/BoardLane";
import { SortSelect } from "@/features/tasks/SortSelect";
import { TaskFilterBar } from "@/features/tasks/TaskFilterBar";
import { TransitionDialog } from "@/features/tasks/TransitionDialog";
import { ViewSwitch } from "@/features/tasks/ViewSwitch";
import { TASK_STATUS_LABELS } from "@/lib/formatting";
import { errorCopy } from "@/lib/errorMessages";
import { statusChangeErrorMessage, transitionNeedsInput } from "@/lib/statusTransition";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { MD_BREAKPOINT_QUERY, useMediaQuery } from "@/lib/useMediaQuery";
import { useRememberTaskView } from "@/stores/taskView";
import { useTaskListParams } from "@/pages/tasks-list/useTaskListParams";
import { useBoardTasks } from "@/pages/tasks-board/useBoardTasks";

/**
 * `/tasks/board` — the same tasks as `/tasks`, arranged by status in four
 * lanes, with drag-and-drop between columns. Spec: `docs/pages/Tasks_Board.md`.
 *
 * ## It shares the list's URL state, and that is the whole design
 *
 * Search, priority, project, creator, assignee, dates, and sort come from the
 * same `useTaskListParams` the list page uses, so a filtered view survives the
 * switch between views in both directions and a shared board link carries the
 * filters the sender was looking at.
 *
 * Two keys behave differently here, and both differences are deliberate:
 *
 * - **`status` selects which columns are shown**, rather than filtering rows
 *   inside them. On a board the columns *are* the status filter, so a status
 *   chip that also removed rows would apply the same constraint twice and leave
 *   the user with columns that are empty for a reason nothing on screen
 *   explains. The "Needs you" preset is "show me the three inbox columns".
 * - **`page` is ignored.** A board pages per column, on its own "Load more"
 *   (`useBoardTasks`), because ten queues fill at ten different rates. The
 *   key is left in the URL untouched so switching back to the list returns to
 *   the page you were on.
 *
 * ## Lanes, and the closed one
 *
 * The ten columns are grouped into `TASK_STATUS_LANES` — Plan, Doing, Waiting,
 * Closed. Closed starts collapsed and its columns are not fetched until it is
 * opened: finished work is the pile that only grows, and it is the one lane
 * nobody works *in*. A status filter that names a closed status opens it,
 * because a filter that selects a hidden column would look like it did nothing.
 * The open/closed toggle is local state: it is neither shareable (URL) nor a
 * preference worth remembering (store).
 *
 * ## Moves that need words
 *
 * There is no transition table, but several targets need a payload — a reason
 * for `blocked`, a question for `needs_user_decision`, a summary for
 * `needs_qa` (`transitionNeedsInput`). Dropping a card on one of those moves the
 * card *optimistically*, then opens `TransitionDialog`; cancelling it puts the
 * card back, exactly as a server rejection does.
 */
export const TasksBoardPage = () => {
  useDocumentTitle("Board");

  /*
    Being here *is* the preference. Every screen that leaves the two views
    behind — detail, create, edit — reads it back out of the store to know which
    one to return to, because their own URLs cannot say. See
    `stores/taskView.ts`.
  */
  useRememberTaskView("board");

  const { params, setSort, setFilters, clearFilters, activeFilterCount } = useTaskListParams();

  const isWide = useMediaQuery(MD_BREAKPOINT_QUERY);

  const [closedToggled, setClosedToggled] = useState(false);
  const closedLaneFiltered = params.status.some((status) =>
    (TASK_STATUS_LANES.closed as readonly TaskStatus[]).includes(status),
  );
  const closedLaneOpen = closedToggled || closedLaneFiltered;

  const facetsQuery = useTaskFacetsQuery();
  const statsQuery = useTaskStatsQuery();
  const board = useBoardTasks(params, { closedLaneOpen });
  const transitionMutation = useTransitionTaskMutation();

  /** The card under the cursor, for the overlay. `null` when nothing is dragging. */
  const [activeTask, setActiveTask] = useState<TaskSummary | null>(null);

  /** A move waiting on `TransitionDialog`. Its card is already shown in `target`. */
  const [pending, setPending] = useState<{
    task: TaskSummary;
    target: TaskStatus;
    initialError?: unknown;
  } | null>(null);

  /**
   * Posts a move whose card is already in its new column. Resolves once the
   * refetch `onSettled` awaits has landed, so dropping the optimistic entry
   * cannot flash the card back to where it came from.
   */
  const commit = (task: TaskSummary, input: TransitionInput) =>
    transitionMutation.mutateAsync({ taskId: task.id, input }).then(() => {
      toast.success(`${formatReference(task.id)} moved to ${TASK_STATUS_LABELS[input.to]}`);
    });

  /**
   * One path for both ways of moving a card — a drop and the card's status
   * select land here.
   *
   * The optimistic entry is written before anything else and removed when the
   * move settles, not on success: a rejected (or cancelled) move has to give
   * the card back, and a successful one has to hold the card in its new column
   * until the refetch has actually landed.
   */
  const move = (taskId: number, target: TaskStatus) => {
    const task = board.byId.get(taskId);
    if (task === undefined) return;

    board.beginMove(taskId, target);

    if (transitionNeedsInput(target, task)) {
      setPending({ task, target });
      return;
    }

    let reopened = false;
    commit(task, { to: target } as TransitionInput)
      .catch((error: unknown) => {
        // The criteria the card said it had are gone — an agent cleared them a
        // moment ago. Ask for them instead of only refusing; the card stays put.
        if (isApiClientError(error) && error.code === "VALIDATION_ERROR") {
          reopened = true;
          setPending({ task, target, initialError: error });
          return;
        }
        toast.error(errorCopy(error).title, { description: statusChangeErrorMessage(error) });
      })
      .finally(() => {
        if (!reopened) board.endMove(taskId);
      });
  };

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
    const task = board.byId.get(Number(event.active.id));
    setActiveTask(task ?? null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveTask(null);

    const target = statusFromDroppableId(event.over?.id);
    if (target === undefined) return;

    const task = board.byId.get(Number(event.active.id));
    if (task === undefined) return;

    // Dropping a card back on the column it started in is a no-op, not a PATCH
    // — the API treats `X → X` as a write-free success, but the round trip would
    // still flash the card's busy state for nothing.
    if (board.effectiveStatus(task) === target) return;

    move(task.id, target);
  };

  /**
   * Screen-reader narration for the drag itself.
   *
   * dnd-kit's defaults announce ids ("Draggable item 42 was dropped over
   * droppable area column:resolved"), which is the internal vocabulary of the
   * library rather than of the app. These name the task and the column.
   */
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up task ${formatReference(Number(active.id))}.`,
    onDragOver: ({ over }) => {
      const status = statusFromDroppableId(over?.id);
      return status === undefined ? "Not over a column." : `Over ${TASK_STATUS_LABELS[status]}.`;
    },
    onDragEnd: ({ active, over }) => {
      const status = statusFromDroppableId(over?.id);
      return status === undefined
        ? `Task ${formatReference(Number(active.id))} was dropped outside a column and did not move.`
        : `Task ${formatReference(Number(active.id))} was moved to ${TASK_STATUS_LABELS[status]}.`;
    },
    onDragCancel: ({ active }) =>
      `Moving task ${formatReference(Number(active.id))} was cancelled.`,
  };

  /*
    Which columns are on screen. Enum order within a lane, never the order the
    user happened to click the chips in — a board whose columns reorder
    themselves as you filter is unreadable.
  */
  const visibleStatuses: readonly TaskStatus[] =
    params.status.length === 0
      ? TASK_STATUSES
      : TASK_STATUSES.filter((status) => params.status.includes(status));

  const lanes = (Object.keys(TASK_STATUS_LANES) as TaskStatusLane[])
    .map((lane) => ({
      lane,
      columns: board.columns.filter(
        (column) =>
          (TASK_STATUS_LANES[lane] as readonly TaskStatus[]).includes(column.status) &&
          visibleStatuses.includes(column.status),
      ),
    }))
    .filter((lane) => lane.columns.length > 0);

  const visibleColumns = lanes.flatMap((lane) =>
    lane.lane === "closed" && !closedLaneOpen ? [] : lane.columns,
  );

  /*
    The collapsed lane cannot count its own columns — they are not fetched. The
    stats endpoint can, but only for the unfiltered board: it takes no filters
    beyond `project`, so under any other filter its numbers would not describe
    what opening the lane would show.
  */
  const closedSummary =
    activeFilterCount === 0 && statsQuery.data !== undefined
      ? TASK_STATUS_LANES.closed
          .map(
            (status) =>
              `${statsQuery.data.byStatus[status]} ${TASK_STATUS_LABELS[status].toLowerCase()}`,
          )
          .join(", ")
      : undefined;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Board</h1>
          <p className="text-sm text-muted-foreground">
            Drag a task between columns to change its status. Some moves ask for a reason first.
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
                  `${TASK_STATUS_LABELS[column.status]}: ${column.total} ${
                    column.total === 1 ? "task" : "tasks"
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
        onDragCancel={() => setActiveTask(null)}
      >
        {/*
          Lanes stack; each lane's columns scroll sideways below `lg` — see
          `BoardLane` for the two classes that keep that scroll inside the lane
          at 360px rather than widening the whole document.
        */}
        <div className="flex flex-col gap-6">
          {lanes.map(({ lane, columns }) => (
            <BoardLane
              key={lane}
              lane={lane}
              total={
                lane === "closed" && !closedLaneOpen
                  ? undefined
                  : columns.some((column) => column.isPending)
                    ? undefined
                    : columns.reduce((sum, column) => sum + column.total, 0)
              }
              collapsible={
                lane === "closed" && !closedLaneFiltered
                  ? {
                      expanded: closedLaneOpen,
                      onToggle: () => setClosedToggled((open) => !open),
                      summary: closedSummary,
                    }
                  : undefined
              }
            >
              {columns.map((column) => (
                <BoardColumn
                  key={column.status}
                  column={column}
                  onMove={move}
                  pendingMoves={board.pendingMoves}
                />
              ))}
            </BoardLane>
          ))}
        </div>

        {/*
          The dragged card is drawn once, in a portal above everything, instead of
          the original being transformed in place. Below `lg` the board is a
          horizontal scroll container, and a transformed card is clipped by it
          the moment it leaves its column — you would watch the card you are
          dragging get cut in half on the way to the next one.
        */}
        <DragOverlay dropAnimation={null}>
          {activeTask === null ? null : <BoardCardOverlay task={activeTask} />}
        </DragOverlay>
      </DndContext>

      {pending === null ? null : (
        <TransitionDialog
          key={`${pending.task.id}:${pending.target}`}
          task={pending.task}
          target={pending.target}
          initialError={pending.initialError}
          onSubmit={(input) =>
            commit(pending.task, input).then(() => {
              board.endMove(pending.task.id);
              setPending(null);
            })
          }
          onCancel={() => {
            board.endMove(pending.task.id);
            setPending(null);
          }}
        />
      )}
    </div>
  );
};
