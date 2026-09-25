import {
  hasAtLeastOneField,
  taskIdParamSchema,
  type Task,
  type UpdateTaskInput,
} from "@helpdesk/contracts";
import { RefreshCw } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { isApiClientError } from "@/api/http";
import { useTaskFacetsQuery, useTaskQuery, useUpdateTaskMutation } from "@/api/tasks";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorPanel } from "@/components/ErrorPanel";
import { NotFoundState } from "@/components/NotFoundState";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui";
import { TaskForm, type TaskFormHelpers, type TaskFormValues } from "@/features/tasks/TaskForm";
import { ActorBadge } from "@/features/tasks/ActorBadge";
import { StatusBadge } from "@/features/tasks/StatusBadge";
import { formatAbsolute, formatDate } from "@/lib/formatting";
import { errorCopy } from "@/lib/errorMessages";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { useUnsavedChangesGuard } from "@/lib/useUnsavedChangesGuard";
import { DetailField } from "@/pages/task-detail/DetailField";
import { FormSkeleton } from "@/pages/task-edit/FormSkeleton";

/**
 * `/tasks/:taskId/edit` — spec: `docs/pages/Task_Edit.md`. Task 4.5.
 *
 * The same `TaskForm` as create, in `mode="edit"`. What this page adds is the
 * **diff**: only fields whose value actually changed are PATCHed.
 *
 * That is not an optimisation. `PATCH` is partial by contract
 * (`docs/features/Tasks.md`), so sending the whole object would write every
 * field on every save — and would clobber a concurrent change to a field this
 * user never touched with the value that was on screen when the page loaded.
 *
 * ## Concurrent writers are the normal case here
 *
 * Agents edit tasks all day. The save sends `expectedVersion` — the version the
 * form was loaded at — and a write that landed in between comes back as
 * `VERSION_CONFLICT` rather than being silently overwritten. The page then says
 * so, keeps everything the user typed, and offers to reload the task (which
 * re-initialises the form from the server's copy — the one action here that
 * replaces typed values, and the notice says it will).
 *
 * Status is not on this form: it changes through the detail page's picker, as a
 * transition.
 */
export const TaskEditPage = () => {
  const { taskId: raw } = useParams();
  const parsed = taskIdParamSchema.safeParse(raw);

  if (!parsed.success) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Edit task" />
        <NotFoundState description="That address does not contain a valid task number." />
      </div>
    );
  }

  return <TaskEditView taskId={parsed.data} />;
};

