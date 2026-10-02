import { attentionKindOf, type AttentionKind, type TaskSummary } from "@estuary/contracts";
import { useState } from "react";
import { toast } from "sonner";
import {
  useAnswerDecisionMutation,
  useTransitionTaskMutation,
  useUpdateTaskMutation,
} from "@/api/tasks";
import { errorCopy, errorDescription } from "@/lib/errorMessages";
import { HAND_BACK_NOTE } from "@/pages/inbox/InboxItem";

/**
 * The one-click primary action for a "needs you" item, shared by the hero
 * rail's compact `NeedsYouCard` and `NeedsYouSection`'s collapsed rows —
 * **one** place calling `useAnswerDecisionMutation`/`useTransitionTaskMutation`/
 * `useUpdateTaskMutation` for the "fast path" action, rather than two
 * components each wiring the same mutations slightly differently.
 *
 * Only the *unambiguous* action is one click: a decision's recommended
 * option, a QA item's approve, an action item's hand-back, a suggested
 * task's accept. Anything that needs typed input (answering with a note, a QA
 * send-back's reason, refine's acceptance criteria, an unblock without
 * criteria) is left to the full `InboxItem`/`DecisionAnswer` — reached via
 * `onOpen`/the row's own expansion, not reimplemented here a third time.
 */
export type NeedsYouKind = AttentionKind;

export const needsYouKindOf = (task: TaskSummary): NeedsYouKind | null => attentionKindOf(task);

/** The one-line context under the title — the question, the note's first sentence, or a fallback per kind. */
export const needsYouContextLine = (task: TaskSummary): string => {
  const kind = needsYouKindOf(task);
  if (kind === "decide") return task.openDecision?.question ?? "A decision is needed.";
  if (kind === "suggested") {
    const firstSentence = task.description.split(/(?<=[.!?])\s/)[0] ?? task.description;
    return firstSentence;
  }
  if (task.statusNote !== null) {
    const firstSentence = task.statusNote.split(/(?<=[.!?])\s/)[0] ?? task.statusNote;
    return firstSentence;
  }
  if (kind === "review") return "Ready for review.";
  if (kind === "act") return "A manual step is needed.";
  if (kind === "blocked") return "Waiting on something no task tracks.";
  return "A decision is needed.";
};

export type NeedsYouActionState = {
  kind: NeedsYouKind | null;
  contextLine: string;
  /** `null` when there is no safe one-click action (e.g. a decision with no recommendation) — only "Other…"/"Open" applies. */
  primaryLabel: string | null;
  runPrimary: (() => void) | null;
  isPrimaryPending: boolean;
  secondaryLabel: string;
};

export const useNeedsYouActions = (task: TaskSummary): NeedsYouActionState => {
  const transition = useTransitionTaskMutation();
  const decisionMutation = useAnswerDecisionMutation();
  const updateMutation = useUpdateTaskMutation(task.id);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const kind = needsYouKindOf(task);
  const contextLine = needsYouContextLine(task);

  const onError = (error: unknown) =>
    toast.error(errorCopy(error).title, { description: errorDescription(error) });

  if (kind === "decide") {
    const recommended = task.openDecision?.recommendedOption ?? null;
    return {
      kind,
      contextLine,
      primaryLabel: recommended,
      runPrimary:
        recommended === null
          ? null
          : () => {
              setPendingKey("decide");
              decisionMutation
                .mutateAsync({ taskId: task.id, input: { choice: recommended } })
                .then(() => toast.success(`Answered — ${task.reference} is back in To do`))
                .catch(onError)
                .finally(() => setPendingKey(null));
            },
      isPrimaryPending: pendingKey === "decide",
      secondaryLabel: "Other…",
    };
  }

  if (kind === "review") {
    return {
      kind,
      contextLine,
      primaryLabel: "Approve",
      runPrimary: () => {
        setPendingKey("approve");
        transition
          .mutateAsync({ taskId: task.id, input: { to: "done" } })
          .then(() => toast.success(`${task.reference} approved — marked done`))
          .catch(onError)
          .finally(() => setPendingKey(null));
      },
      isPrimaryPending: pendingKey === "approve",
      secondaryLabel: "Send back",
    };
  }

  if (kind === "act") {
    return {
      kind,
      contextLine,
      primaryLabel: "Done, hand back",
      runPrimary: () => {
        setPendingKey("handback");
        transition
          .mutateAsync({ taskId: task.id, input: { to: "todo", reason: HAND_BACK_NOTE } })
          .then(() => toast.success(`${task.reference} handed back — it's in To do`))
          .catch(onError)
          .finally(() => setPendingKey(null));
      },
      isPrimaryPending: pendingKey === "handback",
      secondaryLabel: "Open",
    };
  }

  if (kind === "suggested") {
    return {
      kind,
      contextLine,
      primaryLabel: "Accept",
      runPrimary: () => {
        setPendingKey("accept");
        updateMutation
          .mutateAsync({ needsTriage: false, expectedVersion: task.version })
          .then(() => toast.success(`${task.reference} accepted`))
          .catch(onError)
          .finally(() => setPendingKey(null));
      },
      isPrimaryPending: pendingKey === "accept",
      secondaryLabel: "Open",
    };
  }

  // `refine` and `blocked` both need typed input (acceptance criteria, or a
  // dialog for a task without them) — no safe one-click action here.
  return {
    kind,
    contextLine,
    primaryLabel: null,
    runPrimary: null,
    isPrimaryPending: false,
    secondaryLabel: "Open",
  };
};
