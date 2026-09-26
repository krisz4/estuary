import { toNestErrors } from "@hookform/resolvers";
import {
  DECISION_OPTIONS_MAX,
  DECISION_OPTIONS_MIN,
  TASK_LINKS_MAX,
  parseReference,
  transitionInputSchema,
  type TaskStatus,
  type TaskSummary,
  type TransitionInput,
} from "@helpdesk/contracts";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import {
  useFieldArray,
  useForm,
  useWatch,
  type Control,
  type FieldError,
  type FieldErrors,
  type Resolver,
  type ResolverOptions,
  type UseFormRegister,
  type UseFormSetValue,
} from "react-hook-form";
import { isApiClientError } from "@/api/http";
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
  Input,
  Textarea,
} from "@/components/ui";
import { errorCopy, errorDescription, splitValidationErrors } from "@/lib/errorMessages";
import { TASK_STATUS_DESCRIPTIONS, TASK_STATUS_LABELS } from "@/lib/formatting";
import { applyServerValidationErrors } from "@/lib/serverErrors";

/**
 * The form a status change needs, for whichever status it is moving to.
 *
 * There is no from→to table (`lib/statusTransition.ts`); what a target
 * *requires* is the shape of its transition payload, so this dialog renders
 * exactly that shape and nothing else:
 *
 * | Target | Fields |
 * | ------ | ------ |
 * | needs refinement | what is unclear (required) |
 * | to do | acceptance criteria (required when the task has none) |
 * | blocked | a reason and/or the tasks it waits on — at least one |
 * | needs decision | question, context, 2–6 options, an optional recommendation |
 * | needs action | instructions (required) |
 * | needs QA | summary (required), links |
 * | deferred | why it is parked (required) |
 * | backlog, in progress, done | an optional note |
 *
 * ## Validation is the contract's
 *
 * The form's values are shaped like the payload — `decision.options.0.label`,
 * `links.1.url` — so the resolver can run `transitionInputSchema`, the schema
 * the server runs, over the reshaped values, and **an issue path is a field
 * name on both sides**. A server `VALIDATION_ERROR` for
 * `decision.recommendedOption` lands on the same control a client-side one
 * would.
 *
 * A hand-written resolver around `safeParse` rather than `zodResolver`: the
 * payload is a *reshaping* of the form, and expressing that as a zod transform
 * would need `zod` as a direct dependency of this app for one call.
 *
 * The one thing added on top is a friendly message for a *blank required*
 * field: the contract's status-note schema carries no custom message, and
 * "Too small: expected string to have >=1 characters" is not copy. Those checks
 * run first; everything else — lengths, URLs, unique option labels, a
 * recommendation that is not an option — is the contract's own wording.
 *
 * ## A failed submit never closes or clears it
 *
 * `onSubmit` is the caller's (the map and the detail page each run the
 * mutation their own way). A rejection comes back here: field errors go on
 * their fields, anything else into the summary, and every value stays typed.
 */

/* ------------------------------------------------------------------ *
 * Values
 * ------------------------------------------------------------------ */

/**
 * Every field any target could need, as the strings the controls hold.
 * `decision.recommendedOption` holds the *index* of the recommended row (or
 * `""`), not its label — a label edited after it was picked must not orphan
 * the recommendation. The resolver turns it into the label.
 */
export type TransitionFormValues = {
  to: TaskStatus;
  reason: string;
  acceptanceCriteria: string;
  blockedBy: string;
  decision: {
    question: string;
    context: string;
    options: { label: string; description: string }[];
    recommendedOption: string;
  };
  instructions: string;
  summary: string;
  links: { label: string; url: string }[];
};

type TransitionTask = Pick<TaskSummary, "id" | "reference" | "title" | "acceptanceCriteria">;

const emptyValues = (to: TaskStatus): TransitionFormValues => ({
  to,
  reason: "",
  acceptanceCriteria: "",
  blockedBy: "",
  decision: {
    question: "",
    context: "",
    options: Array.from({ length: DECISION_OPTIONS_MIN }, () => ({ label: "", description: "" })),
    recommendedOption: "",
  },
  instructions: "",
  summary: "",
  links: [],
});

