import { zodResolver } from "@hookform/resolvers/zod";
import {
  CREATABLE_TASK_STATUSES,
  DEFAULT_TASK_PRIORITY,
  TASK_LINKS_MAX,
  TASK_PROJECT_MAX,
  TASK_TITLE_MAX,
  createTaskInputSchema,
  parseReference,
  updateTaskInputSchema,
  type CreateTaskInput,
  type TaskPriority,
  type UpdateTaskInput,
} from "@helpdesk/contracts";
import { Plus, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  useFieldArray,
  useForm,
  useWatch,
  type FieldError,
  type FieldErrors,
  type Resolver,
  type UseFormReset,
} from "react-hook-form";
import { FormErrorSummary } from "@/components/FormErrorSummary";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import { cn } from "@/lib/cn";
import { TASK_STATUS_DESCRIPTIONS, TASK_STATUS_LABELS, priorityOptions } from "@/lib/formatting";
import { applyServerValidationErrors } from "@/lib/serverErrors";
import { LabelInput } from "@/features/tasks/LabelInput";

/**
 * The task form — **one component, two modes**, shared by
 * `docs/pages/Task_Create.md` and `docs/pages/Task_Edit.md`.
 *
 * Not two near-copies: the fields, the bounds, the layout, the sticky mobile
 * action bar, and the server-error mapping are identical, and the parts that
 * genuinely differ are three — the resolver, the initial-status field, and the
 * submit label.
 *
 * ## Status is not a form field — except the starting one
 *
 * Every status change after creation is a transition with its own payload
 * (`TransitionDialog`), so the edit form has no status control at all: the
 * detail page's picker is where status moves. Create mode offers the three
 * statuses a task may *start* in (`CREATABLE_TASK_STATUSES`), and `todo`
 * makes acceptance criteria required — the contract's `superRefine` says so,
 * and its message lands on the criteria field word for word.
 *
 * ## Validation is the contract schema, not a second set of rules
 *
 * `zodResolver(createTaskInputSchema | updateTaskInputSchema)` runs the
 * **same schema the server enforces**. That is why the client's message for a
 * 4-character title is character-for-character the server's, and why a bound
 * changed in `packages/contracts` cannot fall out of step with the form.
 *
 * Two controls hold something other than the payload's shape, and are
 * reshaped *before* the schema runs (`toPayloadShape`): the parent task is
 * typed as a task number ("TASK-000012") and becomes an id, and a link row
 * left entirely blank is an unused "Add link", not an invalid link.
 *
 * The values handed to `onSubmit` are the schema's *output*: titles trimmed,
 * the project lowercased, and — the one that matters — an empty `assignee` or
 * `project` already transformed to `null` rather than `""`. A task stored with
 * an empty-string assignee matches neither `assigneeIsNull=true` nor any name
 * filter and vanishes from every assignee view (`docs/features/Tasks.md`).
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

export type CreatableStatus = (typeof CREATABLE_TASK_STATUSES)[number];

/**
 * What the controls hold. Strings, because that is what an `<input>` and a
 * `<Select>` produce — the transform to `null` belongs to the schema, which is
 * the half the server also runs.
 */
export type TaskFormValues = {
  title: string;
  description: string;
  /**
   * **Create mode only, and absent — not empty — in edit mode.** Both schemas
   * are `.strict()`, and the update schema has no `status` at all, so a
   * `status` key in an edit form's values is a 422 from the client's own
   * resolver on a form that looks complete.
   */
  status?: CreatableStatus;
  priority: TaskPriority;
  project: string;
  assignee: string;
  acceptanceCriteria: string;
  links: { label: string; url: string }[];
  /** Sorted, lowercase, deduplicated — same shape the contract's schema produces. */
  labels: string[];
  /** A task number in any spelling `parseReference` accepts, or `""`. */
  parentId: string;
};

export type TaskFormMode = "create" | "edit";

