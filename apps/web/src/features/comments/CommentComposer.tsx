import { zodResolver } from "@hookform/resolvers/zod";
import {
  COMMENT_BODY_MAX,
  createCommentInputSchema,
  type Comment,
  type CreateCommentInput,
} from "@helpdesk/contracts";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { useCreateCommentMutation } from "@/api/comments";
import { isApiClientError } from "@/api/http";
import { FormErrorSummary } from "@/components/FormErrorSummary";
import { Button, Field, Input, Textarea } from "@/components/ui";
import { errorCopy } from "@/lib/errorMessages";
import { applyServerValidationErrors } from "@/lib/serverErrors";

/**
 * Add a comment to a ticket.
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
 */

const FIELDS = ["authorName", "body"] as const;

export type CommentComposerProps = {
  ticketId: number;
  /** Called with the created comment so the thread can move focus to it. */
  onCreated?: (comment: Comment) => void;
};

export const CommentComposer = ({ ticketId, onCreated }: CommentComposerProps) => {
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const mutation = useCreateCommentMutation(ticketId);

  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    formState: { errors },
  } = useForm<CreateCommentInput>({
    resolver: zodResolver(createCommentInputSchema),
    mode: "onTouched",
    defaultValues: { authorName: "", body: "" },
  });

  // `useWatch` rather than `watch()` — see the note in `TicketForm.tsx`.
  const body = useWatch({ control, name: "body" });
  const isEmpty = body.trim() === "";

  const onSubmit = handleSubmit((values) => {
    setFormErrors([]);

    mutation.mutate(values, {
      onSuccess: (comment) => {
        reset({ authorName: values.authorName, body: "" });
        toast.success("Comment added");
        onCreated?.(comment);
      },
      onError: (error) => {
        setFormErrors(applyServerValidationErrors<CreateCommentInput>(error, FIELDS, setError));

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

      <Field label="Your name" error={errors.authorName?.message} required>
        {(field) => (
          <Input
            {...field}
            {...register("authorName")}
            autoComplete="name"
            placeholder="Marcus Feld"
          />
        )}
      </Field>

      <Field
        label="Comment"
        error={errors.body?.message}
        required
        help={`Plain text, up to ${COMMENT_BODY_MAX.toLocaleString()} characters.`}
      >
        {(field) => <Textarea {...field} {...register("body")} rows={4} />}
      </Field>

      <div className="flex justify-end">
        <Button type="submit" disabled={isEmpty} isLoading={mutation.isPending}>
          Add comment
        </Button>
      </div>
    </form>
  );
};
