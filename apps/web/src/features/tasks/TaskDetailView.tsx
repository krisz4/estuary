import { type Task, type TaskStatus, type TransitionInput } from "@estuary/contracts";
import { AlertTriangle, Check, ExternalLink, FolderGit2, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { isApiClientError } from "@/api/http";
import {
  useClaimTaskMutation,
  useDeleteTaskMutation,
  useReleaseTaskMutation,
  useTaskQuery,
  useTransitionTaskMutation,
  useUpdateTaskMutation,
} from "@/api/tasks";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorPanel } from "@/components/ErrorPanel";
import { NotFoundState } from "@/components/NotFoundState";
import { PageHeader } from "@/components/PageHeader";
import { Button, DialogTitle } from "@/components/ui";
import { CommentThread } from "@/features/comments/CommentThread";
import { ActivityTimeline } from "@/features/tasks/ActivityTimeline";
import { ActorBadge } from "@/features/tasks/ActorBadge";
import { ClaimIndicator } from "@/features/tasks/ClaimIndicator";
import { DecisionAnswer } from "@/features/tasks/DecisionAnswer";
import { DependencyEditor, TaskRefList } from "@/features/tasks/DependencyList";
import { LabelChips } from "@/features/tasks/LabelChips";
import { PastDecisions } from "@/features/tasks/PastDecisions";
import { PriorityBadge } from "@/features/tasks/PriorityBadge";
import { StatusNotePanel } from "@/features/tasks/StatusNotePanel";
import { StatusSelect } from "@/features/tasks/StatusSelect";
import { StatusCourse } from "@/features/tasks/StatusCourse";
import { TaskChain } from "@/features/tasks/TaskChain";
import { TaskLinks } from "@/features/tasks/TaskLinks";
import { TransitionDialog } from "@/features/tasks/TransitionDialog";
import { errorCopy, errorDescription } from "@/lib/errorMessages";
import {
  TASK_STATUS_LABELS,
  actorDisplayName,
  formatAbsolute,
  formatRelative,
  toDateTimeAttribute,
} from "@/lib/formatting";
import { transitionNeedsInput } from "@/lib/statusTransition";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { DetailField } from "@/pages/task-detail/DetailField";
import { DetailSkeleton } from "@/pages/task-detail/DetailSkeleton";

/**
 * One task, in full: the description, criteria, links, the decision waiting on
 * a human, comments, and activity, beside a properties column (status, claim,
 * fields, dependencies). Spec: `docs/pages/Task_Detail.md`.
 *
 * Two hosts, one body, so answering a decision or moving a status behaves the
 * same everywhere:
 *
 * - `page` — `/tasks/:taskId`. Owns the document title, a `PageHeader` with the
 *   back link, Edit and Delete.
 * - `dialog` — inside the map's `TaskWorkspaceDialog`. The heading is the
 *   dialog's `DialogTitle` (with the host's `headerStart`, e.g. "← Backlog",
 *   before it), "Open full page" joins the actions, the chain navigator
 *   (`TaskChain`, plus `[` / `]`) sits in the properties column, and a replay
 *   (`replayingAt`) disables every write behind a banner.
 *
 * The task polls (`api/polling.ts`), so an agent's transition, comment or
 * question appears without a reload.
 */
export type TaskDetailViewProps = {
  taskId: number;
  variant: "page" | "dialog";
  /** After a confirmed delete succeeds — the page leaves for the list, the dialog goes back. */
  onDeleted: () => void;
  /** Dialog only: rendered above the reference, e.g. a "← Backlog" button. */
  headerStart?: ReactNode;
  /** Dialog only: open another task in place — the chain navigator and `[` / `]`. */
  onNavigate?: (taskId: number) => void;
  /** Set while the map replays (`?at=`): every write is disabled and a banner explains why. */
  replayingAt?: string | null;
  onBackToNow?: () => void;
};

/** The move waiting on `TransitionDialog`, and the rejection that opened it, if any. */
type PendingTransition = { target: TaskStatus; initialError?: unknown };