/**
 * The fields this form actually renders, in visual order.
 *
 * Passed to `splitValidationErrors` so a `details` key that is **not** one of
 * these — `_`, or a field the API grew later — lands in the summary instead of
 * being handed to `setError` for a name that does not exist, which
 * react-hook-form drops silently. Link rows are added per render
 * (`knownFields`), because `links.3.url` is only a field while row 3 exists.
 */
export const TASK_FORM_FIELDS = [
  "title",
  "description",
  "status",
  "priority",
  "project",
  "assignee",
  "acceptanceCriteria",
  "links",
  "labels",
  "parentId",
] as const satisfies readonly (keyof TaskFormValues)[];

const knownFields = (linkCount: number): string[] => [
  ...TASK_FORM_FIELDS,
  ...Array.from({ length: linkCount }, (_, index) => [
    `links.${index}.label`,
    `links.${index}.url`,
  ]).flat(),
];

/** Create-mode defaults. A new task starts in the backlog, as the contract does. */
export const emptyTaskFormValues = (): TaskFormValues => ({
  title: "",
  description: "",
  status: "backlog",
  priority: DEFAULT_TASK_PRIORITY,
  project: "",
  assignee: "",
  acceptanceCriteria: "",
  links: [],
  labels: [],
  parentId: "",
});

export type TaskFormHelpers = {
  /**
   * Maps a failed submit onto the form: `VALIDATION_ERROR` details onto their
   * fields, everything else into the assertive summary. Safe to call with any
   * thrown value — a non-validation error adds nothing.
   */
  applyServerError: (error: unknown) => void;
  /** Puts one message on one field, for an error that is not a `VALIDATION_ERROR`. */
  setFieldError: (name: keyof TaskFormValues, message: string) => void;
  reset: UseFormReset<TaskFormValues>;
};

export type TaskFormProps = {
  mode: TaskFormMode;
  defaultValues: TaskFormValues;
  isSubmitting: boolean;
  submitLabel: string;
  onSubmit: (
    values: CreateTaskInput | UpdateTaskInput,
    helpers: TaskFormHelpers,
  ) => void | Promise<void>;
  onCancel: () => void;
  /** Called whenever the dirty flag flips, so the page can guard navigation. */
  onDirtyChange?: (isDirty: boolean) => void;
  /** Projects already in use (`facets.projects`), offered as suggestions. */
  projectSuggestions?: readonly string[];
  /** Labels already in use (`facets.labels`), offered as suggestions. */
  labelSuggestions?: readonly string[];
  /** Rendered above the fields — the edit page's version-conflict notice. */
  notice?: ReactNode;
};

/* ------------------------------------------------------------------ *
 * Form → schema input
 * ------------------------------------------------------------------ */

const PARENT_MESSAGE = "Enter a task number — 12, #12, or TASK-000012.";

type Reshaped = {
  input: Record<string, unknown>;
  /** Form row index for each link that survived, so errors can be put back. */
  linkRows: number[];
  errors: Record<string, FieldError>;
};

/**
 * The two reshapes the schema cannot do, because they are about what the
 * *controls* hold rather than about the payload. Exported for the tests.
 */
export const toPayloadShape = (values: TaskFormValues): Reshaped => {
  const errors: Record<string, FieldError> = {};

  const parentText = values.parentId.trim();
  const parentId = parentText === "" ? null : parseReference(parentText);
  if (parentText !== "" && parentId === null) {
    errors.parentId = { type: "validation", message: PARENT_MESSAGE };
  }

  const linkRows: number[] = [];
  const links: { label: string; url: string }[] = [];
  values.links.forEach((link, index) => {
    const label = link.label.trim();
    const url = link.url.trim();
    if (label === "" && url === "") return;
    // The contract's link label has no message of its own for "missing", and
    // "Too small: expected string to have >=1 characters" is not copy.
    if (label === "")
      errors[`links.${index}.label`] = { type: "validation", message: "Give the link a label" };
    linkRows.push(index);
    links.push({ label, url });
  });

  const { parentId: _parent, links: _links, ...rest } = values;
  return { input: { ...rest, links, parentId }, linkRows, errors };
};

