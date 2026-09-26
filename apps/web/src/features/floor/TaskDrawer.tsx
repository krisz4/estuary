import { type Task, type TaskRef, type TaskStatus, type TransitionInput } from "@helpdesk/contracts";
import { ChevronRight, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { isApiClientError } from "@/api/http";
import {
  useClaimTaskMutation,
  useReleaseTaskMutation,
  useTaskQuery,
  useTransitionTaskMutation,
} from "@/api/tasks";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Skeleton } from "@/components/ui";
import { ErrorPanel } from "@/components/ErrorPanel";
import { cn } from "@/lib/cn";
import { errorCopy, errorDescription } from "@/lib/errorMessages";
import { TASK_STATUS_LABELS } from "@/lib/formatting";
import { transitionNeedsInput } from "@/lib/statusTransition";
import { ClaimIndicator } from "@/features/tasks/ClaimIndicator";
import { DecisionAnswer } from "@/features/tasks/DecisionAnswer";
import { DependencyEditor, TaskRefList } from "@/features/tasks/DependencyList";
import { LabelChips } from "@/features/tasks/LabelChips";
import { PriorityBadge } from "@/features/tasks/PriorityBadge";
import { StatusNotePanel } from "@/features/tasks/StatusNotePanel";
import { StatusSelect } from "@/features/tasks/StatusSelect";
import { TaskLinks } from "@/features/tasks/TaskLinks";
import { TransitionDialog } from "@/features/tasks/TransitionDialog";

/**
 * The floor's drawer — the place to act on a task without leaving `/tasks/floor`.
 * Reuses the same building blocks the detail page uses, so answering a
 * decision, moving a status, or editing dependencies behaves identically
 * everywhere in the app. "Open full page" is the escape hatch for anything
 * this condensed view does not cover (editing the description, deleting).
 *
 * The selected task id lives in the URL (`?task=42`), so this is shareable —
 * pasting the link opens the floor with the same task open.
 */
export type TaskDrawerProps = {
  taskId: number;
  onClose: () => void;
  /** `[` steps to the first upstream (waits-on) task, `]` to the first downstream (unblocks) one. */
  onNavigate?: (taskId: number) => void;
  /**
   * Set while the tide scrubber is replaying (`?at=`) — every action in the
   * drawer is disabled and a banner explains why, per
   * `docs/pages/Tasks_Floor.md` § Replay. `null`/`undefined` is "now" (live).
   */
  replayingAt?: string | null;
  onBackToNow?: () => void;
};

export const TaskDrawer = ({ taskId, onClose, onNavigate, replayingAt, onBackToNow }: TaskDrawerProps) => (
  <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
    <DialogContent className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto sm:max-w-lg">
      <TaskDrawerBody taskId={taskId} onNavigate={onNavigate} replayingAt={replayingAt} onBackToNow={onBackToNow} />
    </DialogContent>
  </Dialog>
);

type PendingTransition = { target: TaskStatus; initialError?: unknown };

