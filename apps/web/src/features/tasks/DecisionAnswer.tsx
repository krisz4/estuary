import {
  DECISION_ANSWER_MAX,
  answerDecisionInputSchema,
  type AnswerDecisionInput,
  type Decision,
} from "@estuary/contracts";
import { CircleHelp, Star } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { useAnswerDecisionMutation } from "@/api/tasks";
import { isApiClientError } from "@/api/http";
import { Button, Field, Textarea } from "@/components/ui";
import { cn } from "@/lib/cn";
import { errorCopy, errorDescription } from "@/lib/errorMessages";
import { ActorBadge } from "@/features/tasks/ActorBadge";

/**
 * An agent's open question, and the controls to answer it — shared by the inbox
 * and the task detail page, so the two places a decision can be answered work
 * identically.
 *
 * Picking an option **is** the answer: one click posts `{ choice }`, plus the
 * note when one was typed ("Token bucket, but keep the old endpoint for a
 * release" — the contract allows both). A note alone is also an answer, for the
 * case where none of the options is right. The task then goes back to `todo`
 * with the answer as its status note, for the next agent to pick up.
 *
 * Validation is `answerDecisionInputSchema` — the server's — so a note over
 * the limit is refused with the same message on both sides.
 */
export type DecisionAnswerProps = {
  taskId: number;
  reference: string;
  decision: Decision;
  /** Heading level for the question, so it nests correctly on both pages. */
  headingLevel?: 2 | 3 | 4;
};

export const DecisionAnswer = ({
  taskId,
  reference,
  decision,
  headingLevel = 3,
}: DecisionAnswerProps) => {
  const mutation = useAnswerDecisionMutation();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  /** Which button is in flight, so only that one shows a spinner. */
  const [pending, setPending] = useState<string | null>(null);
  const questionId = useId();

  const Heading = `h${headingLevel}` as const;

  const answer = (choice: string | undefined, key: string) => {
    const trimmed = note.trim();
    const parsed = answerDecisionInputSchema.safeParse({
      ...(choice === undefined ? {} : { choice }),
      ...(trimmed === "" ? {} : { note: trimmed }),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message);
      return;
    }

    setError(undefined);
    setPending(key);
    const input: AnswerDecisionInput = parsed.data;

    // `mutateAsync`: answering takes the task out of `needs_user_decision`,
    // which unmounts this panel (on the inbox *and* on the detail page) once
    // the refetch lands — before per-call `mutate` callbacks would fire.
    mutation
      .mutateAsync({ taskId, input })
      .then(() => {
        // The note is cleared only here — never on a failed answer.
        setNote("");
        toast.success(`Answered — ${reference} is back in To do`);
      })
      .catch((answerError: unknown) => {
        const details = isApiClientError(answerError) ? answerError.validationDetails : undefined;
        const fieldMessage = details?.choice?.[0] ?? details?.note?.[0];
        setError(
          fieldMessage ?? `${errorCopy(answerError).title}. ${errorDescription(answerError)}`,
        );
      })
      .finally(() => setPending(null));
  };

  return (
    <section
      aria-labelledby={questionId}
      className="flex flex-col gap-3 rounded-lg border border-primary/40 bg-primary-subtle/40 p-4"
    >
      <div className="flex flex-col gap-1">
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs font-medium text-primary-subtle-foreground">
          <CircleHelp className="size-3.5" aria-hidden="true" />
          Decision needed · asked by <ActorBadge actor={decision.requestedBy} plain />
        </p>
        <Heading id={questionId} className="text-sm font-semibold text-foreground">
          {decision.question}
        </Heading>
        {decision.context === null ? null : (
          <p className="text-sm whitespace-pre-wrap text-muted-foreground">{decision.context}</p>
        )}
      </div>

      <ul className="flex flex-col gap-2" aria-label="Options">
        {decision.options.map((option) => {
          const isRecommended = option.label === decision.recommendedOption;
          return (
            <li key={option.label}>
              <Button
                variant={isRecommended ? "primary" : "outline"}
                className={cn(
                  "h-auto w-full flex-col items-start gap-0.5 py-2 text-left whitespace-normal",
                )}
                isLoading={pending === `choice:${option.label}`}
                disabled={mutation.isPending}
                onClick={() => answer(option.label, `choice:${option.label}`)}
              >
                <span className="inline-flex items-center gap-1.5 font-medium">
                  {option.label}
                  {isRecommended ? (
                    <span className="inline-flex items-center gap-1 text-xs font-normal opacity-90">
                      <Star className="size-3" aria-hidden="true" />
                      Recommended
                    </span>
                  ) : null}
                </span>
                {option.description === undefined ? null : (
                  <span className="text-xs font-normal opacity-80">{option.description}</span>
                )}
              </Button>
            </li>
          );
        })}
      </ul>

      <Field
        label="Add a note, or answer in your own words"
        error={error}
        help="Sent with the option you pick — or on its own."
      >
        {(field) => (
          <Textarea
            {...field}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={DECISION_ANSWER_MAX}
            rows={2}
          />
        )}
      </Field>

      <Button
        variant="secondary"
        className="w-fit"
        isLoading={pending === "note"}
        disabled={mutation.isPending || note.trim() === ""}
        onClick={() => answer(undefined, "note")}
      >
        Answer with this note only
      </Button>
    </section>
  );
};
