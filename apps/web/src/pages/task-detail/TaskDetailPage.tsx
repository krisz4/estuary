import {
  taskIdParamSchema,
  type Task,
  type TaskStatus,
  type TransitionInput,
} from "@helpdesk/contracts";
import { FolderGit2, Pencil, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { isApiClientError } from "@/api/http";
import {
  useClaimTaskMutation,
  useDeleteTaskMutation,
  useReleaseTaskMutation,
  useTaskQuery,
  useTransitionTaskMutation,
} from "@/api/tasks";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorPanel } from "@/components/ErrorPanel";
import { NotFoundState } from "@/components/NotFoundState";
import { PageHeader, useBackToListPath } from "@/components/PageHeader";
import { Button } from "@/components/ui";
import { CommentThread } from "@/features/comments/CommentThread";
import { ActivityTimeline } from "@/features/tasks/ActivityTimeline";
import { ActorBadge } from "@/features/tasks/ActorBadge";
import { ClaimIndicator } from "@/features/tasks/ClaimIndicator";
import { DecisionAnswer } from "@/features/tasks/DecisionAnswer";
import { DependencyEditor, TaskRefList } from "@/features/tasks/DependencyList";
import { PastDecisions } from "@/features/tasks/PastDecisions";
import { PriorityBadge } from "@/features/tasks/PriorityBadge";
import { StatusNotePanel } from "@/features/tasks/StatusNotePanel";
import { StatusSelect } from "@/features/tasks/StatusSelect";
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
 * `/tasks/:taskId` — spec: `docs/pages/Task_Detail.md`.
 *
 * A page, not a modal, so the URL is shareable — an agent can paste
 * `/tasks/42` into a hand-off note and a human lands on exactly this.
 *
 * The id is parsed with **`taskIdParamSchema` from the contracts package** —
 * the same schema the API's route uses. Two parsers for one concept is how
 * `/tasks/0000000000000000042` came to resolve differently from
 * `?q=0000000000000000042` on the server side (stage 8); the client has no
 * business inventing a third.
 *
 * The task polls (`api/polling.ts`), so an agent's transition, comment or
 * question appears here without a reload.
 */
export const TaskDetailPage = () => {
  const { taskId: raw } = useParams();
  const parsed = taskIdParamSchema.safeParse(raw);

  /*
    Split into two components rather than gating a hook with `enabled`. A
    malformed id has no request to make and no cache entry to hold, and the
    alternative — one component whose query key contains a sentinel id — puts an
    entry for a task that cannot exist into the cache.
  */
  if (!parsed.success) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Task" showBackLink />
        <NotFoundState description="That address does not contain a valid task number." />
      </div>
    );
  }

  return <TaskDetailView taskId={parsed.data} />;
};

/** The move waiting on `TransitionDialog`, and the rejection that opened it, if any. */
type PendingTransition = { target: TaskStatus; initialError?: unknown };

const TaskDetailView = ({ taskId }: { taskId: number }) => {
  const navigate = useNavigate();
  const location = useLocation();

  // Read before the early returns: the delete handler needs the same
  // destination the header's back link points at, and hooks cannot be called
  // below the loading and error branches.
  const backPath = useBackToListPath();

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

  useDocumentTitle(task === undefined ? undefined : task.reference);

  const isMissing = isApiClientError(error) && error.code === "TASK_NOT_FOUND";

  if (isPending) return <DetailSkeleton />;

  if (isMissing) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Task" />
        <NotFoundState />
      </div>
    );
  }

  if (task === undefined) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Task" />
        <ErrorPanel error={error} onRetry={() => void refetch()} isRetrying={isFetching} />
      </div>
    );
  }

  const announce = (updated: Task) => {
    const label = TASK_STATUS_LABELS[updated.status];
    setStatusAnnouncement(`Status changed to ${label}`);
    toast.success(`${updated.reference} is now ${label}`);
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
      // The criteria this page thought the task had were cleared by someone
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
        void navigate(backPath, { replace: true });
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

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={task.reference}
        title={task.title}
        actions={
          <>
            <Button asChild variant="outline">
              <Link to={`/tasks/${task.id}/edit`} state={location.state}>
                <Pencil aria-hidden="true" />
                Edit
              </Link>
            </Button>
            <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2 aria-hidden="true" />
              Delete
            </Button>
          </>
        }
      />

      {/* Polite, so it does not interrupt — the change is already visible. */}
      <p aria-live="polite" className="sr-only">
        {statusAnnouncement}
      </p>

      {/*
        The "why" of the status, and the question waiting on a human, sit above
        both columns — on a phone above everything else. They are what someone
        opening a task from the inbox came for.
      */}
      {task.statusNote === null && openDecision === null ? null : (
        <div className="flex flex-col gap-3">
          {task.statusNote === null ? null : (
            <StatusNotePanel status={task.status} note={task.statusNote} />
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
              <TaskLinks links={task.links} />
            </Section>
          )}

          {task.children.length === 0 ? null : (
            <Section id="subtasks-heading" title={`Subtasks (${task.children.length})`}>
              <TaskRefList refs={task.children} />
            </Section>
          )}

          <Section id="dependencies-heading" title="Waits on">
            <DependencyEditor taskId={task.id} dependencies={task.dependencies} />
          </Section>

          {task.dependents.length === 0 ? null : (
            <Section id="dependents-heading" title="Needed by">
              <TaskRefList refs={task.dependents} />
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

        <aside className="order-1 flex w-full flex-col gap-5 md:order-2 md:w-72 md:shrink-0">
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
            <DetailField label="Created by">
              <ActorBadge actor={task.createdBy} />
            </DetailField>
            {task.parent === null ? null : (
              <DetailField label="Parent">
                <Link to={`/tasks/${task.parent.id}`} className="text-primary hover:underline">
                  <span className="font-mono text-xs">{task.parent.reference}</span>{" "}
                  {task.parent.title}
                </Link>
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
        </aside>
      </div>

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

const Section = ({ id, title, children }: { id: string; title: string; children: ReactNode }) => (
  <section aria-labelledby={id} className="flex flex-col gap-2">
    <h2 id={id} className="text-base font-semibold text-foreground">
      {title}
    </h2>
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
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
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