const TaskDrawerBody = ({
  taskId,
  onNavigate,
  replayingAt,
  onBackToNow,
}: {
  taskId: number;
  onNavigate?: (taskId: number) => void;
  replayingAt?: string | null;
  onBackToNow?: () => void;
}) => {
  const isReplaying = replayingAt !== undefined && replayingAt !== null;
  const { data: task, error, isPending, isFetching, refetch } = useTaskQuery(taskId);
  const transitionMutation = useTransitionTaskMutation();
  const claimMutation = useClaimTaskMutation(taskId);
  const releaseMutation = useReleaseTaskMutation(taskId);

  const [pending, setPending] = useState<PendingTransition | null>(null);
  const [statusError, setStatusError] = useState<unknown>(null);

  // `[` / `]` step to the first waits-on / unblocks task — the drawer's
  // one-hop keyboard chain-walk from the plan doc.
  useEffect(() => {
    if (onNavigate === undefined || task === undefined) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === "[" && task.dependencies[0] !== undefined) onNavigate(task.dependencies[0].id);
      else if (event.key === "]" && task.dependents[0] !== undefined) onNavigate(task.dependents[0].id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onNavigate, task]);

  if (isPending) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (task === undefined) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Task</DialogTitle>
        </DialogHeader>
        <ErrorPanel error={error} onRetry={() => void refetch()} isRetrying={isFetching} />
      </>
    );
  }

  const transition = (input: TransitionInput) =>
    transitionMutation.mutateAsync({ taskId, input }).then((updated) => {
      setPending(null);
      toast.success(`${updated.reference} is now ${TASK_STATUS_LABELS[updated.status]}`);
    });

  const changeStatus = (next: TaskStatus) => {
    setStatusError(null);
    if (transitionNeedsInput(next, task)) {
      setPending({ target: next });
      return;
    }
    // Only reached for targets whose payload is an optional reason
    // (`transitionNeedsInput` is false) — the same cast `TaskDetailPage` makes
    // for the same reason: the union is exhaustive on `to`, not narrowable from
    // a runtime boolean check.
    transition({ to: next } as TransitionInput).catch((moveError: unknown) => {
      if (isApiClientError(moveError) && moveError.code === "VALIDATION_ERROR") {
        setPending({ target: next, initialError: moveError });
        return;
      }
      setStatusError(moveError);
    });
  };

  const openDecision =
    task.status === "needs_user_decision" && task.openDecision !== null ? task.openDecision : null;

  return (
    <>
      <DialogHeader>
        <p className="font-mono text-xs text-muted-foreground">{task.reference}</p>
        <DialogTitle className="text-lg">{task.title}</DialogTitle>
      </DialogHeader>

      <div className="flex flex-wrap items-center gap-2">
        <PriorityBadge priority={task.priority} />
        {task.project === null ? null : (
          <span className="text-xs text-muted-foreground">{task.project}</span>
        )}
        <LabelChips labels={task.labels} />
      </div>

      {!isReplaying ? null : (
        <div className="rounded-md border border-attention/50 bg-attention-subtle p-3 text-sm">
          <p className="font-semibold">
            Viewing {new Date(replayingAt as string).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}
          </p>
          <p className="mt-0.5 text-muted-foreground">
            Statuses only — titles and priority shown are today&apos;s. Actions are off while replaying.
          </p>
          {onBackToNow === undefined ? null : (
            <Button variant="outline" size="sm" className="mt-2" onClick={onBackToNow}>
              Back to now
            </Button>
          )}
        </div>
      )}

      {task.links.length === 0 ? null : (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Links
          </h3>
          <TaskLinks links={task.links} taskId={task.id} />
        </section>
      )}

      {task.statusNote === null && openDecision === null ? null : (
        <div className="flex flex-col gap-3">
          {task.statusNote === null ? null : (
            <StatusNotePanel status={task.status} note={task.statusNote} headingLevel={3} />
          )}
          {openDecision === null ? null : (
            <fieldset disabled={isReplaying} className="contents">
              <DecisionAnswer
                taskId={task.id}
                reference={task.reference}
                decision={openDecision}
                headingLevel={3}
              />
            </fieldset>
          )}
        </div>
      )}

      <fieldset disabled={isReplaying} className="contents">
        <StatusSelect
          value={task.status}
          onChange={changeStatus}
          isPending={transitionMutation.isPending}
          error={statusError}
        />
      </fieldset>

      <fieldset disabled={isReplaying} className="contents">
        <ClaimSection task={task} claimMutation={claimMutation} releaseMutation={releaseMutation} />
      </fieldset>

      {task.dependencies.length === 0 && task.dependents.length === 0 ? null : (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Chain
          </h3>
          <ChainSection task={task} onNavigate={onNavigate} />
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Waits on
        </h3>
        <fieldset disabled={isReplaying} className="contents">
          <DependencyEditor
            taskId={task.id}
            dependencies={task.dependencies}
            currentProject={task.project}
          />
        </fieldset>
      </section>

      {task.dependents.length === 0 ? null : (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Needed by
          </h3>
          <TaskRefList refs={task.dependents} currentProject={task.project} />
        </section>
      )}

      {pending === null ? null : (
        <TransitionDialog
          task={task}
          target={pending.target}
          onSubmit={transition}
          onCancel={() => setPending(null)}
          initialError={pending.initialError}
        />
      )}

      <Button asChild variant="outline" className="w-fit">
        <Link to={`/tasks/${task.id}`}>
          <ExternalLink aria-hidden="true" />
          Open full page
        </Link>
      </Button>
    </>
  );
};

const ClaimSection = ({
  task,
  claimMutation,
  releaseMutation,
}: {
  task: Task;
  claimMutation: ReturnType<typeof useClaimTaskMutation>;
  releaseMutation: ReturnType<typeof useReleaseTaskMutation>;
}) => {
  if (task.claim !== null) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 p-2">
        <ClaimIndicator claim={task.claim} showExpiry className="text-sm" />
        <Button
          variant="ghost"
          size="sm"
          isLoading={releaseMutation.isPending}
          onClick={() =>
            releaseMutation.mutate(
              {},
              {
                onSuccess: () => toast.success(`Released — ${task.reference} is back in To do`),
                onError: (releaseError) =>
                  toast.error(errorCopy(releaseError).title, {
                    description: errorDescription(releaseError),
                  }),
              },
            )
          }
        >
          Release
        </Button>
      </div>
    );
  }

  if (task.status !== "in_progress") return null;

  return (
    <Button
      variant="outline"
      size="sm"
      className="w-fit"
      isLoading={claimMutation.isPending}
      onClick={() =>
        claimMutation.mutate(
          {},
          {
            onSuccess: () => toast.success(`You're working on ${task.reference}`),
            onError: (claimError) =>
              toast.error(errorCopy(claimError).title, {
                description: errorDescription(claimError),
              }),
          },
        )
      }
    >
      Claim this task
    </Button>
  );
};

/**
 * "waits on ↑" / "unblocks ↓" — one hop from the task's own `dependencies` /
 * `dependents` (already loaded with it), each row expandable to fetch *its*
 * one hop, which is how this reaches two hops without a dedicated endpoint.
 * `[` / `]` (wired in `TaskDrawerBody`) jump the whole drawer to the first row
 * in each direction.
 */
const ChainSection = ({
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
const ChainBranch = ({ taskRef, onNavigate }: { taskRef: TaskRef; onNavigate?: (taskId: number) => void }) => {
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
          <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} aria-hidden="true" />
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
          not one `GET /tasks/:id` per row the moment the drawer opens. */}
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
      {inner.length === 0 ? <li className="text-xs text-muted-foreground">Nothing further.</li> : null}
    </ul>
  );
};
