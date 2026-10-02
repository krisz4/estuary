import {
  attentionKindOf,
  COMMENT_BODY_MAX,
  formatReference,
  TASK_ACCEPTANCE_CRITERIA_MAX,
  TASK_STATUS_NOTE_MAX,
  type AttentionKind,
  type TaskStatus,
  type TaskSummary,
  type TransitionInput,
} from "@estuary/contracts";
import { AlertTriangle, Check, CornerUpLeft, Pause, Undo2 } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  useSendBackMutation,
  useTransitionTaskMutation,
  useUpdateTaskMutation,
} from "@/api/tasks";
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
  formatAbsolute,
  formatCount,
  formatRelative,
  TASK_STATUS_LABELS,
  toDateTimeAttribute,
} from "@/lib/formatting";
import { transitionNeedsInput } from "@/lib/statusTransition";

/**
 * One task in the inbox, with the controls that clear it.
 *
 * Switched on `attentionKindOf(task)` — the same classifier the server's
 * `?attention=true` filter uses — rather than raw status, so a new kind added
 * to the contracts shows up here by adding a `case`, not by guessing at a
 * status list:
 *
 * | Kind | Shows | Actions |
 * | ---- | ----- | ------- |
 * | decide | the question, context, options | pick an option / answer in words → `todo` |
 * | act | the instructions (`statusNote`) | **Done — hand back** → `todo`; **Mark done** → `done` |
 * | review | `concerns` prominently when set, else the summary collapsed | **Approve** → `done`; **Send back** → `todo` + a `qa_feedback` comment |
 * | refine | what's missing (`statusNote`) | acceptance criteria + optional note → `todo`; **Dismiss** → `deferred` |
 * | suggested | description, acceptance criteria | **Accept** (clears `needsTriage`); **Dismiss** → `deferred` |
 * | blocked | the reason (`statusNote`) | **Unblock** → `todo`; **Park** → `deferred` |
 *
 * A hand-back/unblock to `todo` goes through `transitionNeedsInput` like every
 * other move: a task without acceptance criteria cannot be `todo`, so the
 * dialog asks for them rather than letting the click fail.
 */
export const InboxItem = ({ task }: { task: TaskSummary }) => {
  const kind = attentionKindOf(task);
  switch (kind) {
    case "decide":
      return (
        <ItemShell task={task} kind={kind}>
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
    case "act":
      return <ActionItem task={task} />;
    case "review":
      return <QaItem task={task} />;
    case "refine":
      return <RefineItem task={task} />;
    case "suggested":
      return <SuggestedItem task={task} />;
    case "blocked":
      return <BlockedItem task={task} />;
    default:
      // Not an attention kind — a poll raced a transition. Render it plainly
      // rather than not at all; the next refetch drops it.
      return (
        <ItemShell task={task} kind={null}>
          {null}
        </ItemShell>
      );
  }
};

/* ------------------------------------------------------------------ *
 * Shared frame
 * ------------------------------------------------------------------ */

/** "Dismissed from the inbox" — the fixed reason every one-click dismiss/park records. */
export const DISMISS_REASON = "Dismissed from the inbox";
export const PARK_REASON = "Parked from the inbox";

const ItemShell = ({
  task,
  kind,
  children,
}: {
  task: TaskSummary;
  kind: AttentionKind | null;
  children: ReactNode;
}) => (
  <article
    aria-labelledby={`inbox-task-${task.id}`}
    className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-raised"
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
      <RelatedContext task={task} kind={kind} />
    </header>
    {children}
  </article>
);

/**
 * Related context, one line, compact: a follow-up's parent, a count of
 * subtasks, an outstanding-dependency count, and — unless this item's own
 * kind already says so — a "Suggested" chip for an agent-filed task nobody
 * has triaged yet.
 */
const RelatedContext = ({
  task,
  kind,
}: {
  task: TaskSummary;
  kind: AttentionKind | null;
}) => {
  const parts: ReactNode[] = [];

  if (task.parentId !== null) {
    parts.push(
      <span key="parent" className="inline-flex items-center gap-1">
        Follow-up of{" "}
        <Link
          to={`/tasks/${task.parentId}`}
          className="font-mono text-primary hover:underline"
        >
          {formatReference(task.parentId)}
        </Link>
      </span>,
    );
  }
  if (task.childCount > 0) {
    parts.push(<span key="children">{formatCount(task.childCount, "subtask")}</span>);
  }
  if (task.openDependencyCount > 0) {
    parts.push(<span key="deps">waits on {task.openDependencyCount}</span>);
  }
  if (task.needsTriage && kind !== "suggested") {
    parts.push(
      <span
        key="suggested"
        className="inline-flex items-center rounded-full bg-attention-subtle px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-attention-subtle-foreground uppercase"
      >
        Suggested
      </span>,
    );
  }

  if (parts.length === 0) return null;

  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {parts.map((part, index) => (
        <span key={index} className="inline-flex items-center gap-1">
          {index > 0 ? <span aria-hidden="true">·</span> : null}
          {part}
        </span>
      ))}
    </p>
  );
};

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