/**
 * The contract's resolver, run over the reshaped values, with link-row error
 * indices mapped back from "position among non-blank rows" to "row on screen".
 */
const taskFormResolver = (
  mode: TaskFormMode,
): Resolver<TaskFormValues, unknown, CreateTaskInput | UpdateTaskInput> => {
  const contract = zodResolver(
    mode === "create" ? createTaskInputSchema : updateTaskInputSchema,
  ) as unknown as Resolver<Record<string, unknown>, unknown, CreateTaskInput | UpdateTaskInput>;

  return async (values, context, options) => {
    const { input, linkRows, errors: shapeErrors } = toPayloadShape(values);
    const result = await contract(input, context, options as never);

    const errors = { ...(result.errors as FieldErrors<TaskFormValues>) };
    if (Array.isArray(errors.links)) {
      const remapped: unknown[] = [];
      errors.links.forEach((rowError, position) => {
        const row = linkRows[position];
        if (row !== undefined && rowError !== undefined) remapped[row] = rowError;
      });
      errors.links = remapped as typeof errors.links;
    }

    for (const [path, error] of Object.entries(shapeErrors)) {
      if (path === "parentId") {
        errors.parentId = error;
      } else {
        const [, index, key] = path.split(".");
        const rows = (Array.isArray(errors.links) ? errors.links : []) as Record<
          string,
          FieldError
        >[];
        rows[Number(index)] = { ...(rows[Number(index)] ?? {}), [key!]: error };
        errors.links = rows as unknown as typeof errors.links;
      }
    }

    if (Object.keys(errors).length > 0) return { values: {}, errors };
    return result;
  };
};

const CREATABLE_OPTIONS = CREATABLE_TASK_STATUSES.map((value) => ({
  value,
  label: TASK_STATUS_LABELS[value],
}));

