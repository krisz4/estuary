import { zodResolver } from "@hookform/resolvers/zod";
import {
  createTicketInputSchema,
  DEFAULT_TICKET_PRIORITY,
  TICKET_TITLE_MAX,
  updateTicketInputSchema,
  type CreateTicketInput,
  type TicketCategory,
  type TicketPriority,
  type TicketStatus,
  type UpdateTicketInput,
} from "@helpdesk/contracts";
import { useEffect, useRef, useState } from "react";
import { useForm, useWatch, type Resolver, type UseFormReset } from "react-hook-form";
import { FormErrorSummary } from "@/components/FormErrorSummary";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import { cn } from "@/lib/cn";
import { categoryOptions, priorityOptions, statusOptions } from "@/lib/formatting";
import { applyServerValidationErrors } from "@/lib/serverErrors";

/**
 * The ticket form — **one component, two modes**, shared by
 * `docs/pages/Ticket_Create.md` and `docs/pages/Ticket_Edit.md`.
 *
 * Not two near-copies: the fields, the bounds, the layout, the sticky mobile
 * action bar, and the server-error mapping are identical, and the parts that
 * genuinely differ are three — the resolver, the status field, and the submit
 * label.
 *
 * ## Validation is the contract schema, not a second set of rules
 *
 * `zodResolver(createTicketInputSchema | updateTicketInputSchema)` runs the
 * **same schema the server enforces**. That is why the client's message for a
 * 4-character title is character-for-character the server's, and why a bound
 * changed in `packages/contracts` cannot fall out of step with the form.
 *
 * It also means the values handed to `onSubmit` are the schema's *output*, not
 * the raw input: titles trimmed, the email lowercased, and — the one that
 * matters — an empty `assignee` or `category` already transformed to `null`
 * rather than `""`. A ticket stored with an empty-string assignee matches
 * neither `assigneeIsNull=true` nor any name filter and vanishes from every
 * assignee view (`docs/features/Tickets.md` § Rules).
 *
 * ## A failed submit never clears the form
 *
 * There is no `reset()` on the error path anywhere in this file. The mutation
 * is fired by the parent, and on failure the parent only calls
 * `applyServerError`, which adds messages and touches no value.
 */

/* ------------------------------------------------------------------ *
 * Values
 * ------------------------------------------------------------------ */

/**
 * What the controls hold. Strings and enum strings, because that is what an
 * `<input>` and a `<Select>` produce — the transform to `null` belongs to the
 * schema, which is the half the server also runs.
 *
 * `category` uses `""` for "none" rather than `null`: `categoryInputSchema`
 * already maps an empty string to `null`, so the empty value the DOM gives is
 * exactly the value the shared schema is written to absorb.
 */
export type TicketFormValues = {
  title: string;
  description: string;
  /**
   * **Absent in create mode, not empty.** `createTicketInputSchema` is
   * `.strict()`, so a `status` key present in the parsed object is a 422 —
   * "Unrecognized key", from the client's own resolver, on a form that looks
   * complete. Every new ticket starts `open`; the field is only rendered, only
   * defaulted, and only registered when `mode === "edit"`.
   */
  status?: TicketStatus;
  priority: TicketPriority;
  category: TicketCategory | "";
  requesterName: string;
  requesterEmail: string;
  assignee: string;
};

export type TicketFormMode = "create" | "edit";

/**
 * The fields this form actually renders, in visual order.
 *
 * Passed to `splitValidationErrors` so a `details` key that is **not** one of
 * these — `_`, or a field the API grew later — lands in the summary instead of
 * being handed to `setError` for a name that does not exist, which
 * react-hook-form drops silently.
 *
 * `status` is included even in create mode. It cannot be rejected there (the
 * create schema has no such field, so a server that named it would be
 * misbehaving), and listing it unconditionally keeps one list rather than a
 * mode-dependent one that could be wrong in the mode nobody tested.
 */
export const TICKET_FORM_FIELDS = [
  "title",
  "description",
  "status",
  "priority",
  "category",
  "requesterName",
  "requesterEmail",
  "assignee",
] as const satisfies readonly (keyof TicketFormValues)[];

/** Create-mode defaults. No `status` key — see the type above. */
export const emptyTicketFormValues = (): TicketFormValues => ({
  title: "",
  description: "",
  priority: DEFAULT_TICKET_PRIORITY,
  category: "",
  requesterName: "",
  requesterEmail: "",
  assignee: "",
});

export type TicketFormHelpers = {
  /**
   * Maps a failed submit onto the form: `VALIDATION_ERROR` details onto their
   * fields, everything else into the assertive summary. Safe to call with any
   * thrown value — a non-validation error adds nothing and returns `false`.
   */
  applyServerError: (error: unknown) => void;
  /**
   * Puts one message on one field. Used for the 409 on `status`, which is not a
   * `VALIDATION_ERROR` and therefore carries no `details` map — but does have a
   * field it obviously belongs to.
   */
  setFieldError: (name: keyof TicketFormValues, message: string) => void;
  reset: UseFormReset<TicketFormValues>;
};