export const TaskDetailView = ({
  taskId,
  variant,
  onDeleted,
  headerStart,
  onNavigate,
  replayingAt,
  onBackToNow,
}: TaskDetailViewProps) => {
  const location = useLocation();
  const isDialog = variant === "dialog";
  const isReplaying = replayingAt !== undefined && replayingAt !== null;

  const [isDeleteOpen, setDeleteOpen] = useState(false);
  const [isReleaseOpen, setReleaseOpen] = useState(false);
  const [pending, setPending] = useState<PendingTransition | null>(null);
  const [statusError, setStatusError] = useState<unknown>(null);
  const [statusAnnouncement, setStatusAnnouncement] = useState("");

  const { data: task, error, isPending, isFetching, refetch } = useTaskQuery(taskId);

  const transitionMutation = useTransitionTaskMutation();
  const claimMutation = useClaimTaskMutation(taskId);
  const releaseMutation = useReleaseTaskMutation(taskId);
  const deleteMutation = useDeleteTaskMutation();
  const updateMutation = useUpdateTaskMutation(taskId);
  const [isAccepting, setIsAccepting] = useState(false);

  // The dialog sits over the map, whose own title stays; `undefined` is a no-op.
  useDocumentTitle(!isDialog && task !== undefined ? task.reference : undefined);

  // `[` / `]` step to the first waits-on / unblocks task — a one-hop keyboard
  // chain-walk, dialog only (the page has no in-place navigation).
  useEffect(() => {
    if (onNavigate === undefined || task === undefined) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
        return;
      if (event.key === "[" && task.dependencies[0] !== undefined)
        onNavigate(task.dependencies[0].id);
      else if (event.key === "]" && task.dependents[0] !== undefined)
        onNavigate(task.dependents[0].id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onNavigate, task]);

  const isMissing = isApiClientError(error) && error.code === "TASK_NOT_FOUND";

  /** The heading for the states before a task is loaded — a dialog still needs its title. */
  const placeholderHeader = isDialog ? (
    <div className="flex flex-col gap-1">
      {headerStart}
      <DialogTitle>Task</DialogTitle>
    </div>
  ) : (
    <PageHeader title="Task" />
  );

  if (isPending) {
    return isDialog ? (
      <div className="flex flex-col gap-4">
        <DialogTitle className="sr-only">Loading task</DialogTitle>
        {headerStart}
        <DetailSkeleton />
      </div>
    ) : (
      <DetailSkeleton />
    );
  }

  if (isMissing) {
    return (
      <div className="flex flex-col gap-6">
        {placeholderHeader}
        <NotFoundState />
      </div>
    );
  }

  if (task === undefined) {
    return (
      <div className="flex flex-col gap-6">
        {placeholderHeader}
        <ErrorPanel error={error} onRetry={() => void refetch()} isRetrying={isFetching} />
      </div>
    );
  }

  const announce = (updated: Task) => {
    const label = TASK_STATUS_LABELS[updated.status];
    setStatusAnnouncement(`Status changed to ${label}`);
    toast.success(`${updated.reference} is now ${label}`);
  };

  /** Clears `needsTriage` — "Accept" for an agent-filed task nobody has looked at yet. */
  const acceptSuggestion = () => {
    setIsAccepting(true);
    updateMutation
      .mutateAsync({ needsTriage: false, expectedVersion: task.version })
      .then(() => toast.success(`${task.reference} accepted`))
      .catch((acceptError: unknown) =>
        toast.error(errorCopy(acceptError).title, { description: errorDescription(acceptError) }),
      )
      .finally(() => setIsAccepting(false));
  };

  /** Posts a move. The dialog awaits it; a direct pick fires and forgets. */
  const transition = (input: TransitionInput) =>
    transitionMutation.mutateAsync({ taskId, input }).then((updated) => {
      setPending(null);
      announce(updated);
    });

  const changeStatus = (next: TaskStatus) => {
    setStatusError(null);

    if (transitionNeedsInput(next, task)) {
      setPending({ target: next });
      return;
    }

    transition({ to: next } as TransitionInput).catch((moveError: unknown) => {
      // The criteria this view thought the task had were cleared by someone
      // else a moment ago: ask for them rather than only saying no.
      if (isApiClientError(moveError) && moveError.code === "VALIDATION_ERROR") {
        setPending({ target: next, initialError: moveError });
        return;
      }
      // Inline next to the control, not a toast — it names the claim holder,
      // and belongs beside the control the user is about to use again.
      // `useTransitionTaskMutation` has already rolled the optimistic value back.
      setStatusError(moveError);
    });
  };

  const confirmDelete = () => {
    deleteMutation.mutate(taskId, {
      onSuccess: () => {
        setDeleteOpen(false);
        toast.success(`${task.reference} deleted`);
        onDeleted();
      },
      onError: (deleteError) => {
        setDeleteOpen(false);
        toast.error(errorCopy(deleteError).title, { description: errorDescription(deleteError) });
      },
    });
  };

  const confirmRelease = () => {
    releaseMutation.mutate(
      {},
      {
        onSuccess: (updated) => {
          setReleaseOpen(false);
          toast.success(`Released — ${updated.reference} is back in To do`);
        },
        onError: (releaseError) => {
          setReleaseOpen(false);
          toast.error(errorCopy(releaseError).title, {
            description: errorDescription(releaseError),
          });
        },
      },
    );
  };

  const claim = () => {
    claimMutation.mutate(
      {},
      {
        onSuccess: (updated) => toast.success(`You're working on ${updated.reference}`),
        onError: (claimError) =>
          toast.error(errorCopy(claimError).title, { description: errorDescription(claimError) }),
      },
    );
  };

  const openDecision =
    task.status === "needs_user_decision" && task.openDecision !== null ? task.openDecision : null;
  const pastDecisions = task.decisions.filter((decision) => decision.status !== "open");

  const actions = isReplaying ? null : (
    <>
      <Button asChild variant="outline" size={isDialog ? "sm" : "md"}>
        <Link to={`/tasks/${task.id}/edit`} state={location.state}>
          <Pencil aria-hidden="true" />
          Edit
        </Link>
      </Button>
      {/*
        Outlined, not a solid red fill: a filled Delete was the loudest
        thing on the page, pulling the eye to the one action you almost
        never want. The confirm dialog's own button is the solid one.
      */}
      <Button
        variant="outline"
        size={isDialog ? "sm" : "md"}
        className="border-destructive/40 text-destructive hover:bg-destructive-subtle hover:text-destructive-subtle-foreground"
        onClick={() => setDeleteOpen(true)}
      >
        <Trash2 aria-hidden="true" />
        Delete
      </Button>
    </>
  );

  return (
    <div className="flex flex-col gap-6">
      {isDialog ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            {headerStart}
            <p className="font-mono text-xs tracking-wide text-muted-foreground">
              {task.reference}
            </p>
            <DialogTitle className="text-xl font-semibold break-words">{task.title}</DialogTitle>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link to={`/tasks/${task.id}`}>
                <ExternalLink aria-hidden="true" />
                Open full page
              </Link>
            </Button>
            {actions}
          </div>
        </div>
      ) : (
        <PageHeader eyebrow={task.reference} title={task.title} actions={actions} />
      )}

      <StatusCourse status={task.status} className="max-w-3xl" />

      {/* Polite, so it does not interrupt — the change is already visible. */}
      <p aria-live="polite" className="sr-only">
        {statusAnnouncement}
      </p>

      {replayingAt === undefined || replayingAt === null ? null : (
        <div className="rounded-md border border-attention/50 bg-attention-subtle p-3 text-sm">
          <p className="font-semibold">
            Viewing{" "}
            {new Date(replayingAt).toLocaleString(undefined, {
              weekday: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
          <p className="mt-0.5 text-muted-foreground">
            Statuses only — titles and priority shown are today&apos;s. Actions are off while
            replaying.
          </p>
          {onBackToNow === undefined ? null : (
            <Button variant="outline" size="sm" className="mt-2" onClick={onBackToNow}>
              Back to now
            </Button>
          )}
        </div>
      )}

      {/* Every write below is off while replaying — a snapshot of the past is read-only. */}
      <fieldset disabled={isReplaying} className="contents">
        {/*
          The "why" of the status, and the question waiting on a human, sit above
          both columns — on a phone above everything else. They are what someone
          opening a task from the inbox came for.
        */}
        {task.statusNote === null &&
        openDecision === null &&
        task.concerns === null &&
        !task.needsTriage ? null : (
          <div className="flex flex-col gap-3">
            {task.concerns === null ? null : (
              <section
                aria-label="What the reviewer should not miss"
                className="flex flex-col gap-1.5 rounded-lg border border-attention/40 bg-attention-subtle/60 p-4"
              >
                <h2 className="inline-flex items-center gap-1.5 text-sm font-semibold text-attention-subtle-foreground">
                  <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
                  Don&apos;t miss this
                </h2>
                <p className="text-sm whitespace-pre-wrap text-foreground">{task.concerns}</p>
              </section>
            )}
            {task.statusNote === null ? null : (
              <StatusNotePanel status={task.status} note={task.statusNote} />
            )}
            {!task.needsTriage ? null : (
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>Suggested by an agent — not reviewed yet.</span>
                <Button size="sm" variant="outline" isLoading={isAccepting} onClick={acceptSuggestion}>
                  <Check aria-hidden="true" />
                  Accept
                </Button>
              </div>
            )}
            {openDecision === null ? null : (
              <DecisionAnswer
                taskId={task.id}
                reference={task.reference}
                decision={openDecision}
                headingLevel={2}
              />
            )}
          </div>
        )}

        {/*
          Below `md` the summary comes FIRST, then the description and thread.
          With source order alone, a phone user has to scroll past the whole
          comment thread and the composer to find out what status the task is
          in. `order` flips the two without duplicating either, and the DOM order
          stays main-then-aside so the reading order above `md` matches the
          visual one.
        */}
        <div className="flex flex-col gap-8 md:flex-row md:items-start">
          <div className="order-2 flex min-w-0 flex-1 flex-col gap-8 md:order-1">
            <Section id="description-heading" title="Description">
              {/*
                A text node with `whitespace-pre-wrap`. Line breaks survive; angle
                brackets are displayed, not parsed. There is no
                `dangerouslySetInnerHTML` anywhere in this app.
              */}
              <p className="text-sm whitespace-pre-wrap text-foreground">{task.description}</p>
            </Section>

            <Section id="criteria-heading" title="Acceptance criteria">
              {task.acceptanceCriteria === null ? (
                <p className="text-sm text-muted-foreground">
                  None yet. A task needs them before it can move to To do.
                </p>
              ) : (
                <p className="text-sm whitespace-pre-wrap text-foreground">
                  {task.acceptanceCriteria}
                </p>
              )}
            </Section>

            {task.links.length === 0 ? null : (
              <Section id="links-heading" title="Links">
                <TaskLinks links={task.links} taskId={task.id} />
              </Section>
            )}

            {task.children.length === 0 ? null : (
              <Section id="subtasks-heading" title={`Subtasks (${task.children.length})`}>
                <TaskRefList refs={task.children} currentProject={task.project} />
              </Section>
            )}

            <Section
              id="dependencies-heading"
              title="Waits on"
              action={
                task.dependencies.length === 0 ? null : (
                  <Link
                    to={`/tasks?dependencyOf=${task.id}`}
                    className="text-xs text-primary hover:underline"
                  >
                    View all in list
                  </Link>
                )
              }
            >
              <DependencyEditor
                taskId={task.id}
                dependencies={task.dependencies}
                currentProject={task.project}
              />
            </Section>

            {task.dependents.length === 0 ? null : (
              <Section
                id="dependents-heading"
                title="Needed by"
                action={
                  <Link
                    to={`/tasks?dependsOn=${task.id}`}
                    className="text-xs text-primary hover:underline"
                  >
                    View all in list
                  </Link>
                }
              >
                <TaskRefList refs={task.dependents} currentProject={task.project} />
              </Section>
            )}

            {pastDecisions.length === 0 ? null : (
              <Section id="decisions-heading" title="Past decisions">
                <PastDecisions decisions={pastDecisions} />
              </Section>
            )}

            <CommentThread taskId={task.id} comments={task.comments} />

            <ActivityTimeline taskId={task.id} />
          </div>

          <aside className="order-1 flex w-full flex-col gap-5 rounded-xl border border-border bg-card p-4 shadow-raised md:order-2 md:w-72 md:shrink-0">
            <StatusSelect
              value={task.status}
              onChange={changeStatus}
              isPending={transitionMutation.isPending}
              error={statusError}
            />

            <ClaimPanel
              task={task}
              onRelease={() => setReleaseOpen(true)}
              onClaim={claim}
              isClaiming={claimMutation.isPending}
            />

            {/*
              No "Status" row in this list. `StatusSelect` above already shows the
              current status *and* is the control that changes it — a badge
              repeating the same word 40px below it reads as two different facts.
            */}
            <dl className="grid grid-cols-2 gap-4 md:grid-cols-1">
              <DetailField label="Priority">
                <PriorityBadge priority={task.priority} />
              </DetailField>
              <DetailField label="Project">
                {task.project === null ? (
                  <span className="text-muted-foreground">No project</span>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <FolderGit2 className="size-3.5 text-muted-foreground" aria-hidden="true" />
                    {task.project}
                  </span>
                )}
              </DetailField>
              <DetailField label="Assignee">
                {task.assignee === null ? (
                  <span className="text-muted-foreground">Unassigned</span>
                ) : (
                  task.assignee
                )}
              </DetailField>
              {task.labels.length === 0 ? null : (
                <DetailField label="Labels">
                  <LabelChips
                    labels={task.labels}
                    linkTo={(label) => `/tasks?label=${encodeURIComponent(label)}`}
                  />
                </DetailField>
              )}
              <DetailField label="Created by">
                <ActorBadge actor={task.createdBy} />
              </DetailField>
              {task.parent === null ? null : (
                <DetailField label="Parent">
                  <Link to={`/tasks/${task.parent.id}`} className="text-primary hover:underline">
                    <span className="font-mono text-xs">{task.parent.reference}</span>{" "}
                    {task.parent.title}
                  </Link>
                  {task.parent.project === null || task.parent.project === task.project ? null : (
                    <span className="ml-1 text-xs text-muted-foreground">
                      ({task.parent.project})
                    </span>
                  )}
                </DetailField>
              )}
              <DetailField label="Created">
                <TimeValue iso={task.createdAt} />
              </DetailField>
              <DetailField label="Updated">
                <TimeValue iso={task.updatedAt} />
              </DetailField>
              {task.startedAt === null ? null : (
                <DetailField label="Started">
                  <TimeValue iso={task.startedAt} />
                </DetailField>
              )}
              {task.completedAt === null ? null : (
                <DetailField label="Completed">
                  <TimeValue iso={task.completedAt} />
                </DetailField>
              )}
            </dl>

            {onNavigate === undefined ||
            (task.dependencies.length === 0 && task.dependents.length === 0) ? null : (
              <section aria-labelledby="chain-heading" className="flex flex-col gap-2">
                <h2
                  id="chain-heading"
                  className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                >
                  Chain <span className="font-normal normal-case">([ / ] to step)</span>
                </h2>
                <TaskChain task={task} onNavigate={onNavigate} />
              </section>
            )}
          </aside>
        </div>
      </fieldset>

      {pending === null ? null : (
        <TransitionDialog
          key={pending.target}
          task={task}
          target={pending.target}
          initialError={pending.initialError}
          onSubmit={transition}
          onCancel={() => setPending(null)}
        />
      )}

      <ConfirmDialog
        open={isReleaseOpen}
        onOpenChange={setReleaseOpen}
        title={`Release ${task.reference}?`}
        description={
          task.claim === null
            ? "The task goes back to To do."
            : `${actorDisplayName(task.claim.actor)} is working on it. Releasing the claim stops that and puts the task back in To do for anyone to pick up.`
        }
        confirmLabel="Release claim"
        isPending={releaseMutation.isPending}
        onConfirm={confirmRelease}
      />

      <ConfirmDialog
        open={isDeleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${task.reference}?`}
        description={deleteDescription(task)}
        confirmLabel="Delete task"
        isPending={deleteMutation.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
};

const Section = ({
  id,
  title,
  action,
  children,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) => (
  <section aria-labelledby={id} className="flex flex-col gap-2">
    <div className="flex items-baseline justify-between gap-2">
      <h2 id={id} className="text-base font-semibold text-foreground">
        {title}
      </h2>
      {action}
    </div>
    {children}
  </section>
);

/**
 * Who is working on the task, until when, and the two ways a human intervenes:
 * **Release** a live claim (humans may release anyone's — the classic case is
 * an agent that went quiet), or **Claim** an `in_progress` task whose lease ran
 * out, which is what a crashed agent leaves behind.
 */
const ClaimPanel = ({
  task,
  onRelease,
  onClaim,
  isClaiming,
}: {
  task: Task;
  onRelease: () => void;
  onClaim: () => void;
  isClaiming: boolean;
}) => {
  if (task.claim !== null) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted p-3">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Being worked on
        </p>
        <ClaimIndicator claim={task.claim} showExpiry className="text-sm" />
        <Button variant="outline" size="sm" className="w-fit" onClick={onRelease}>
          Release
        </Button>
      </div>
    );
  }

  if (task.status !== "in_progress") return null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-3">
      <p className="text-sm text-muted-foreground">
        In progress, but nobody holds it — the last claim expired.
      </p>
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={onClaim}
        isLoading={isClaiming}
      >
        Claim it
      </Button>
    </div>
  );
};

/** "Delete TASK-000042? This also deletes its 3 comments. This can't be undone." */
const deleteDescription = (task: Task): string => {
  const count = task.comments.length;
  const comments =
    count === 0 ? "" : ` This also deletes its ${count} ${count === 1 ? "comment" : "comments"}.`;
  return `${task.title}.${comments} This can't be undone.`;
};

const TimeValue = ({ iso }: { iso: string }) => (
  <time dateTime={toDateTimeAttribute(iso)} title={formatAbsolute(iso)}>
    {formatRelative(iso)}
  </time>
);
