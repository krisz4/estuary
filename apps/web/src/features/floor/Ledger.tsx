import { HUMAN_ATTENTION_STATUSES, type FloorTask, type TaskStatus } from "@helpdesk/contracts";
import { ChevronDown } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { formatAbsolute, formatCompactAge, formatRelative } from "@/lib/formatting";
import { LabelChips } from "@/features/tasks/LabelChips";
import { PriorityBadge } from "@/features/tasks/PriorityBadge";
import { StatusBadge } from "@/features/tasks/StatusBadge";
import { compareFloorTasks, projectColorIndex } from "@/features/floor/layout";
import { laneColor, readFloorColors } from "@/features/floor/scene";

/**
 * The Ledger — the Map's text twin: grouped, capped-with-"show more",
 * filter-aware, keyboard-navigable (`j`/`k`), kept in sync with canvas
 * hover/selection both ways, and — in `dense` mode (`#all`'s only mode today)
 * — real aligned columns at `>=1024px` instead of a stacked card per row.
 */

const GROUP_CAP = 50;

type Group = { key: string; label: string; statuses: readonly TaskStatus[] };

const GROUPS: Group[] = [
  { key: "you", label: "Needs you", statuses: HUMAN_ATTENTION_STATUSES },
  { key: "building", label: "Under way", statuses: ["in_progress"] },
  { key: "blocked", label: "Blocked", statuses: ["blocked"] },
  { key: "planning", label: "Planning", statuses: ["backlog", "needs_refinement", "todo"] },
  { key: "shipped", label: "Shipped & shelved", statuses: ["done", "deferred"] },
];

/**
 * The dense-mode grid: ref · title(+labels) · status · priority ·
 * assignee/claim · deps · age. Exported so `AllTasksSection`'s sticky column
 * header uses the exact same column widths as the rows underneath it.
 */
export const LEDGER_DENSE_GRID_COLS =
  "lg:grid-cols-[4rem_minmax(0,1fr)_7rem_5rem_8rem_9rem_4rem]";

export type LedgerProps = {
  tasks: readonly FloorTask[];
  total: number;
  projectOrder: readonly string[];
  hasActiveFilters: boolean;
  selectedTaskId?: number | null;
  hoveredTaskId?: number | null;
  onSelectTask: (task: FloorTask) => void;
  onHoverTask: (taskId: number | null) => void;
  className?: string;
  /** Hides the "Ledger (n/m)" header and lays rows out in aligned columns at `>=1024px` — used by `#all`, whose section header already carries the count. */
  dense?: boolean;
};

const ROW_SELECTOR = "[data-ledger-row]";

