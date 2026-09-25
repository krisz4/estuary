import {
  COMMENT_BODY_MAX,
  TASK_ACCEPTANCE_CRITERIA_MAX,
  type TaskStatus,
  type TaskSummary,
  type TransitionInput,
} from "@helpdesk/contracts";
import { Check, CornerUpLeft, Undo2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useSendBackMutation, useTransitionTaskMutation } from "@/api/tasks";
import { FormErrorSummary } from "@/components/FormErrorSummary";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Textarea,
} from "@/components/ui";
import { ActorBadge } from "@/features/tasks/ActorBadge";
import { DecisionAnswer } from "@/features/tasks/DecisionAnswer";
import { PriorityBadge } from "@/features/tasks/PriorityBadge";
import { StatusNotePanel } from "@/features/tasks/StatusNotePanel";
import { TaskLinks } from "@/features/tasks/TaskLinks";
import { TransitionDialog } from "@/features/tasks/TransitionDialog";
import { errorCopy, errorDescription } from "@/lib/errorMessages";
import {
  TASK_STATUS_LABELS,
  formatAbsolute,
  formatRelative,
  toDateTimeAttribute,
} from "@/lib/formatting";
import { transitionNeedsInput } from "@/lib/statusTransition";

/**
 * One task in the inbox, with the controls that clear it.
 *
 * | Status | Shows | Actions |
 * | ------ | ----- | ------- |
 * | needs decision | the question, context, options | pick an option / answer in words → `todo` |
 * | needs action | the instructions (`statusNote`) | **Done — hand back** → `todo`; **Mark done** → `done` |
 * | needs QA | the summary (`statusNote`), links, acceptance criteria | **Approve** → `done`; **Send back** → `todo` + a `qa_feedback` comment |
 *
 * A hand-back to `todo` goes through `transitionNeedsInput` like every other
 * move: a task without acceptance criteria cannot be `todo`, so the dialog asks
 * for them rather than letting the click fail.
 */
export const InboxItem = ({ task }: { task: TaskSummary }) => {
  switch (task.status) {
    case "needs_user_decision":
      return (
        <ItemShell task={task}>
          {task.openDecision === null ? (
            // A decision status with no open decision is an inconsistency the
            // server should not produce; still say something useful.
            <NoteOrFallback task={task} fallback="The question is not available here." />
          ) : (
            <DecisionAnswer
              taskId={task.id}
              reference={task.reference}
              decision={task.openDecision}
              headingLevel={4}
            />
          )}
        </ItemShell>
      );
    case "needs_user_action":
      return <ActionItem task={task} />;
    case "needs_qa":
      return <QaItem task={task} />;
    default:
      // Not an inbox status — a poll raced a transition. Render it plainly
      // rather than not at all; the next refetch drops it.
      return <ItemShell task={task}>{null}</ItemShell>;
  }
};

/* ------------------------------------------------------------------ *
 * Shared frame
 * ------------------------------------------------------------------ */

const ItemShell = ({ task, children }: { task: TaskSummary; children: ReactNode }) => (
  <article
    aria-labelledby={`inbox-task-${task.id}`}
    className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
  >
    <header className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <Link to={`/tasks/${task.id}`} className="font-mono text-primary hover:underline">
          {task.reference}
        </Link>
        <PriorityBadge priority={task.priority} />
        {task.project === null ? null : <span>{task.project}</span>}
        <span className="inline-flex items-center gap-1">
          from <ActorBadge actor={task.createdBy} plain />
        </span>
        <span>
          waiting since{" "}
          <time
            dateTime={toDateTimeAttribute(task.updatedAt)}
            title={formatAbsolute(task.updatedAt)}
          >
            {formatRelative(task.updatedAt)}
          </time>
        </span>
      </div>
      <h3 id={`inbox-task-${task.id}`} className="text-sm font-semibold text-foreground">
        <Link to={`/tasks/${task.id}`} className="hover:underline">
          {task.title}
        </Link>
      </h3>
    </header>
    {children}
  </article>
);

const NoteOrFallback = ({ task, fallback }: { task: TaskSummary; fallback: string }) =>
  task.statusNote === null ? (
    <p className="text-sm text-muted-foreground">
      {fallback}{" "}
      <Link to={`/tasks/${task.id}`} className="text-primary hover:underline">
        Open the task
      </Link>{" "}
      for context.
    </p>
  ) : (
    <StatusNotePanel status={task.status} note={task.statusNote} headingLevel={4} />
  );

/**
 * Transition this item's task, with the dialog when the target needs input.
 * Returns the trigger and the dialog element to render.
 */
const useInboxMove = (task: TaskSummary) => {
  const mutation = useTransitionTaskMutation();
  const [dialogTarget, setDialogTarget] = useState<TaskStatus | null>(null);
  const [pendingTarget, setPendingTarget] = useState<TaskStatus | null>(null);

  const run = (input: TransitionInput, success: string) =>
    mutation.mutateAsync({ taskId: task.id, input }).then(() => {
      toast.success(success);
    });

  const move = (input: TransitionInput, success: string) => {
    if (transitionNeedsInput(input.to, task)) {
      setDialogTarget(input.to);
      return;
    }
    setPendingTarget(input.to);
    run(input, success)
      .catch((error: unknown) =>
        toast.error(errorCopy(error).title, { description: errorDescription(error) }),
      )
      .finally(() => setPendingTarget(null));
  };

  const dialog =
    dialogTarget === null ? null : (
      <TransitionDialog
        key={dialogTarget}
        task={task}
        target={dialogTarget}
        onSubmit={(input) =>
          run(input, `${task.reference} moved to ${TASK_STATUS_LABELS[input.to]}`).then(() =>
            setDialogTarget(null),
          )
        }
        onCancel={() => setDialogTarget(null)}
      />
    );

  return { move, dialog, pendingTarget, isPending: mutation.isPending };
};

