import {
  githubImportInputSchema,
  TASK_PROJECT_MAX,
  type GithubImportInputRaw,
} from "@estuary/contracts";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { isApiClientError } from "@/api/http";
import { useImportGithubIssueMutation } from "@/api/github";
import { useTaskFacetsQuery } from "@/api/tasks";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
} from "@/components/ui";
import { errorCopy, errorDescription } from "@/lib/errorMessages";
import { LabelInput } from "@/features/tasks/LabelInput";

/**
 * "Import GitHub issue" — the list header's entry point into
 * `POST /integrations/github/import`, shown only when the integration is on.
 *
 * A small form, not the full task form: an imported issue starts in
 * `backlog` or `needs_refinement` (never `todo` — an issue carries no
 * acceptance criteria) and everything else about it is filled in afterwards,
 * on the task the import creates.
 *
 * **A failed submit never clears the form** — same rule as `TaskForm`. There
 * is no `reset()` on any error path here.
 */

const IMPORT_STATUS_OPTIONS = [
  { value: "backlog", label: "Backlog" },
  { value: "needs_refinement", label: "Needs refinement" },
] as const;

type ImportStatus = (typeof IMPORT_STATUS_OPTIONS)[number]["value"];

type FormValues = {
  issue: string;
  project: string;
  status: ImportStatus;
  labels: string[];
};

const emptyValues = (): FormValues => ({
  issue: "",
  project: "",
  status: "backlog",
  labels: [],
});

export const GithubImportDialog = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const navigate = useNavigate();
  const facetsQuery = useTaskFacetsQuery();
  const mutation = useImportGithubIssueMutation();

  const [values, setValues] = useState<FormValues>(emptyValues);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | undefined>(undefined);

  const submit = () => {
    setFieldError(undefined);
    setFormError(undefined);

    const parsed = githubImportInputSchema.safeParse({
      issue: values.issue,
      project: values.project,
      status: values.status,
      labels: values.labels,
    } satisfies Omit<GithubImportInputRaw, "priority">);

    if (!parsed.success) {
      const issueMessage = parsed.error.issues.find((issue) => issue.path[0] === "issue")?.message;
      setFieldError(issueMessage ?? parsed.error.issues[0]?.message);
      return;
    }

    mutation.mutate(parsed.data, {
      onSuccess: (result) => {
        onOpenChange(false);
        setValues(emptyValues());
        toast.success(
          result.created
            ? `Imported as ${result.task.reference}`
            : `Already imported as ${result.task.reference}`,
        );
        void navigate(`/tasks/${result.task.id}`);
      },
      onError: (error) => {
        if (isApiClientError(error) && error.code === "VALIDATION_ERROR") {
          const issueMessage = error.validationDetails?.issue?.[0];
          setFieldError(issueMessage);
          if (issueMessage === undefined) {
            setFormError(Object.values(error.validationDetails ?? {}).flat()[0]);
          }
          return;
        }
        const copy = errorCopy(error);
        setFormError(`${copy.title}. ${errorDescription(error)}`);
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setFieldError(undefined);
          setFormError(undefined);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import a GitHub issue</DialogTitle>
        </DialogHeader>

        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className="flex flex-col gap-4"
        >
          {formError === undefined ? null : (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}

          <Field
            label="Issue"
            error={fieldError}
            required
            help='A GitHub issue URL, or "owner/repo#123".'
          >
            {(field) => (
              <Input
                {...field}
                value={values.issue}
                onChange={(event) => setValues((prev) => ({ ...prev, issue: event.target.value }))}
                placeholder="https://github.com/owner/repo/issues/42"
                autoFocus
              />
            )}
          </Field>

          <Field label="Project" help="Optional. Defaults to the repository's name.">
            {(field) => (
              <Input
                {...field}
                value={values.project}
                onChange={(event) =>
                  setValues((prev) => ({ ...prev, project: event.target.value }))
                }
                maxLength={TASK_PROJECT_MAX}
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </Field>

          <Field label="Starting status">
            {(field) => (
              <Select<ImportStatus>
                options={IMPORT_STATUS_OPTIONS}
                value={values.status}
                onValueChange={(status) => setValues((prev) => ({ ...prev, status }))}
                id={field.id}
              />
            )}
          </Field>

          <Field label="Labels" help="Optional.">
            {(field) => (
              <LabelInput
                id={field.id}
                value={values.labels}
                onChange={(labels) => setValues((prev) => ({ ...prev, labels }))}
                suggestions={facetsQuery.data?.labels}
              />
            )}
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" isLoading={mutation.isPending}>
              Import
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