/** `""` / whitespace → absent. The contract's notes are `min(1)` when present. */
const optional = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

/* ------------------------------------------------------------------ *
 * Form → payload
 * ------------------------------------------------------------------ */

const REQUIRED_COPY = {
  needs_refinement: "Say what is unclear or missing",
  needs_user_action: "Say exactly what needs doing, and where",
  needs_qa: "Summarise what changed and how to check it",
  deferred: "Say why it is being parked",
  // Word for word the contract's create-time superRefine, so the two screens
  // that can make a task `todo` say the same thing.
  todo: "Acceptance criteria are required before a task can be todo",
} as const;

type Issue = { path: string; message: string };

/**
 * Builds the payload for `values.to`, reporting blank required fields with UI
 * copy. Everything it returns is then validated by `transitionInputSchema`.
 */
const toPayload = (
  values: TransitionFormValues,
  taskHasCriteria: boolean,
): { payload: Record<string, unknown>; issues: Issue[] } => {
  const issues: Issue[] = [];

  const required = (path: string, value: string, message: string): string => {
    const trimmed = value.trim();
    if (trimmed === "") issues.push({ path, message });
    return trimmed;
  };

  const payload = ((): Record<string, unknown> => {
    switch (values.to) {
      case "needs_refinement":
        return {
          to: values.to,
          reason: required("reason", values.reason, REQUIRED_COPY.needs_refinement),
        };

      case "todo": {
        const criteria = taskHasCriteria
          ? optional(values.acceptanceCriteria)
          : required("acceptanceCriteria", values.acceptanceCriteria, REQUIRED_COPY.todo);
        return {
          to: values.to,
          ...(criteria === undefined ? {} : { acceptanceCriteria: criteria }),
        };
      }

      case "blocked": {
        const ids: number[] = [];
        for (const token of values.blockedBy.split(/[\s,]+/).filter((entry) => entry !== "")) {
          const id = parseReference(token);
          if (id === null) {
            issues.push({
              path: "blockedBy",
              message: `“${token}” is not a task number. Use 12, #12, or TASK-000012.`,
            });
          } else if (!ids.includes(id)) {
            ids.push(id);
          }
        }
        const reason = optional(values.reason);
        return {
          to: values.to,
          ...(reason === undefined ? {} : { reason }),
          ...(ids.length === 0 ? {} : { blockedBy: ids }),
        };
      }

      case "needs_user_decision": {
        const { question, context, options, recommendedOption } = values.decision;
        const recommended =
          recommendedOption === "" ? undefined : options[Number(recommendedOption)]?.label.trim();
        const trimmedContext = optional(context);
        return {
          to: values.to,
          decision: {
            question: question.trim(),
            options: options.map((option) => {
              const description = optional(option.description);
              return {
                label: option.label.trim(),
                ...(description === undefined ? {} : { description }),
              };
            }),
            ...(recommended === undefined || recommended === ""
              ? {}
              : { recommendedOption: recommended }),
            ...(trimmedContext === undefined ? {} : { context: trimmedContext }),
          },
        };
      }

      case "needs_user_action":
        return {
          to: values.to,
          instructions: required(
            "instructions",
            values.instructions,
            REQUIRED_COPY.needs_user_action,
          ),
        };

      case "needs_qa": {
        const summary = required("summary", values.summary, REQUIRED_COPY.needs_qa);
        const links = values.links
          // A row left completely blank is an unused "Add link", not an error.
          .map((link, index) => ({ label: link.label.trim(), url: link.url.trim(), index }))
          .filter((link) => link.label !== "" || link.url !== "");
        for (const link of links) {
          if (link.label === "") {
            issues.push({ path: `links.${link.index}.label`, message: "Give the link a label" });
          }
          if (link.url === "") {
            issues.push({ path: `links.${link.index}.url`, message: "Enter a valid URL" });
          }
        }
        return {
          to: values.to,
          summary,
          ...(links.length === 0 ? {} : { links: links.map(({ label, url }) => ({ label, url })) }),
        };
      }

      case "deferred":
        return { to: values.to, reason: required("reason", values.reason, REQUIRED_COPY.deferred) };

      case "backlog":
      case "in_progress":
      case "done": {
        const reason = optional(values.reason);
        return { to: values.to, ...(reason === undefined ? {} : { reason }) };
      }
    }
  })();

  return { payload, issues };
};