export type TicketFormProps = {
  mode: TicketFormMode;
  defaultValues: TicketFormValues;
  isSubmitting: boolean;
  submitLabel: string;
  onSubmit: (
    values: CreateTicketInput | UpdateTicketInput,
    helpers: TicketFormHelpers,
  ) => void | Promise<void>;
  onCancel: () => void;
  /** Called whenever the dirty flag flips, so the page can guard navigation. */
  onDirtyChange?: (isDirty: boolean) => void;
};

/**
 * `""` is not a legal Radix Select value (it is Radix's own "nothing selected"
 * sentinel — see `components/ui/Select.tsx`), so "no category" needs a token of
 * its own. It never leaves this file.
 */
const NO_CATEGORY = "__none__";

const CATEGORY_OPTIONS = [
  { value: NO_CATEGORY, label: "No category" },
  ...categoryOptions,
] as const satisfies readonly { value: string; label: string }[];

export const TicketForm = ({
  mode,
  defaultValues,
  isSubmitting,
  submitLabel,
  onSubmit,
  onCancel,
  onDirtyChange,
}: TicketFormProps) => {
  const [formErrors, setFormErrors] = useState<string[]>([]);

  const schema = mode === "create" ? createTicketInputSchema : updateTicketInputSchema;

  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    setValue,
    formState: { errors, isDirty },
  } = useForm<TicketFormValues, unknown, CreateTicketInput | UpdateTicketInput>({
    /*
      The cast is the one place the two type systems have to meet. zod's *input*
      type for these schemas is `unknown` on every preprocessed field
      (`emptyStringToNull` is a `z.preprocess`, which erases the input type by
      design), so the resolver's inferred `TFieldValues` is looser than
      `TicketFormValues` and the two do not unify. The runtime contract is
      exact — this is the schema the server runs — and `TicketFormValues` is the
      stricter of the two, so the cast narrows rather than widens.
    */
    resolver: zodResolver(schema) as unknown as Resolver<
      TicketFormValues,
      unknown,
      CreateTicketInput | UpdateTicketInput
    >,
    // Validate on blur, then on every change once a field has errored. Checking
    // from the first keystroke scolds people while they are still typing the
    // value that would have been valid.
    mode: "onTouched",
    defaultValues,
  });

  const titleRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  /*
    Focus after a *server* rejection, and deliberately not through
    `setError`'s `shouldFocus`.

    `shouldFocus` calls `.focus()` on the field's registered input ref, and the
    three selects have none — they are Radix triggers driven by `setValue`. A
    422 naming `category` therefore moved focus nowhere at all
    (`lib/serverErrors.ts` has the long version).

    So the form finds the target itself, after the errors have rendered: the
    first `aria-invalid="true"` node **in DOM order**, which is visual order and
    includes the selects, whose triggers are buttons and take focus fine. When
    every message went to the summary instead — an unknown `details` key, which
    is exactly the case that renders no invalid field — focus goes to the
    summary, so a keyboard user still lands on the reason.

    Driven by a counter rather than by `errors`, because two consecutive server
    errors can produce an identical `errors` object and must still move focus.
  */
  const formRef = useRef<HTMLFormElement | null>(null);
  const summaryRef = useRef<HTMLDivElement | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);

  useEffect(() => {
    if (focusRequest === 0) return;

    const invalid = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (invalid !== null && invalid !== undefined) {
      invalid.focus();
      return;
    }

    // Never steal focus for a rejection that put nothing on screen — a 500 with
    // no `details` leaves the user where they were.
    const summary = summaryRef.current;
    if (summary !== null && summary.textContent !== "") summary.focus();
  }, [focusRequest]);

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  /*
    `useWatch`, not `watch()`. Both subscribe to the same store, but `watch()`
    is a *function* returned by `useForm`, and the React Compiler bails out of
    memoizing any component that calls one — it cannot prove the return value is
    stable, so it skips the whole component. `useWatch` is a hook returning a
    value, which the compiler can reason about. Same behaviour, and the form
    stays compiled.
  */
  const [category, status, priority, title] = useWatch({
    control,
    name: ["category", "status", "priority", "title"],
  });

  const submit = handleSubmit(
    (values) => {
      setFormErrors([]);
      return onSubmit(values, {
        applyServerError: (error) => {
          setFormErrors(
            applyServerValidationErrors<TicketFormValues>(error, TICKET_FORM_FIELDS, setError),
          );
          setFocusRequest((request) => request + 1);
        },
        setFieldError: (name, message) => {
          setError(name, { type: "server", message }, { shouldFocus: false });
          setFocusRequest((request) => request + 1);
        },
        reset,
      });
    },
    () => {
      // Client-side rejection. The per-field messages are already rendered; the
      // summary exists so a screen-reader user is told a submit failed at all.
      setFormErrors([]);
    },
  );

  const { ref: titleFieldRef, ...titleRegister } = register("title");

  return (
    <form
      ref={formRef}
      onSubmit={(event) => void submit(event)}
      // The browser's own bubble would fire before zod on `type="email"` and
      // show a message that is not the one the server would give.
      noValidate
      className="flex max-w-2xl flex-col gap-5 pb-24 md:pb-0"
    >
      <FormErrorSummary ref={summaryRef} messages={formErrors} />

      <Field label="Title" error={errors.title?.message} required>
        {(field) => (
          <Input
            {...field}
            {...titleRegister}
            ref={(node) => {
              titleFieldRef(node);
              titleRef.current = node;
            }}
            maxLength={TICKET_TITLE_MAX}
            placeholder="Short summary of the problem"
          />
        )}
      </Field>

      {/* Only past 100 of 120 — a counter on every keystroke from character one
          is noise, and this one exists to warn about the ceiling. */}
      {title.length > 100 ? (
        <p
          aria-live="polite"
          className={cn(
            "-mt-4 text-xs",
            title.length >= TICKET_TITLE_MAX ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {title.length} / {TICKET_TITLE_MAX} characters
        </p>
      ) : null}

      <Field
        label="Description"
        error={errors.description?.message}
        required
        help="What happened, what you tried, and any error text."
      >
        {(field) => <Textarea {...field} {...register("description")} rows={6} />}
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        {mode === "edit" ? (
          <Field label="Status" error={errors.status?.message}>
            {(field) => (
              <Select<TicketStatus>
                options={statusOptions}
                value={status ?? "open"}
                /*
                  `shouldValidate`, on all three selects, is what *clears* a
                  message. These controls are never `register()`ed, so nothing
                  else re-runs the resolver for them: without it, the 409 put
                  on `status` by a rejected `closed → resolved` save stays
                  under the control after the user picks a legal status, and
                  only disappears on the next submit.
                */
                onValueChange={(next) =>
                  setValue("status", next, { shouldDirty: true, shouldValidate: true })
                }
                id={field.id}
                aria-describedby={field["aria-describedby"]}
                aria-invalid={field["aria-invalid"]}
              />
            )}
          </Field>
        ) : null}

        <Field label="Priority" error={errors.priority?.message}>
          {(field) => (
            <Select<TicketPriority>
              options={priorityOptions}
              value={priority}
              onValueChange={(next) =>
                setValue("priority", next, { shouldDirty: true, shouldValidate: true })
              }
              id={field.id}
              aria-describedby={field["aria-describedby"]}
              aria-invalid={field["aria-invalid"]}
            />
          )}
        </Field>

        <Field label="Category" error={errors.category?.message}>
          {(field) => (
            <Select
              options={CATEGORY_OPTIONS}
              value={category === "" ? NO_CATEGORY : category}
              onValueChange={(next) =>
                setValue("category", next === NO_CATEGORY ? "" : (next as TicketCategory), {
                  shouldDirty: true,
                  shouldValidate: true,
                })
              }
              id={field.id}
              aria-describedby={field["aria-describedby"]}
              aria-invalid={field["aria-invalid"]}
            />
          )}
        </Field>
      </div>

      <Field label="Requester name" error={errors.requesterName?.message} required>
        {(field) => (
          <Input
            {...field}
            {...register("requesterName")}
            autoComplete="name"
            placeholder="Dana Whitfield"
          />
        )}
      </Field>

      <Field
        label="Requester email"
        error={errors.requesterEmail?.message}
        required
        help="We'll use this to follow up — it is not an account."
      >
        {(field) => (
          <Input
            {...field}
            {...register("requesterEmail")}
            type="email"
            autoComplete="email"
            placeholder="dana.whitfield@example.com"
          />
        )}
      </Field>

      <Field
        label="Assignee"
        error={errors.assignee?.message}
        help="Optional. Leave blank to file it unassigned."
      >
        {(field) => <Input {...field} {...register("assignee")} placeholder="Marcus Feld" />}
      </Field>

      {/*
        Sticky to the bottom edge below `md`. On a 360px screen the form is
        taller than the viewport, so a submit button at the end of the document
        is several scrolls away from the field the user is finishing.
      */}
      <div
        className={cn(
          "fixed inset-x-0 bottom-0 z-30 flex gap-2 border-t border-border bg-background px-4 py-3",
          "md:static md:justify-end md:border-0 md:bg-transparent md:px-0 md:py-0",
        )}
      >
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isSubmitting}
          className="flex-1 md:flex-none"
        >
          Cancel
        </Button>
        <Button type="submit" isLoading={isSubmitting} className="flex-1 md:flex-none">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
};