export const TaskForm = ({
  mode,
  defaultValues,
  isSubmitting,
  submitLabel,
  onSubmit,
  onCancel,
  onDirtyChange,
  projectSuggestions = [],
  labelSuggestions = [],
  notice,
}: TaskFormProps) => {
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const projectListId = useId();

  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    setValue,
    getValues,
    formState: { errors, isDirty },
  } = useForm<TaskFormValues, unknown, CreateTaskInput | UpdateTaskInput>({
    resolver: taskFormResolver(mode),
    // Validate on blur, then on every change once a field has errored. Checking
    // from the first keystroke scolds people while they are still typing the
    // value that would have been valid.
    mode: "onTouched",
    defaultValues,
  });

  const { fields: linkFields, append, remove } = useFieldArray({ control, name: "links" });

  const titleRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  /*
    Focus after a *server* rejection, and deliberately not through
    `setError`'s `shouldFocus`.

    `shouldFocus` calls `.focus()` on the field's registered input ref, and the
    selects have none — they are Radix triggers driven by `setValue`. A 422
    naming `priority` therefore moved focus nowhere at all
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
  const [status, priority, title, labels] = useWatch({
    control,
    name: ["status", "priority", "title", "labels"],
  });

  const criteriaRequired = mode === "create" && status === "todo";

  const submit = handleSubmit(
    (values) => {
      setFormErrors([]);
      return onSubmit(values, {
        applyServerError: (error) => {
          setFormErrors(
            applyServerValidationErrors<TaskFormValues>(
              error,
              knownFields(getValues("links").length) as never[],
              setError,
            ),
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
      // The browser's own bubble would fire before zod on `type="url"` and
      // show a message that is not the one the server would give.
      noValidate
      className="flex max-w-2xl flex-col gap-5 pb-24 md:pb-0"
    >
      {notice}

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
            maxLength={TASK_TITLE_MAX}
            placeholder="Short, imperative: “Add rate limiting to exports”"
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
            title.length >= TASK_TITLE_MAX ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {title.length} / {TASK_TITLE_MAX} characters
        </p>
      ) : null}

      <Field
        label="Description"
        error={errors.description?.message}
        required
        help="The context: what and why. Agents read this before they start."
      >
        {(field) => <Textarea {...field} {...register("description")} rows={6} />}
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        {mode === "create" ? (
          <Field
            label="Starting status"
            error={errors.status?.message}
            help={status === undefined ? undefined : TASK_STATUS_DESCRIPTIONS[status]}
          >
            {(field) => (
              <Select<CreatableStatus>
                options={CREATABLE_OPTIONS}
                value={status ?? "backlog"}
                /*
                  `shouldValidate`, on both selects, is what *clears* a message.
                  These controls are never `register()`ed, so nothing else
                  re-runs the resolver for them. Here it also re-checks the
                  criteria rule the moment `todo` is picked or unpicked.
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
            <Select<TaskPriority>
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

        <Field
          label="Project"
          error={errors.project?.message}
          help="Optional. A slug like “helpdesk” — pick one in use or start a new one."
        >
          {(field) => (
            <>
              <Input
                {...field}
                {...register("project")}
                list={projectListId}
                maxLength={TASK_PROJECT_MAX}
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
              />
              {/* Suggestions, not a constraint: a new project is created by naming it. */}
              <datalist id={projectListId}>
                {projectSuggestions.map((project) => (
                  <option key={project} value={project} />
                ))}
              </datalist>
            </>
          )}
        </Field>

        <Field
          label="Assignee"
          error={errors.assignee?.message}
          help="Optional. Leave blank to file it unassigned."
        >
          {(field) => <Input {...field} {...register("assignee")} />}
        </Field>
      </div>

      <Field
        label="Acceptance criteria"
        error={errors.acceptanceCriteria?.message}
        required={criteriaRequired}
        help={
          criteriaRequired
            ? "Required to start in To do: how anyone will know this is done."
            : "How anyone — human or agent — will know this is done. Needed before To do."
        }
      >
        {(field) => <Textarea {...field} {...register("acceptanceCriteria")} rows={4} />}
      </Field>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-medium text-foreground">
          Links <span className="font-normal text-muted-foreground">(PRs, branches, docs)</span>
        </legend>

        {linkFields.map((link, index) => {
          const rowErrors = errors.links?.[index];
          return (
            <div key={link.id} className="flex items-start gap-2">
              <div className="grid flex-1 gap-2 sm:grid-cols-[12rem_1fr]">
                <Field label={`Link ${index + 1} label`} error={rowErrors?.label?.message}>
                  {(field) => <Input {...field} {...register(`links.${index}.label`)} />}
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
          disabled={linkFields.length >= TASK_LINKS_MAX}
          onClick={() => append({ label: "", url: "" })}
        >
          <Plus aria-hidden="true" />
          Add link
        </Button>
      </fieldset>

      <Field
        label="Labels"
        error={
          Array.isArray(errors.labels)
            ? errors.labels.find((entry) => entry?.message !== undefined)?.message
            : errors.labels?.message
        }
        help="Optional. Narrows work inside a project — a workspace (“web”) or a kind (“bug”). Press Enter or comma to add."
      >
        {(field) => (
          <LabelInput
            id={field.id}
            value={labels ?? []}
            onChange={(next) =>
              setValue("labels", next, { shouldDirty: true, shouldValidate: true })
            }
            suggestions={labelSuggestions}
            aria-describedby={field["aria-describedby"]}
            aria-invalid={field["aria-invalid"]}
          />
        )}
      </Field>

      <Field
        label="Parent task"
        error={errors.parentId?.message}
        help="Optional. Makes this a subtask — 12, #12, or TASK-000012."
      >
        {(field) => (
          <Input {...field} {...register("parentId")} autoComplete="off" className="sm:w-60" />
        )}
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
