import { parseReference, type TaskRef } from "@helpdesk/contracts";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { isApiClientError } from "@/api/http";
import { useAddDependencyMutation, useRemoveDependencyMutation } from "@/api/tasks";
import { Button, Field, Input } from "@/components/ui";
import { errorCopy, errorDescription } from "@/lib/errorMessages";
import { StatusBadge } from "@/features/tasks/StatusBadge";

/**
 * A compact list of related tasks — parent, children, dependencies,
 * dependents — each a link with its status.
 */
export const TaskRefList = ({
  refs,
  currentProject,
  onRemove,
  removingId,
}: {
  refs: readonly TaskRef[];
  /**
   * The task this list is shown on. A ref's own `project` is only rendered
   * when it differs — dependencies cross repositories, and a ref sharing the
   * viewer's project would just repeat what is already on screen.
   */
  currentProject?: string | null;
  /** When given, each row gets a remove button. */
  onRemove?: (ref: TaskRef) => void;
  removingId?: number | null;
}) => (
  <ul className="flex flex-col gap-1.5">
    {refs.map((ref) => (
      <li key={ref.id} className="flex min-w-0 items-center gap-2 text-sm">
        <Link
          to={`/tasks/${ref.id}`}
          className="min-w-0 flex-1 truncate text-foreground hover:underline"
          title={ref.title}
        >
          <span className="mr-1.5 font-mono text-xs text-primary">{ref.reference}</span>
          {ref.title}
        </Link>
        {ref.project === null || ref.project === currentProject ? null : (
          <span
            className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
            title={`Project: ${ref.project}`}
          >
            {ref.project}
          </span>
        )}
        <StatusBadge status={ref.status} className="shrink-0" />
        {onRemove === undefined ? null : (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
            aria-label={`Remove dependency on ${ref.reference}`}
            isLoading={removingId === ref.id}
            onClick={() => onRemove(ref)}
          >
            <X aria-hidden="true" />
          </Button>
        )}
      </li>
    ))}
  </ul>
);

/**
 * "This task waits on…" — the dependencies, with add and remove.
 *
 * A dependency is added by task number in any spelling `parseReference`
 * accepts (`12`, `#12`, `TASK-000012`) — the same parser the search box and
 * the API use, so the three can never disagree about what "12" means.
 *
 * Removing one needs no confirm dialog: it deletes a link, not data, and
 * adding it back is one field away. (Removing the last open blocker of a
 * `blocked` task auto-unblocks it on the server; the task refetch shows that.)
 */
export const DependencyEditor = ({
  taskId,
  dependencies,
  currentProject,
}: {
  taskId: number;
  dependencies: readonly TaskRef[];
  currentProject?: string | null;
}) => {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const addMutation = useAddDependencyMutation(taskId);
  const removeMutation = useRemoveDependencyMutation(taskId);

  const add = () => {
    const dependsOnId = parseReference(value);
    if (dependsOnId === null) {
      setError("Enter a task number — 12, #12, or TASK-000012.");
      return;
    }
    if (dependsOnId === taskId) {
      setError("A task cannot depend on itself.");
      return;
    }
    setError(undefined);
    addMutation.mutate(dependsOnId, {
      onSuccess: () => {
        setValue("");
        toast.success("Dependency added");
      },
      onError: (addError) => {
        // An unknown id is a VALIDATION_ERROR on `dependsOnId`; a loop is
        // DEPENDENCY_CYCLE with the chain in `details.path`. Both belong on
        // the field, beside what the user typed.
        const fieldMessage = isApiClientError(addError)
          ? addError.validationDetails?.dependsOnId?.[0]
          : undefined;
        setError(fieldMessage ?? `${errorCopy(addError).title}. ${errorDescription(addError)}`);
      },
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {dependencies.length === 0 ? (
        <p className="text-sm text-muted-foreground">Doesn&apos;t wait on anything.</p>
      ) : (
        <TaskRefList
          refs={dependencies}
          currentProject={currentProject}
          removingId={removeMutation.isPending ? removeMutation.variables : null}
          onRemove={(ref) =>
            removeMutation.mutate(ref.id, {
              onSuccess: () => toast.success(`No longer waits on ${ref.reference}`),
              onError: (removeError) => {
                const copy = errorCopy(removeError);
                toast.error(copy.title, { description: errorDescription(removeError) });
              },
            })
          }
        />
      )}

      <form
        className="flex items-start gap-2"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <Field label="Add a dependency" error={error} className="flex-1">
          {(field) => (
            <Input
              {...field}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="TASK-000012"
              autoComplete="off"
            />
          )}
        </Field>
        <Button
          type="submit"
          variant="outline"
          size="icon"
          className="mt-[1.625rem]"
          aria-label="Add dependency"
          isLoading={addMutation.isPending}
          disabled={value.trim() === ""}
        >
          <Plus aria-hidden="true" />
        </Button>
      </form>
    </div>
  );
};