const AcceptanceCriteriaDetails = ({ criteria }: { criteria: string }) => (
  <details className="text-sm">
    <summary className="cursor-pointer text-muted-foreground">Acceptance criteria</summary>
    <p className="mt-1 whitespace-pre-wrap text-foreground">{criteria}</p>
  </details>
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

/**
 * A fixed-reason move with no dialog — "Dismiss"/"Park" — the one write a
 * one-click action needs, reported with its own toast and errors.
 */
const useFixedMove = (task: TaskSummary) => {
  const mutation = useTransitionTaskMutation();
  const [isPending, setIsPending] = useState(false);

  const run = (input: TransitionInput, success: string) => {
    setIsPending(true);
    return mutation
      .mutateAsync({ taskId: task.id, input })
      .then(() => toast.success(success))
      .catch((error: unknown) =>
        toast.error(errorCopy(error).title, { description: errorDescription(error) }),
      )
      .finally(() => setIsPending(false));
  };

  return { run, isPending };
};

/* ------------------------------------------------------------------ *
 * Needs action
 * ------------------------------------------------------------------ */

/** What a hand-back records as the task's status note, for the next agent. */
export const HAND_BACK_NOTE = "A human did the manual step. Carry on.";

const ActionItem = ({ task }: { task: TaskSummary }) => {
  const { move, dialog, pendingTarget, isPending } = useInboxMove(task);

  return (
    <ItemShell task={task} kind="act">
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
 * Needs QA — "review"
 * ------------------------------------------------------------------ */

/**
 * What the reviewer must not miss, set only on a hand-off whose agent flagged
 * something — a deviation, a risk, something left out. Rendered above the
 * summary in the attention tone, the one place amber means "look here", not
 * just "waits on you".
 */
const ConcernsPanel = ({ text }: { text: string }) => (
  <section
    aria-label="What the reviewer should not miss"
    className="flex flex-col gap-1.5 rounded-lg border border-attention/40 bg-attention-subtle/60 p-4"
  >
    <h4 className="inline-flex items-center gap-1.5 text-sm font-semibold text-attention-subtle-foreground">
      <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
      Don&apos;t miss this
    </h4>
    <p className="text-sm whitespace-pre-wrap text-foreground">{text}</p>
  </section>
);

const QaItem = ({ task }: { task: TaskSummary }) => {
  const { move, dialog, pendingTarget, isPending } = useInboxMove(task);
  const [isSendBackOpen, setSendBackOpen] = useState(false);
  // No `concerns` on the hand-off: routine, so the body is collapsed and
  // Approve is the obvious next click — the inbox's one-click promise for
  // the common case. A flagged hand-off shows `concerns` in the open instead.
  const isRoutine = task.concerns === null;

  const body = (
    <>
      <NoteOrFallback task={task} fallback="No summary was given." />
      {task.links.length === 0 ? null : <TaskLinks links={task.links} />}
      {task.acceptanceCriteria === null ? null : (
        <AcceptanceCriteriaDetails criteria={task.acceptanceCriteria} />
      )}
    </>
  );

  return (
    <ItemShell task={task} kind="review">
      {task.concerns === null ? null : <ConcernsPanel text={task.concerns} />}

      {isRoutine ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            Routine hand-off — view the summary
          </summary>
          <div className="mt-2 flex flex-col gap-2">{body}</div>
        </details>
      ) : (
        body
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

/* ------------------------------------------------------------------ *
 * Needs refinement — "refine"
 * ------------------------------------------------------------------ */

/**
 * Say what done looks like. The one form this kind needs: acceptance
 * criteria (required — `todo` cannot exist without them) and an optional note
 * for whichever agent picks it up next. A failed submit keeps every value
 * typed; "Dismiss" is a fixed-reason `deferred` move, one click, no dialog.
 */
const RefineItem = ({ task }: { task: TaskSummary }) => {
  const transition = useTransitionTaskMutation();
  const dismiss = useFixedMove(task);
  const [criteria, setCriteria] = useState("");
  const [notes, setNotes] = useState("");
  const [criteriaError, setCriteriaError] = useState<string | undefined>(undefined);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const isSubmitting = transition.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedCriteria = criteria.trim();
    if (trimmedCriteria === "") {
      setCriteriaError("Acceptance criteria are required before a task can be todo");
      return;
    }
    setCriteriaError(undefined);
    setFormErrors([]);

    const trimmedNotes = notes.trim();
    transition
      .mutateAsync({
        taskId: task.id,
        input: {
          to: "todo",
          acceptanceCriteria: trimmedCriteria,
          ...(trimmedNotes === "" ? {} : { reason: trimmedNotes }),
        },
      })
      .then(() => toast.success(`${task.reference} is ready — it's in To do`))
      // Nothing cleared: the typed criteria and note stay for another try.
      .catch((error: unknown) =>
        setFormErrors([`${errorCopy(error).title}. ${errorDescription(error)}`]),
      );
  };

  return (
    <ItemShell task={task} kind="refine">
      {task.statusNote === null ? (
        <p className="text-sm text-muted-foreground">No details were given about what's missing.</p>
      ) : (
        <StatusNotePanel status="needs_refinement" note={task.statusNote} headingLevel={4} />
      )}

      <form noValidate className="flex flex-col gap-3" onSubmit={submit}>
        <FormErrorSummary messages={formErrors} />

        <Field label="Acceptance criteria" error={criteriaError} required>
          {(field) => (
            <Textarea
              {...field}
              value={criteria}
              onChange={(event) => setCriteria(event.target.value)}
              maxLength={TASK_ACCEPTANCE_CRITERIA_MAX}
              rows={3}
              autoFocus
            />
          )}
        </Field>

        <Field label="Notes for the agent" help="Optional.">
          {(field) => (
            <Textarea
              {...field}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              maxLength={TASK_STATUS_NOTE_MAX}
              rows={2}
            />
          )}
        </Field>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" isLoading={isSubmitting} disabled={dismiss.isPending}>
            <Check aria-hidden="true" />
            Ready for To do
          </Button>
          <Button
            type="button"
            variant="outline"
            isLoading={dismiss.isPending}
            disabled={isSubmitting}
            onClick={() =>
              dismiss.run(
                { to: "deferred", reason: DISMISS_REASON },
                `${task.reference} dismissed`,
              )
            }
          >
            Dismiss
          </Button>
        </div>
      </form>
    </ItemShell>
  );
};

/* ------------------------------------------------------------------ *
 * Agent-filed, untriaged — "suggested"
 * ------------------------------------------------------------------ */

const SuggestedItem = ({ task }: { task: TaskSummary }) => {
  const acceptMutation = useUpdateTaskMutation(task.id);
  const dismiss = useFixedMove(task);
  const [isAccepting, setIsAccepting] = useState(false);

  const accept = () => {
    setIsAccepting(true);
    acceptMutation
      .mutateAsync({ needsTriage: false, expectedVersion: task.version })
      .then(() => toast.success(`${task.reference} accepted`))
      .catch((error: unknown) =>
        toast.error(errorCopy(error).title, { description: errorDescription(error) }),
      )
      .finally(() => setIsAccepting(false));
  };

  return (
    <ItemShell task={task} kind="suggested">
      <p className="line-clamp-3 text-sm text-foreground">{task.description}</p>
      {task.acceptanceCriteria === null ? null : (
        <AcceptanceCriteriaDetails criteria={task.acceptanceCriteria} />
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button isLoading={isAccepting} disabled={dismiss.isPending} onClick={accept}>
          <Check aria-hidden="true" />
          Accept
        </Button>
        <Button
          variant="outline"
          isLoading={dismiss.isPending}
          disabled={isAccepting}
          onClick={() =>
            dismiss.run({ to: "deferred", reason: DISMISS_REASON }, `${task.reference} dismissed`)
          }
        >
          Dismiss
        </Button>
      </div>
    </ItemShell>
  );
};

/* ------------------------------------------------------------------ *
 * Blocked outside — "blocked"
 * ------------------------------------------------------------------ */

const BlockedItem = ({ task }: { task: TaskSummary }) => {
  const { move, dialog, pendingTarget, isPending } = useInboxMove(task);
  const park = useFixedMove(task);

  return (
    <ItemShell task={task} kind="blocked">
      <NoteOrFallback task={task} fallback="No reason was given." />

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          isLoading={pendingTarget === "todo"}
          disabled={isPending || park.isPending}
          onClick={() => move({ to: "todo" }, `${task.reference} moved to To do`)}
        >
          <CornerUpLeft aria-hidden="true" />
          Unblock
        </Button>
        <Button
          variant="outline"
          isLoading={park.isPending}
          disabled={isPending}
          onClick={() => park.run({ to: "deferred", reason: PARK_REASON }, `${task.reference} parked`)}
        >
          <Pause aria-hidden="true" />
          Park
        </Button>
      </div>

      {dialog}
    </ItemShell>
  );
};
