import { type Task, type TaskRef } from "@estuary/contracts";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { useTaskQuery } from "@/api/tasks";
import { cn } from "@/lib/cn";

/**
 * "waits on ↑" / "unblocks ↓" — one hop from the task's own `dependencies` /
 * `dependents` (already loaded with it), each row expandable to fetch *its*
 * one hop, which is how this reaches two hops without a dedicated endpoint.
 * `[` / `]` (wired in `TaskDetailView`'s dialog variant) jump to the first row
 * in each direction.
 */
export const TaskChain = ({
  task,
  onNavigate,
}: {
  task: Task;
  onNavigate?: (taskId: number) => void;
}) => (
  <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/20 p-2">
    {task.dependencies.length === 0 ? null : (
      <div className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">Waits on ↑</p>
        <ul className="flex flex-col gap-1">
          {task.dependencies.map((taskRef) => (
            <ChainBranch key={taskRef.id} taskRef={taskRef} onNavigate={onNavigate} />
          ))}
        </ul>
      </div>
    )}
    {task.dependents.length === 0 ? null : (
      <div className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">Unblocks ↓</p>
        <ul className="flex flex-col gap-1">
          {task.dependents.map((taskRef) => (
            <ChainBranch key={taskRef.id} taskRef={taskRef} onNavigate={onNavigate} />
          ))}
        </ul>
      </div>
    )}
  </div>
);

// Note: the prop is `taskRef`, not `ref` — in React 19, a prop literally
// named `ref` on a function component is intercepted by React's ref
// machinery instead of being passed through as a plain value, which is not
// what this row-data object is.
const ChainBranch = ({
  taskRef,
  onNavigate,
}: {
  taskRef: TaskRef;
  onNavigate?: (taskId: number) => void;
}) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${taskRef.reference}` : `Expand ${taskRef.reference}`}
          onClick={() => setExpanded((value) => !value)}
          className="text-muted-foreground hover:text-foreground"
        >
          <ChevronRight
            className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          onClick={() => onNavigate?.(taskRef.id)}
          className="min-w-0 flex-1 truncate text-left text-sm text-foreground hover:underline"
        >
          <span className="mr-1.5 font-mono text-xs text-primary">{taskRef.reference}</span>
          {taskRef.title}
        </button>
      </div>
      {/* Mounted only when expanded, so the second hop is fetched lazily —
          not one `GET /tasks/:id` per row the moment the task opens. */}
      {expanded ? <ChainBranchNextHop taskId={taskRef.id} onNavigate={onNavigate} /> : null}
    </li>
  );
};

const ChainBranchNextHop = ({
  taskId,
  onNavigate,
}: {
  taskId: number;
  onNavigate?: (taskId: number) => void;
}) => {
  const nextHop = useTaskQuery(taskId);
  if (nextHop.data === undefined) return null;

  const inner = [...nextHop.data.dependencies, ...nextHop.data.dependents];
  return (
    <ul className="ml-5 flex flex-col gap-1 border-l border-border pl-2">
      {inner.map((entry) => (
        <li key={entry.id}>
          <button
            type="button"
            onClick={() => onNavigate?.(entry.id)}
            className="min-w-0 truncate text-left text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            <span className="mr-1 font-mono text-primary">{entry.reference}</span>
            {entry.title}
          </button>
        </li>
      ))}
      {inner.length === 0 ? (
        <li className="text-xs text-muted-foreground">Nothing further.</li>
      ) : null}
    </ul>
  );
};