/**
 * Form values → a valid `TransitionInput`, or the issues keyed by field path.
 *
 * The contract runs only when the reshape found nothing blank, so a blank
 * required field reports the UI copy above and nothing else — never that *and*
 * the contract's generic minimum-length message for the same field.
 *
 * Exported for the tests, which assert the mapping without a DOM.
 */
export const validateTransition = (
  values: TransitionFormValues,
  taskHasCriteria: boolean,
): { success: true; data: TransitionInput } | { success: false; issues: Issue[] } => {
  const { payload, issues } = toPayload(values, taskHasCriteria);
  if (issues.length > 0) return { success: false, issues };

  const result = transitionInputSchema.safeParse(payload);
  if (result.success) return { success: true, data: result.data };

  return {
    success: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.length === 0 ? "root" : issue.path.join("."),
      message: issue.message,
    })),
  };
};

const transitionResolver =
  (taskHasCriteria: boolean): Resolver<TransitionFormValues, unknown, TransitionInput> =>
  (values, _context, options) => {
    const result = validateTransition(values, taskHasCriteria);
    if (result.success) return { values: result.data, errors: {} };

    // First message per field, in the order the schema reported them.
    const flat: Record<string, FieldError> = {};
    for (const issue of result.issues) {
      flat[issue.path] ??= { type: "validation", message: issue.message };
    }
    return { values: {}, errors: toNestErrors(flat, options) };
  };

/** The payload field names a server `VALIDATION_ERROR` may name, for the current rows. */
const knownFields = (values: TransitionFormValues): string[] => [
  "reason",
  "acceptanceCriteria",
  "blockedBy",
  "decision",
  "decision.question",
  "decision.context",
  "decision.options",
  "decision.recommendedOption",
  ...values.decision.options.flatMap((_, index) => [
    `decision.options.${index}.label`,
    `decision.options.${index}.description`,
  ]),
  "instructions",
  "summary",
  "links",
  ...values.links.flatMap((_, index) => [`links.${index}.label`, `links.${index}.url`]),
];

/**
 * A claim held by an agent, a 403 for an agent completing work, a network
 * failure: nothing to put on a field, so the reason goes in the summary —
 * inside the dialog, beside the values the user may want to retry with.
 */
const failureLine = (error: unknown): string =>
  `${errorCopy(error).title}. ${errorDescription(error)}`;

const splitInitialError = (
  error: unknown,
  target: TaskStatus,
): { fieldErrors: FieldErrors<TransitionFormValues> | undefined; formErrors: string[] } => {
  if (error === undefined || error === null) return { fieldErrors: undefined, formErrors: [] };
  if (!isApiClientError(error) || error.code !== "VALIDATION_ERROR") {
    return { fieldErrors: undefined, formErrors: [failureLine(error)] };
  }

  const { fieldErrors, formErrors } = splitValidationErrors(
    error,
    knownFields(emptyValues(target)),
  );
  const flat: Record<string, FieldError> = {};
  for (const [path, messages] of Object.entries(fieldErrors)) {
    if (messages[0] !== undefined) flat[path] = { type: "server", message: messages[0] };
  }
  return {
    // No registered fields exist yet, which is exactly the case `toNestErrors`
    // handles by nesting on the dotted path alone.
    fieldErrors: toNestErrors(flat, {
      fields: {},
      shouldUseNativeValidation: false,
    } as ResolverOptions<TransitionFormValues>),
    formErrors,
  };
};