const TaskEditView = ({ taskId }: { taskId: number }) => {
  const navigate = useNavigate();
  const location = useLocation();

  const [isDirty, setDirty] = useState(false);
  const [isDiscardOpen, setDiscardOpen] = useState(false);
  const [hasConflict, setConflict] = useState(false);
  /** Bumped by "Reload task", so the form remounts from the fresh copy. */
  const [formGeneration, setFormGeneration] = useState(0);

  const { blocker, allowNavigation } = useUnsavedChangesGuard(isDirty);

  const { data: task, error, isPending, isFetching, refetch } = useTaskQuery(taskId);
  const facetsQuery = useTaskFacetsQuery();
  const mutation = useUpdateTaskMutation(taskId);

  useDocumentTitle(task === undefined ? undefined : `Edit ${task.reference}`);

  /**
   * `replace`, for the same reason `save()` below uses it: this page's history
   * entry is a form the user has finished with. Pushing over it makes Back land
   * *inside the edit form again* — from `/tasks/42` → Edit → Cancel the stack
   * would read `[list, detail, edit, detail]`, so one Back press reopens the
   * form they just abandoned, and a second returns to the detail page they were
   * already on. Cancel and save leave by the same door.
   */
  const backToTask = () => {
    allowNavigation();
    void navigate(`/tasks/${taskId}`, { replace: true, state: location.state });
  };

  if (isPending) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Edit task" />
        <FormSkeleton />
      </div>
    );
  }

  if (isApiClientError(error) && error.code === "TASK_NOT_FOUND") {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Edit task" />
        <NotFoundState />
      </div>
    );
  }

  if (task === undefined) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Edit task" />
        <ErrorPanel error={error} onRetry={() => void refetch()} isRetrying={isFetching} />
      </div>
    );
  }

  const save = (patch: UpdateTaskInput, helpers: TaskFormHelpers) => {
    setConflict(false);
    mutation.mutate(patch, {
      onSuccess: () => {
        allowNavigation();
        toast.success("Changes saved");
        void navigate(`/tasks/${taskId}`, { replace: true, state: location.state });
      },
      onError: (saveError) => {
        // `details` → fields, unknown keys → summary. Never a direct map.
        helpers.applyServerError(saveError);

        // Not a field's fault and not a toast's job: it needs a decision (reload
        // or keep typing), so it gets a notice at the top of the form, beside
        // the values the user would lose. Everything typed stays put.
        if (isApiClientError(saveError) && saveError.code === "VERSION_CONFLICT") {
          setConflict(true);
          return;
        }

        if (!isApiClientError(saveError) || saveError.code !== "VALIDATION_ERROR") {
          const copy = errorCopy(saveError);
          toast.error(copy.title, { description: copy.description });
        }
      },
    });
  };

  const reload = () => {
    void refetch().then(() => {
      setConflict(false);
      setFormGeneration((generation) => generation + 1);
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={task.reference} title={`Edit ${task.reference}`} />

      {/*
        Mounted only once the task is here, so `defaultValues` are the real
        ones. A form that renders empty and repopulates in an effect fights
        anything already typed into it — the page doc calls this out explicitly.
      */}
      <TaskEditForm
        key={formGeneration}
        task={task}
        isSubmitting={mutation.isPending}
        projectSuggestions={facetsQuery.data?.projects}
        notice={
          hasConflict ? <ConflictNotice onReload={reload} isReloading={isFetching} /> : undefined
        }
        onDirtyChange={setDirty}
        onCancel={() => {
          if (isDirty) {
            setDiscardOpen(true);
            return;
          }
          backToTask();
        }}
        onSave={save}
      />

      {/*
        Read-only metadata as a `<dl>`, not disabled inputs. A disabled input is
        skipped by screen readers and reads as something you failed to enable.
      */}
      <dl className="grid max-w-2xl grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-4">
        <DetailField label="Status">
          <StatusBadge status={task.status} />
        </DetailField>
        <DetailField label="Created by">
          <ActorBadge actor={task.createdBy} />
        </DetailField>
        <DetailField label="Created">
          <span title={formatAbsolute(task.createdAt)}>{formatDate(task.createdAt)}</span>
        </DetailField>
        <DetailField label="Completed">
          {task.completedAt === null ? "—" : formatDate(task.completedAt)}
        </DetailField>
      </dl>

      <ConfirmDialog
        open={isDiscardOpen || blocker.state === "blocked"}
        onOpenChange={(open) => {
          if (open) return;
          setDiscardOpen(false);
          if (blocker.state === "blocked") blocker.reset();
        }}
        title="Discard your changes?"
        description="You have unsaved changes to this task. Leaving now loses them."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        onConfirm={() => {
          setDiscardOpen(false);
          if (blocker.state === "blocked") {
            allowNavigation();
            blocker.proceed();
            return;
          }
          backToTask();
        }}
      />
    </div>
  );
};

type TaskEditFormProps = {
  task: Task;
  isSubmitting: boolean;
  projectSuggestions: readonly string[] | undefined;
  notice: ReactNode;
  onDirtyChange: (isDirty: boolean) => void;
  onCancel: () => void;
  onSave: (patch: UpdateTaskInput, helpers: TaskFormHelpers) => void;
};

/**
 * The form, plus the **snapshot the form was initialised from**.
 *
 * This component exists for `baselineRef` and nothing else. react-hook-form
 * reads `defaultValues` exactly once, at mount, so the form's own idea of "what
 * was on screen when I loaded" is frozen there — while `task` is live query
 * data that keeps moving underneath it. With `staleTime: 30_000` and
 * `refetchOnMount`, opening a detail page, reading for a minute and clicking
 * Edit mounts this form from the stale cache while a refetch is already in
 * flight.
 *
 * Diffing the frozen control values against the *refetched* task is worse
 * than not diffing at all: a field the user never touched (`assignee`, still
 * `""` in the form because it was `null` at mount) now differs from a value
 * somebody else just wrote (`"Marcus Feld"`), so the diff PATCHes
 * `assignee: null` and silently destroys their edit — the exact loss the diff
 * exists to prevent.
 *
 * `useRef(task)` initialises on the first render of this component and is
 * never reassigned. The parent renders a skeleton until the task is here, so
 * that first render is the same one that produced `defaultValues`; the two
 * cannot drift apart.
 */
const TaskEditForm = ({
  task,
  isSubmitting,
  projectSuggestions,
  notice,
  onDirtyChange,
  onCancel,
  onSave,
}: TaskEditFormProps) => {
  const baselineRef = useRef(task);

  return (
    <TaskForm
      mode="edit"
      /*
        `task`, not `baselineRef.current` — reading a ref during render is
        exactly what the lint rule forbids, and here the two are the same
        value: the ref was initialised from this prop on this render, and
        react-hook-form reads `defaultValues` only on that first one. Every
        later render passes a value the form ignores. The **submit** path,
        which runs in a handler, reads the ref.
      */
      defaultValues={toFormValues(task)}
      isSubmitting={isSubmitting}
      submitLabel="Save changes"
      projectSuggestions={projectSuggestions}
      notice={notice}
      onDirtyChange={onDirtyChange}
      onCancel={onCancel}
      onSubmit={(values, helpers) => {
        const baseline = baselineRef.current;
        const patch = diffTaskPatch(values as UpdateTaskInput, baseline);

        // The server would answer `AT_LEAST_ONE_FIELD` (422) for an empty
        // patch. Short-circuiting is not about saving the round trip: a toast
        // reading "Nothing to save" is the honest answer, where the server's
        // 422 would surface as a red error for a harmless action.
        if (!hasAtLeastOneField(patch)) {
          toast.info("No changes to save");
          return;
        }

        // The version the form was *loaded* at — not the live one a poll may
        // have moved on to — so an agent's write in between is caught.
        onSave({ ...patch, expectedVersion: baseline.version }, helpers);
      }}
    />
  );
};

/** Task → the controls' shape. `null` becomes `""`; the schema maps it back. */
export const toFormValues = (task: Task): TaskFormValues => ({
  title: task.title,
  description: task.description,
  priority: task.priority,
  project: task.project ?? "",
  assignee: task.assignee ?? "",
  acceptanceCriteria: task.acceptanceCriteria ?? "",
  links: task.links.map((link) => ({ label: link.label, url: link.url })),
  parentId: task.parentId === null ? "" : String(task.parentId),
});

/**
 * The parsed form output minus everything that still equals the task the form
 * was **initialised from** (`TaskEditForm`'s `baselineRef`, never live query
 * data — see that component).
 *
 * Compared against a **task**, not against the raw `defaultValues`, and that
 * distinction is the point: both sides of the comparison are then in the
 * server's own canonical shape (`null` for an empty optional, a trimmed title, a
 * lowercased project), so "the user typed a trailing space" is correctly *not* a
 * change. `links` is an array, so it is compared by value — a reference
 * comparison would call every save a links change.
 */
export const diffTaskPatch = (values: UpdateTaskInput, task: Task): UpdateTaskInput => {
  const current: UpdateTaskInput = {
    title: task.title,
    description: task.description,
    priority: task.priority,
    project: task.project,
    assignee: task.assignee,
    acceptanceCriteria: task.acceptanceCriteria,
    links: task.links,
    parentId: task.parentId,
  };

  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const before = (current as Record<string, unknown>)[key];
    const same =
      key === "links" ? JSON.stringify(value) === JSON.stringify(before) : value === before;
    if (!same) patch[key] = value;
  }
  return patch as UpdateTaskInput;
};

/**
 * The `VERSION_CONFLICT` notice. An alert, because it arrives in response to
 * the user's own save and changes what they should do next.
 */
const ConflictNotice = ({
  onReload,
  isReloading,
}: {
  onReload: () => void;
  isReloading: boolean;
}) => (
  <div
    role="alert"
    className="flex flex-col items-start gap-3 rounded-lg border border-warning/40 bg-warning-subtle px-4 py-3 text-sm text-warning-subtle-foreground"
  >
    <div className="flex flex-col gap-1">
      <p className="font-semibold">This task changed while you were editing</p>
      <p>
        Someone — possibly an agent — changed this task; reload to see their changes. Reloading
        replaces what you have typed here, so copy anything you want to keep first.
      </p>
    </div>
    <Button variant="outline" size="sm" onClick={onReload} isLoading={isReloading}>
      <RefreshCw aria-hidden="true" />
      Reload task
    </Button>
  </div>
);