export const Ledger = ({
  tasks,
  total,
  projectOrder,
  hasActiveFilters,
  selectedTaskId,
  hoveredTaskId,
  onSelectTask,
  onHoverTask,
  className,
  dense = false,
}: LedgerProps) => {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);

  const visible = hasActiveFilters ? tasks.filter((task) => task.matches) : tasks;

  const handleListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "j" && event.key !== "k") return;
    const container = listRef.current;
    if (container === null) return;
    const rows = [...container.querySelectorAll<HTMLButtonElement>(ROW_SELECTOR)];
    if (rows.length === 0) return;
    const activeIndex = rows.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex =
      activeIndex === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, activeIndex + (event.key === "j" ? 1 : -1)));
    event.preventDefault();
    rows[nextIndex]?.focus();
  };

  return (
    <aside
      aria-label="Ledger"
      className={cn(
        dense
          ? "flex flex-col text-foreground"
          : "flex flex-col gap-3 rounded-2xl border border-border bg-map-panel p-3 text-foreground shadow-raised",
        className,
      )}
    >
      {dense ? null : (
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">
            Ledger <span className="font-mono text-xs text-muted-foreground">({visible.length}/{total})</span>
          </h2>
        </div>
      )}

      <div
        ref={listRef}
        onKeyDown={handleListKeyDown}
        className={dense ? "flex flex-col" : "flex min-h-0 flex-1 flex-col divide-y divide-border overflow-y-auto"}
      >
        {GROUPS.map((group) => {
          const groupTasks = visible
            .filter((task) => (group.statuses as readonly TaskStatus[]).includes(task.status))
            .sort(compareFloorTasks);
          if (groupTasks.length === 0) return null;

          const isExpanded = expanded.has(group.key);
          const isCollapsed = collapsed.has(group.key);
          const shown = isExpanded ? groupTasks : groupTasks.slice(0, GROUP_CAP);

          return (
            <div key={group.key} className={cn("py-2", dense && "border-b border-border last:border-b-0")}>
              <button
                type="button"
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(group.key)) next.delete(group.key);
                    else next.add(group.key);
                    return next;
                  })
                }
                aria-expanded={!isCollapsed}
                className="mb-1 flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase hover:bg-map-panel-2"
              >
                <span className="flex items-center gap-1">
                  <ChevronDown
                    className={cn("size-3.5 transition-transform", isCollapsed && "-rotate-90")}
                    aria-hidden="true"
                  />
                  {group.label}
                </span>
                <span className="font-mono text-[11px] font-normal normal-case">{groupTasks.length}</span>
              </button>
              {isCollapsed ? null : (
                <>
                  <ul className="flex flex-col">
                    {shown.map((task) => (
                      <LedgerRow
                        key={task.id}
                        task={task}
                        projectOrder={projectOrder}
                        selected={task.id === selectedTaskId}
                        hovered={task.id === hoveredTaskId}
                        onSelect={() => onSelectTask(task)}
                        onHover={onHoverTask}
                        dense={dense}
                      />
                    ))}
                  </ul>
                  {groupTasks.length > GROUP_CAP && !isExpanded ? (
                    <button
                      type="button"
                      className="mt-1 px-1 text-xs text-primary hover:underline"
                      onClick={() => setExpanded((prev) => new Set(prev).add(group.key))}
                    >
                      Show {groupTasks.length - GROUP_CAP} more
                    </button>
                  ) : null}
                </>
              )}
            </div>
          );
        })}

        {visible.length === 0 ? (
          <p className="px-1 py-6 text-center text-sm text-muted-foreground">
            {hasActiveFilters ? "0 tasks match the current filters." : "Nothing on the map."}
          </p>
        ) : null}
      </div>
    </aside>
  );
};