/* ------------------------------------------------------------------ *
 * The dialog
 * ------------------------------------------------------------------ */

export type TransitionDialogProps = {
  task: TransitionTask;
  target: TaskStatus;
  /** Performs the transition. A rejection is rendered here; a resolve is the caller's to close. */
  onSubmit: (input: TransitionInput) => Promise<unknown>;
  /** Dismissed without moving. The caller reverts its optimistic state on this. */
  onCancel: () => void;
  /**
   * A rejection from before the dialog opened — a direct move that came back
   * `VALIDATION_ERROR` — applied to the fields on mount.
   */
  initialError?: unknown;
};

/**
 * Mount it when a move needs input and unmount it when done (`key` it on the
 * task and target), so every opening starts from a clean form.
 */
export const TransitionDialog = ({
  task,
  target,
  onSubmit,
  onCancel,
  initialError,
}: TransitionDialogProps) => {
  /*
    The rejection that opened the dialog, split once at mount into what goes
    on a field and what goes in the summary. Handed to `useForm` as initial
    state — `errors` for the fields, `useState` for the summary — rather than
    applied in an effect, which would render the form clean and then again
    with the messages.
  */
  const [initial] = useState(() => splitInitialError(initialError, target));
  const [formErrors, setFormErrors] = useState<string[]>(initial.formErrors);

  /*
    Whether `todo` needs criteria typed here. The task row says whether it has
    some — but if the server just refused a move for lacking them, the row is
    stale (an agent cleared them), and the server is the one to believe.
    Without this the client would consider the field optional and clear the
    server's message on the first blur.
  */
  const taskHasCriteria =
    task.acceptanceCriteria !== null && initial.fieldErrors?.acceptanceCriteria === undefined;

  const {
    register,
    handleSubmit,
    control,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<TransitionFormValues, unknown, TransitionInput>({
    resolver: transitionResolver(taskHasCriteria),
    mode: "onTouched",
    defaultValues: emptyValues(target),
    errors: initial.fieldErrors,
  });

  /** Server rejection → fields it names, and everything else to the summary. */
  const applyError = (error: unknown) => {
    const unplaced = applyServerValidationErrors<TransitionFormValues>(
      error,
      knownFields(getValues()) as never[],
      setError,
    );
    setFormErrors(
      isApiClientError(error) && error.code === "VALIDATION_ERROR"
        ? unplaced
        : [failureLine(error)],
    );
  };

  const submit = handleSubmit(async (input) => {
    setFormErrors([]);
    try {
      await onSubmit(input);
    } catch (error) {
      applyError(error);
    }
  });

  const label = TASK_STATUS_LABELS[target];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // A request in flight cannot be cancelled; dismissing now would leave
        // the user unsure whether the move happened. Same rule as ConfirmDialog.
        if (!open && !isSubmitting) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Move {task.reference} to {label}
          </DialogTitle>
          <DialogDescription>{TASK_STATUS_DESCRIPTIONS[target]}</DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(event) => void submit(event)}
          noValidate
          className="flex flex-col gap-4"
          aria-label={`Move ${task.reference} to ${label}`}
        >
          <FormErrorSummary
            messages={
              errors.root?.message === undefined ? formErrors : [...formErrors, errors.root.message]
            }
          />

          <TargetFields
            target={target}
            taskHasCriteria={taskHasCriteria}
            register={register}
            control={control}
            setValue={setValue}
            errors={errors}
          />

          <DialogFooter>
            <Button variant="outline" onClick={onCancel} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" isLoading={isSubmitting}>
              {target === "needs_user_decision" ? "Ask for a decision" : `Move to ${label}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/* ------------------------------------------------------------------ *
 * Per-target fields
 * ------------------------------------------------------------------ */

type FieldsProps = {
  target: TaskStatus;
  taskHasCriteria: boolean;
  register: UseFormRegister<TransitionFormValues>;
  control: Control<TransitionFormValues, unknown, TransitionInput>;
  setValue: UseFormSetValue<TransitionFormValues>;
  errors: FieldErrors<TransitionFormValues>;
};

const TargetFields = ({
  target,
  taskHasCriteria,
  register,
  control,
  setValue,
  errors,
}: FieldsProps) => {
  switch (target) {
    case "needs_refinement":
      return (
        <Field label="What is unclear or missing?" error={errors.reason?.message} required>
          {(field) => <Textarea {...field} {...register("reason")} rows={4} autoFocus />}
        </Field>
      );

    case "todo":
      return (
        <Field
          label="Acceptance criteria"
          error={errors.acceptanceCriteria?.message}
          required={!taskHasCriteria}
          help="How anyone — human or agent — will know this is done."
        >
          {(field) => (
            <Textarea {...field} {...register("acceptanceCriteria")} rows={5} autoFocus />
          )}
        </Field>
      );

    case "blocked":
      return (
        <>
          <Field
            label="Why is it blocked?"
            error={errors.reason?.message}
            help="Give a reason, name the tasks it waits on, or both."
          >
            {(field) => <Textarea {...field} {...register("reason")} rows={3} autoFocus />}
          </Field>
          <Field
            label="Waits on tasks"
            error={errors.blockedBy?.message}
            help="Task numbers, separated by commas — 12, TASK-000013. Added as dependencies."
          >
            {(field) => <Input {...field} {...register("blockedBy")} inputMode="text" />}
          </Field>
        </>
      );

    case "needs_user_decision":
      return (
        <DecisionFields register={register} control={control} setValue={setValue} errors={errors} />
      );

    case "needs_user_action":
      return (
        <Field
          label="What does the human need to do?"
          error={errors.instructions?.message}
          required
          help="Exactly what, and where. This is what the inbox shows."
        >
          {(field) => <Textarea {...field} {...register("instructions")} rows={5} autoFocus />}
        </Field>
      );

    case "needs_qa":
      return (
        <>
          <Field
            label="Summary"
            error={errors.summary?.message}
            required
            help="What changed, and how to verify it."
          >
            {(field) => <Textarea {...field} {...register("summary")} rows={5} autoFocus />}
          </Field>
          <LinkRows register={register} control={control} errors={errors} />
        </>
      );

    case "deferred":
      return (
        <Field label="Why is it parked?" error={errors.reason?.message} required>
          {(field) => <Textarea {...field} {...register("reason")} rows={3} autoFocus />}
        </Field>
      );

    case "backlog":
    case "in_progress":
    case "done":
      return (
        <Field label="Note" error={errors.reason?.message} help="Optional.">
          {(field) => <Textarea {...field} {...register("reason")} rows={3} autoFocus />}
        </Field>
      );
  }
};

/** Question, context, and the 2–6 option rows with a single recommendation. */
const DecisionFields = ({
  register,
  control,
  setValue,
  errors,
}: Omit<FieldsProps, "target" | "taskHasCriteria">) => {
  const { fields, append, remove } = useFieldArray({ control, name: "decision.options" });
  const recommended = useWatch({ control, name: "decision.recommendedOption" });

  const decisionErrors = errors.decision;
  // `decision.options` itself (too few, duplicate labels) — not any one row.
  const optionsError = decisionErrors?.options?.message ?? decisionErrors?.options?.root?.message;

  const removeOption = (index: number) => {
    remove(index);
    // Keep the recommendation on the row it was on, not on whatever slides up.
    if (recommended === "") return;
    const current = Number(recommended);
    if (current === index) setValue("decision.recommendedOption", "");
    else if (current > index) setValue("decision.recommendedOption", String(current - 1));
  };

  return (
    <>
      <Field label="Question" error={decisionErrors?.question?.message} required>
        {(field) => <Textarea {...field} {...register("decision.question")} rows={2} autoFocus />}
      </Field>

      <Field
        label="Context"
        error={decisionErrors?.context?.message}
        help="Optional. What the person answering needs to know."
      >
        {(field) => <Textarea {...field} {...register("decision.context")} rows={3} />}
      </Field>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-medium text-foreground">
          Options{" "}
          <span className="font-normal text-muted-foreground">
            ({DECISION_OPTIONS_MIN}–{DECISION_OPTIONS_MAX})
          </span>
        </legend>

        {fields.map((option, index) => {
          const rowErrors = decisionErrors?.options?.[index];
          return (
            <div
              key={option.id}
              className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3"
            >
              <div className="flex items-start gap-2">
                <Field
                  label={`Option ${index + 1}`}
                  error={rowErrors?.label?.message}
                  required
                  className="flex-1"
                >
                  {(field) => <Input {...field} {...register(`decision.options.${index}.label`)} />}
                </Field>
                <Button
                  variant="ghost"
                  size="icon"
                  className="mt-6"
                  aria-label={`Remove option ${index + 1}`}
                  disabled={fields.length <= DECISION_OPTIONS_MIN}
                  onClick={() => removeOption(index)}
                >
                  <X aria-hidden="true" />
                </Button>
              </div>
              <Field
                label={`Option ${index + 1} description`}
                error={rowErrors?.description?.message}
              >
                {(field) => (
                  <Input
                    {...field}
                    {...register(`decision.options.${index}.description`)}
                    placeholder="Optional — trade-offs, cost, risk"
                  />
                )}
              </Field>
              <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-foreground">
                <input
                  type="radio"
                  name="recommended-option"
                  className="size-4 accent-primary"
                  checked={recommended === String(index)}
                  onChange={() => setValue("decision.recommendedOption", String(index))}
                />
                Recommend this option
              </label>
            </div>
          );
        })}

        <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <input
            type="radio"
            name="recommended-option"
            className="size-4 accent-primary"
            checked={recommended === ""}
            onChange={() => setValue("decision.recommendedOption", "")}
          />
          No recommendation
        </label>

        {decisionErrors?.recommendedOption?.message === undefined ? null : (
          <p className="text-xs text-destructive" role="alert">
            {decisionErrors.recommendedOption.message}
          </p>
        )}
        {optionsError === undefined ? null : (
          <p className="text-xs text-destructive" role="alert">
            {optionsError}
          </p>
        )}

        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={fields.length >= DECISION_OPTIONS_MAX}
          onClick={() => append({ label: "", description: "" })}
        >
          <Plus aria-hidden="true" />
          Add option
        </Button>
      </fieldset>
    </>
  );
};

/** The PR / branch / commit links a `needs_qa` hand-off appends to the task. */
const LinkRows = ({
  register,
  control,
  errors,
}: Pick<FieldsProps, "register" | "control" | "errors">) => {
  const { fields, append, remove } = useFieldArray({ control, name: "links" });

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-sm font-medium text-foreground">
        Links <span className="font-normal text-muted-foreground">(PR, branch, commit)</span>
      </legend>

      {fields.map((link, index) => {
        const rowErrors = errors.links?.[index];
        return (
          <div key={link.id} className="flex items-start gap-2">
            <div className="grid flex-1 gap-2 sm:grid-cols-[10rem_1fr]">
              <Field label={`Link ${index + 1} label`} error={rowErrors?.label?.message}>
                {(field) => (
                  <Input {...field} {...register(`links.${index}.label`)} placeholder="PR #12" />
                )}
              </Field>
              <Field label={`Link ${index + 1} URL`} error={rowErrors?.url?.message}>
                {(field) => (
                  <Input
                    {...field}
                    {...register(`links.${index}.url`)}
                    type="url"
                    inputMode="url"
                    placeholder="https://"
                  />
                )}
              </Field>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="mt-6"
              aria-label={`Remove link ${index + 1}`}
              onClick={() => remove(index)}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        );
      })}

      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        disabled={fields.length >= TASK_LINKS_MAX}
        onClick={() => append({ label: "", url: "" })}
      >
        <Plus aria-hidden="true" />
        Add link
      </Button>
    </fieldset>
  );
};
