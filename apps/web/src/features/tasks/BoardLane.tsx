import { type TaskStatusLane } from "@helpdesk/contracts";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, type ReactNode } from "react";
import { Button } from "@/components/ui";
import { TASK_LANE_LABELS } from "@/lib/formatting";

/**
 * One lane of the board — Plan, Doing, Waiting, Closed (`TASK_STATUS_LANES`) —
 * holding its status columns side by side.
 *
 * Ten columns in one row do not fit any screen, and they are not ten equal
 * things: "what's planned", "what's moving", "what's stuck on someone", "what's
 * finished". So the lanes stack vertically and each lane's two or three columns
 * share its width from `lg`. Below `lg` a lane is a sideways-scrolling row with
 * scroll-snap, one column at a time — the board's mobile behaviour, per lane.
 *
 * A lane can be **collapsible** (the closed lane is, and starts collapsed):
 * the toggle is a real button with `aria-expanded` and `aria-controls`, and the
 * collapsed lane renders no columns at all — nothing to fetch, nothing to tab
 * through.
 */
export type BoardLaneProps = {
  lane: TaskStatusLane;
  /** Sum of the lane's column counts, when known. */
  total: number | undefined;
  /** Omit for a lane that cannot collapse. */
  collapsible?: { expanded: boolean; onToggle: () => void; summary?: string };
  children: ReactNode;
};

export const BoardLane = ({ lane, total, collapsible, children }: BoardLaneProps) => {
  const headingId = useId();
  const contentId = useId();
  const label = TASK_LANE_LABELS[lane];
  const expanded = collapsible === undefined || collapsible.expanded;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 id={headingId} className="text-base font-semibold text-foreground">
          {label}
        </h2>
        {total === undefined ? null : (
          <span className="text-sm text-muted-foreground tabular-nums">
            {total} {total === 1 ? "task" : "tasks"}
          </span>
        )}

        {collapsible === undefined ? null : (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={collapsible.onToggle}
            className="text-muted-foreground"
          >
            {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
            {expanded ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
            {!expanded && collapsible.summary !== undefined ? (
              <span className="font-normal">· {collapsible.summary}</span>
            ) : null}
          </Button>
        )}
      </div>

      {expanded ? (
        /*
          Two classes here are load-bearing rather than defensive, and both were
          measured against the 375px spec in `e2e/board.spec.ts`:

          - **`min-w-0`.** This div is a flex *item* of the page's column, and a
            flex item's default `min-width: auto` refuses to shrink below its
            content — so `overflow-x-auto` had nothing to clip and the columns
            pushed the whole document sideways.
          - **`relative`.** The cards contain `sr-only` spans, which are
            `position: absolute`, and an absolutely positioned element is only
            clipped by an ancestor in its *containing block* chain. Without a
            positioned scroller they resolved against the initial containing
            block and stretched the document to the full width of every column.

          `items-start`: a column is as tall as its own queue, not as tall as
          the fullest one beside it.
        */
        <div
          id={contentId}
          className="relative -mx-1 flex min-w-0 snap-x snap-mandatory items-start gap-3 overflow-x-auto px-1 pb-2 lg:snap-none lg:overflow-x-visible"
        >
          {children}
        </div>
      ) : (
        <div id={contentId} hidden />
      )}
    </section>
  );
};