/* ------------------------------------------------------------------ *
 * Needs action
 * ------------------------------------------------------------------ */

/** What a hand-back records as the task's status note, for the next agent. */
export const HAND_BACK_NOTE = "A human did the manual step. Carry on.";

const ActionItem = ({ task }: { task: TaskSummary }) => {
  const { move, dialog, pendingTarget, isPending } = useInboxMove(task);

  return (
    <ItemShell task={task}>
      <NoteOrFallback task={task} fallback="No instructions were given." />

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          isLoading={pendingTarget === "todo"}
          disabled={isPending}
          onClick={() =>
            move(
              { to: "todo", reason: HAND_BACK_NOTE },
              `${task.reference} handed back — it's in To do`,
            )
          }
        >
          <CornerUpLeft aria-hidden="true" />
          Done — hand back
        </Button>
        <Button
          variant="outline"
          isLoading={pendingTarget === "done"}
          disabled={isPending}
          onClick={() => move({ to: "done" }, `${task.reference} marked done`)}
        >
          <Check aria-hidden="true" />
          Mark done
        </Button>
      </div>

      {dialog}
    </ItemShell>
  );
};

/* ------------------------------------------------------------------ *
 * Needs QA
 * ------------------------------------------------------------------ */

const QaItem = ({ task }: { task: TaskSummary }) => {
  const { move, dialog, pendingTarget, isPending } = useInboxMove(task);
  const [isSendBackOpen, setSendBackOpen] = useState(false);

  return (
    <ItemShell task={task}>
      <NoteOrFallback task={task} fallback="No summary was given." />

      {task.links.length === 0 ? null : <TaskLinks links={task.links} />}

      {task.acceptanceCriteria === null ? null : (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Acceptance criteria</summary>
          <p className="mt-1 whitespace-pre-wrap text-foreground">{task.acceptanceCriteria}</p>
        </details>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          isLoading={pendingTarget === "done"}
          disabled={isPending}
          onClick={() => move({ to: "done" }, `${task.reference} approved — marked done`)}
        >
          <Check aria-hidden="true" />
          Approve
        </Button>
        <Button variant="outline" disabled={isPending} onClick={() => setSendBackOpen(true)}>
          <Undo2 aria-hidden="true" />
          Send back
        </Button>
      </div>

      {dialog}

      {isSendBackOpen ? (
        <SendBackDialog task={task} onClose={() => setSendBackOpen(false)} />
      ) : null}
    </ItemShell>
  );
};

/**
 * "What needs fixing?" — the one question a send-back needs. The two writes it
 * makes, and why in that order, are `useSendBackMutation`'s.
 */
const SendBackDialog = ({ task, onClose }: { task: TaskSummary; onClose: () => void }) => {
  const mutation = useSendBackMutation();
  const [reason, setReason] = useState("");
  const [criteria, setCriteria] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [criteriaError, setCriteriaError] = useState<string | undefined>(undefined);
  const [formErrors, setFormErrors] = useState<string[]>([]);

  // `→ todo` requires acceptance criteria, and a task can reach needs_qa
  // without ever having had any — ask here rather than letting the send fail.
  const needsCriteria = task.acceptanceCriteria === null;
  const isSubmitting = mutation.isPending;

  const submit = () => {
    const trimmed = reason.trim();
    const trimmedCriteria = criteria.trim();
    const missingReason = trimmed === "";
    const missingCriteria = needsCriteria && trimmedCriteria === "";
    setFieldError(missingReason ? "Say what needs fixing" : undefined);
    setCriteriaError(
      missingCriteria ? "Acceptance criteria are required before a task can be todo" : undefined,
    );
    if (missingReason || missingCriteria) return;
    setFormErrors([]);

    // `mutateAsync`, not `mutate` with per-call callbacks: the send-back takes
    // this item out of the inbox, so the component can unmount before the
    // mutation settles — and per-call callbacks do not fire for an unmounted
    // caller. The promise always settles.
    mutation
      .mutateAsync({
        taskId: task.id,
        reason: trimmed,
        ...(needsCriteria ? { acceptanceCriteria: trimmedCriteria } : {}),
      })
      .then(({ commentError }) => {
        if (commentError === null) {
          toast.success(`${task.reference} sent back to To do`);
        } else {
          toast.error(`${task.reference} was sent back, but the feedback comment failed`, {
            description: errorDescription(commentError),
          });
        }
        onClose();
      })
      // Nothing was written; the dialog and the typed reason stay.
      .catch((error: unknown) =>
        setFormErrors([`${errorCopy(error).title}. ${errorDescription(error)}`]),
      );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isSubmitting) onClose();
      }}
    >
      <DialogContent>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Send {task.reference} back</DialogTitle>
            <DialogDescription>
              It goes back to To do, with your feedback as the first thing the next agent reads.
            </DialogDescription>
          </DialogHeader>

          <FormErrorSummary messages={formErrors} />

          <Field label="What needs fixing?" error={fieldError} required>
            {(field) => (
              <Textarea
                {...field}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={COMMENT_BODY_MAX}
                rows={4}
                autoFocus
              />
            )}
          </Field>

          {needsCriteria ? (
            <Field label="Acceptance criteria" error={criteriaError} required>
              {(field) => (
                <Textarea
                  {...field}
                  value={criteria}
                  onChange={(event) => setCriteria(event.target.value)}
                  maxLength={TASK_ACCEPTANCE_CRITERIA_MAX}
                  rows={3}
                />
              )}
            </Field>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" isLoading={isSubmitting}>
              Send back
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
