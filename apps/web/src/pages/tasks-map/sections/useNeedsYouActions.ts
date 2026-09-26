import { type TaskSummary } from "@helpdesk/contracts";
import { useState } from "react";
import { toast } from "sonner";
import { useAnswerDecisionMutation, useTransitionTaskMutation } from "@/api/tasks";
import { errorCopy, errorDescription } from "@/lib/errorMessages";
import { HAND_BACK_NOTE } from "@/pages/inbox/InboxItem";

/**
 * The one-click primary action for a "needs you" item, shared by the hero
 * rail's compact `NeedsYouCard` and `NeedsYouSection`'s collapsed rows —
 * **one** place calling `useAnswerDecisionMutation`/`useTransitionTaskMutation`
 * for the "fast path" action, rather than two components each wiring the same
 * mutations slightly differently.
 *
 * Only the *unambiguous* action is one click: a decision's recommended
 * option, a QA item's approve, an action item's hand-back. Anything that
 * needs typed input (answering with a note, a QA send-back's reason) is left
 * to the full `InboxItem`/`DecisionAnswer` — reached via `onOpenFull`, not
 * reimplemented here a third time.
 */
export type NeedsYouKind = "decide" | "act" | "review";

export const needsYouKindOf = (task: TaskSummary): NeedsYouKind | null => {
  if (task.status === "needs_user_decision") return "decide";
  if (task.status === "needs_user_action") return "act";
  if (task.status === "needs_qa") return "review";
  return null;
};

export const needsYouKindLabel: Record<NeedsYouKind, string> = {
  decide: "Decide",
  act: "Act",
  review: "Review",
};

/** The one-line context under the title: the question, the first sentence of the instructions, or the QA summary. */
export const needsYouContextLine = (task: TaskSummary): string => {
  if (task.status === "needs_user_decision") return task.openDecision?.question ?? "A decision is needed.";
  if (task.statusNote !== null) {
    const firstSentence = task.statusNote.split(/(?<=[.!?])\s/)[0] ?? task.statusNote;
    return firstSentence;
  }
  return task.status === "needs_qa" ? "Ready for review." : "A manual step is needed.";
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
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const kind = needsYouKindOf(task);
  const contextLine = needsYouContextLine(task);

  const onError = (error: unknown) => toast.error(errorCopy(error).title, { description: errorDescription(error) });

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

  return { kind: null, contextLine, primaryLabel: null, runPrimary: null, isPrimaryPending: false, secondaryLabel: "Open" };
};
