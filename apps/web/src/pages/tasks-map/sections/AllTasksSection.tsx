import { type FloorSnapshot, type FloorTask } from "@estuary/contracts";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui";
import { DispatchBar, type DispatchBarProps } from "@/features/floor/DispatchBar";
import { Ledger, LEDGER_DENSE_GRID_COLS } from "@/features/floor/Ledger";
import { ViewSwitch } from "@/features/tasks/ViewSwitch";
import { SectionHeader } from "@/pages/tasks-map/sections/SectionHeader";

/**
 * Section 4, "All tasks" — "oversee everything": the full Dispatch bar (the
 * same URL state the map/hero above already share, via `useFloorParams`), the
 * List⇄Map `ViewSwitch` (moved here from the old page header), and the dense,
 * filterable Ledger, full width. The Dispatch bar and the column header are
 * **one sticky block** (`sticky top-0`) — not two independently-sticky
 * elements stacked with hand-tuned offsets, which breaks the moment either
 * one's height changes (a wrapped filter chip row, a narrower viewport).
 *
 * A "Table" mode reusing `TaskTable`'s columns was in the brief, but
 * `TaskTable` is typed against `TaskSummary` (the list page's richer shape)
 * while this page only ever fetches `FloorTask` (the map's compact shape) —
 * adding a second request just to feed a second view of the same rows isn't
 * "reuse", it's a duplicate fetch for a duplicate table. The Ledger's `dense`
 * mode already gives real aligned columns (ref/title+labels/status/priority/
 * assignee/deps/age) at `>=1024px`; a true row-for-row table view is left as
 * a known gap (see `Tasks_Map.md`), pointed at `/tasks` for now.
 */
export type AllTasksSectionProps = {
  snapshot: FloorSnapshot;
  projectOrder: readonly string[];
  dispatchProps: Omit<DispatchBarProps, "compact" | "toolbar">;
  hasActiveFilters: boolean;
  selectedTaskId: number | undefined;
  hoveredTaskId: number | null;
  onSelectTask: (task: FloorTask) => void;
  onHoverTask: (taskId: number | null) => void;
  onClearFilters: () => void;
};

const COLUMN_LABELS = ["Ref", "Title", "Status", "Priority", "Assignee", "Deps", "Age"];

export const AllTasksSection = ({
  snapshot,
  projectOrder,
  dispatchProps,
  hasActiveFilters,
  selectedTaskId,
  hoveredTaskId,
  onSelectTask,
  onHoverTask,
  onClearFilters,
}: AllTasksSectionProps) => {
  const visible = hasActiveFilters ? snapshot.tasks.filter((task) => task.matches) : snapshot.tasks;
  const zeroMatches = hasActiveFilters && visible.length === 0;
  const countLabel = hasActiveFilters
    ? `${visible.length} of ${snapshot.meta.total} match`
    : snapshot.meta.total;

  return (
    <section id="all" className="scroll-mt-28">
      <div className="sticky top-0 z-20 flex flex-col gap-2 border-b border-border bg-background/95 pt-2 pb-2 backdrop-blur">
        <SectionHeader
          eyebrow="Everything"
          title="All tasks"
          count={countLabel}
          action={<ViewSwitch />}
          tone="primary"
        />
        <DispatchBar {...dispatchProps} compact={false} />
        <div
          className={`hidden items-center gap-3 px-2 pt-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase lg:grid ${LEDGER_DENSE_GRID_COLS}`}
        >
          {COLUMN_LABELS.map((label, index) => (
            <span
              key={label}
              className={index === COLUMN_LABELS.length - 1 ? "text-right" : undefined}
            >
              {label}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-2">
        {zeroMatches ? (
          <EmptyState
            title={`0 of ${snapshot.meta.total} match`}
            description="Try removing a filter."
            action={
              <Button variant="outline" onClick={onClearFilters}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <Ledger
            dense
            tasks={snapshot.tasks}
            total={snapshot.meta.total}
            projectOrder={projectOrder}
            hasActiveFilters={hasActiveFilters}
            selectedTaskId={selectedTaskId}
            hoveredTaskId={hoveredTaskId}
            onSelectTask={onSelectTask}
            onHoverTask={onHoverTask}
          />
        )}
      </div>
    </section>
  );
};