const LedgerRow = ({
  task,
  projectOrder,
  selected,
  hovered,
  onSelect,
  onHover,
  dense,
}: {
  task: FloorTask;
  projectOrder: readonly string[];
  selected: boolean;
  hovered: boolean;
  onSelect: () => void;
  onHover: (taskId: number | null) => void;
  dense: boolean;
}) => {
  const color = laneColor(projectColorIndex(task.project, projectOrder), readFloorColors());
  const deps: string[] = [];
  if (task.openBlockerCount > 0) deps.push(`waits on ${task.openBlockerCount}`);
  if (task.unblocksCount > 0) deps.push(`unblocks ${task.unblocksCount}`);
  const depsText = deps.length > 0 ? deps.join(" · ") : "—";

  if (!dense) {
    return (
      <li>
        <button
          type="button"
          data-ledger-row
          onClick={onSelect}
          onMouseEnter={() => onHover(task.id)}
          onMouseLeave={() => onHover(null)}
          onFocus={() => onHover(task.id)}
          onBlur={() => onHover(null)}
          aria-current={selected ? "true" : undefined}
          className={cn(
            "grid w-full grid-cols-[auto_1fr_auto] items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm",
            "transition-colors hover:bg-map-panel-2",
            selected && "bg-primary-subtle",
            hovered && !selected && "bg-map-panel-2",
          )}
        >
          <span className="mt-1 size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-baseline gap-1.5">
              <span className="font-mono text-[11px] text-muted-foreground">{task.reference}</span>
              {!task.matches ? <span className="text-[10px] text-muted-foreground italic">dimmed</span> : null}
            </span>
            <span className="line-clamp-2 leading-snug font-medium">{task.title}</span>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <PriorityBadge priority={task.priority} />
              {task.assignee !== null ? <span className="truncate">{task.assignee}</span> : null}
              {task.claim !== null ? <span>claimed</span> : null}
              {deps.length > 0 ? <span>{deps.join(" · ")}</span> : null}
            </span>
          </span>
          <span className="flex flex-col items-end gap-1 text-right text-xs text-muted-foreground">
            <time>{formatRelative(task.updatedAt)}</time>
          </span>
        </button>
      </li>
    );
  }

  // Dense mode: a real aligned grid at `>=1024px` (`LEDGER_DENSE_GRID_COLS`),
  // the same stacked card below it — the table is never the thing that makes
  // the page scroll sideways on a narrower screen.
  return (
    <li className="odd:bg-transparent even:bg-map-panel-2/30">
      <button
        type="button"
        data-ledger-row
        onClick={onSelect}
        onMouseEnter={() => onHover(task.id)}
        onMouseLeave={() => onHover(null)}
        onFocus={() => onHover(task.id)}
        onBlur={() => onHover(null)}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "grid w-full grid-cols-[auto_1fr_auto] items-start gap-2 px-2 py-1.5 text-left text-sm",
          `lg:items-center lg:gap-3 lg:py-0 lg:h-11 ${LEDGER_DENSE_GRID_COLS}`,
          "transition-colors hover:bg-map-panel-2",
          selected && "bg-primary-subtle",
          hovered && !selected && "bg-map-panel-2",
        )}
      >
        <span className="col-start-1 row-start-1 flex items-center gap-1.5">
          <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
          <span className="hidden font-mono text-xs text-muted-foreground lg:inline" title={task.reference}>
            #{task.id}
          </span>
        </span>

        <span className="col-start-2 row-start-1 flex min-w-0 flex-col gap-0.5 lg:col-auto lg:row-auto lg:flex-row lg:items-center lg:gap-2">
          <span className="line-clamp-2 leading-snug font-medium lg:line-clamp-1 lg:truncate">{task.title}</span>
          <LabelChips labels={task.labels} className="lg:shrink-0" />
          <span className="font-mono text-[11px] text-muted-foreground lg:hidden">{task.reference}</span>
        </span>

        <span className="hidden lg:block">
          <StatusBadge status={task.status} />
        </span>
        <span className="hidden lg:block">
          <PriorityBadge priority={task.priority} />
        </span>
        <span className="hidden truncate text-xs text-muted-foreground lg:block">
          {task.claim !== null ? `${task.claim.actor} · claimed` : (task.assignee ?? "unassigned")}
        </span>
        <span className="hidden truncate text-xs text-muted-foreground lg:block">{depsText}</span>
        <time
          className="hidden text-right text-xs text-muted-foreground lg:block"
          title={formatAbsolute(task.updatedAt)}
        >
          {formatCompactAge(task.updatedAt)}
        </time>

        {/* Below `lg`, the columns hidden above collapse back into one metadata line, same as the non-dense card. */}
        <span className="col-start-2 row-start-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground lg:hidden">
          <StatusBadge status={task.status} />
          <PriorityBadge priority={task.priority} />
          {task.assignee !== null ? <span className="truncate">{task.assignee}</span> : null}
          {task.claim !== null ? <span>claimed</span> : null}
          {deps.length > 0 ? <span>{deps.join(" · ")}</span> : null}
        </span>
        <time className="col-start-3 row-start-1 text-right text-xs text-muted-foreground lg:hidden">
          {formatRelative(task.updatedAt)}
        </time>
      </button>
    </li>
  );
};
