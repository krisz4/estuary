import { zodResolver } from "@hookform/resolvers/zod";
import {
  COMMENT_BODY_MAX,
  createCommentInputSchema,
  type Comment,
  type CommentKind,
  type CreateCommentInput,
} from "@helpdesk/contracts";
import { useState } from "react";
import { useForm, useWatch, type Resolver } from "react-hook-form";
import { toast } from "sonner";
import { useCreateCommentMutation } from "@/api/comments";
import { isApiClientError } from "@/api/http";
import { FormErrorSummary } from "@/components/FormErrorSummary";
import { Button, Field, Select, Textarea } from "@/components/ui";
import { ActorBadge } from "@/features/tasks/ActorBadge";
import { errorCopy } from "@/lib/errorMessages";
import { commentKindOptions } from "@/lib/formatting";
import { applyServerValidationErrors } from "@/lib/serverErrors";
import { openSessionDialog, useSessionActor } from "@/stores/session";

/**
 * Add a comment to a task.
 *
 * ## Who the author is
 *
 * There is no name field. The author is the actor this browser sends in
 * `X-Actor` — the name set under "You" in the header (`stores/session.ts`) —
 * so a comment is attributed exactly the way a status change is, and an agent
 * reading the thread sees the same `human:…` label in both places. The composer
 * says who you are posting as and links to the dialog to change it.
 *
 * `kind` defaults to `note`; `progress` and `qa_feedback` exist so a human can
 * write in the same register an agent does when that is what they are doing.
 *
 * ## Clearing
 *
 * The form clears **only on success**, and only after the mutation resolves —
 * never optimistically. `docs/features/Comments.md` states the rule bluntly:
 * *never clear a form you failed to submit*. A composer that resets on click
 * destroys a paragraph someone just wrote the moment the network is flaky, and
 * there is nowhere to recover it from.
 *
 * The reset therefore lives in `onSuccess`, not after `mutateAsync`, not in a
 * `finally`, and not in the submit handler.
 *
 * ## Why this one component opts out of the React Compiler
 *
 * `reset(values)` clears react-hook-form's `_fields` registry and then relies on
 * the next render **re-invoking `register("body")`** to re-attach the field's
 * ref, which is the moment RHF writes the new value into the uncontrolled
 * `<textarea>`. Nothing else writes that DOM node.
 *
 * Compiled, the `<Field label="Comment">` element is cached on
 * `[errors.body?.message, childrenFn]`, and `childrenFn` is cached on
 * `register` — a stable function. A successful submit changes neither: the
 * error was already `undefined`. So React gets back the identical element, bails
 * out of re-rendering `Field`, the render prop never runs, `register` is never
 * called again, and the textarea keeps the comment that was just posted. The
 * caching is correct — the render prop *is* pure in the compiler's terms; the
 * side effect it is being relied on for is invisible to it.
 *
 * `TaskForm` uses the same `register`-inside-a-render-prop shape and stays
 * compiled, because it never calls `reset()` — nothing there depends on
 * re-registration. **Adding a `reset(values)` to it means adding this directive
 * too**, and the failure is silent: stale text in a field, no error anywhere.
 */

const FIELDS = ["body", "kind"] as const;

type CommentFormValues = { body: string; kind: CommentKind };

export type CommentComposerProps = {
  taskId: number;
  /** Called with the created comment so the thread can move focus to it. */
  onCreated?: (comment: Comment) => void;
};

export const CommentComposer = ({ taskId, onCreated }: CommentComposerProps) => {
  "use no memo";

  const [formErrors, setFormErrors] = useState<string[]>([]);
  const mutation = useCreateCommentMutation(taskId);
  const actor = useSessionActor();

  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    setValue,
    formState: { errors },
  } = useForm<CommentFormValues, unknown, CreateCommentInput>({
    // `kind` has a schema default, so its zod *input* type is optional while
    // the form always holds one — the same input/output mismatch `TaskForm`
    // casts across.
    resolver: zodResolver(createCommentInputSchema) as unknown as Resolver<
      CommentFormValues,
      unknown,
      CreateCommentInput
    >,
    mode: "onTouched",
    defaultValues: { body: "", kind: "note" },
  });

  // `useWatch` rather than `watch()` — see the note in `TaskForm.tsx`.
  const [body, kind] = useWatch({ control, name: ["body", "kind"] });
  const isEmpty = body.trim() === "";

  const onSubmit = handleSubmit((values) => {
    setFormErrors([]);

    mutation.mutate(values, {
      onSuccess: (comment) => {
        reset({ body: "", kind: "note" });
        toast.success("Comment added");
        onCreated?.(comment);
      },
      onError: (error) => {
        setFormErrors(applyServerValidationErrors<CommentFormValues>(error, FIELDS, setError));

        // A 422 is already on screen — on the fields, or in the summary above
        // them. Every other code has nowhere else to appear, so it gets a toast.
        // The branch is on the *code*, not on whether `setError` happened: a 422
        // whose details name only unknown keys sets no field error and would
        // otherwise toast on top of a summary saying the same thing.
        if (!isApiClientError(error) || error.code !== "VALIDATION_ERROR") {
          const copy = errorCopy(error);
          toast.error(copy.title, { description: copy.description });
        }
      },
    });
  });

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3" noValidate>
      <h3 className="text-sm font-semibold text-foreground">Add a comment</h3>

      <FormErrorSummary messages={formErrors} />

      <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        Posting as <ActorBadge actor={actor} />
        <button
          type="button"
          onClick={openSessionDialog}
          className="rounded text-primary underline-offset-2 hover:underline"
        >
          Change
        </button>
      </p>

      <Field
        label="Comment"
        error={errors.body?.message}
        required
        help={`Plain text, up to ${COMMENT_BODY_MAX.toLocaleString()} characters.`}
      >
        {(field) => <Textarea {...field} {...register("body")} rows={4} />}
      </Field>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <Field label="Kind" error={errors.kind?.message} className="sm:w-48">
          {(field) => (
            <Select<CommentKind>
              options={commentKindOptions}
              value={kind}
              onValueChange={(next) => setValue("kind", next, { shouldValidate: true })}
              id={field.id}
              aria-describedby={field["aria-describedby"]}
              aria-invalid={field["aria-invalid"]}
            />
          )}
        </Field>
        <Button type="submit" disabled={isEmpty} isLoading={mutation.isPending}>
          Add comment
        </Button>
      </div>
    </form>
  );
};
