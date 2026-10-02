import { CREATABLE_TASK_STATUSES, type CreateTaskInput } from "@estuary/contracts";
import { useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { isApiClientError } from "@/api/http";
import { useCreateTaskMutation, useTaskFacetsQuery } from "@/api/tasks";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PageHeader, useBackToListPath } from "@/components/PageHeader";
import { emptyTaskFormValues, TaskForm, type CreatableStatus } from "@/features/tasks/TaskForm";
import { errorCopy } from "@/lib/errorMessages";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { useUnsavedChangesGuard } from "@/lib/useUnsavedChangesGuard";
import { useProjectScope } from "@/stores/projectScope";

/**
 * `/tasks/new` — spec: `docs/pages/Task_Create.md`. Task 4.3 of the brief.
 *
 * Success navigates with **`replace`**: the entry this page occupies is a form
 * whose submission already happened, so leaving it in the history stack means
 * Back re-opens a form that would create a second task if resubmitted. Replace
 * makes Back go to the list, which is where the user came from.
 *
 * `state` is forwarded to the detail page so the filtered list the user started
 * from is still one click away after creating a task.
 *
 * Every create carries an `idempotencyKey`, minted once per visit to this
 * page. A submit that timed out after the server had already written the task
 * and is then retried — the form keeps its values on failure, so retrying is
 * one click — returns the task the first attempt made instead of filing a
 * duplicate. Agents are told to do the same.
 */

/**
 * `crypto.randomUUID` exists only in secure contexts, and this app is served
 * over plain http on a LAN address in more than one self-hosted setup. The key
 * only has to be unique per attempt, not unguessable.
 */
const newIdempotencyKey = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? `web:${crypto.randomUUID()}`
    : `web:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/**
 * `/tasks/new?status=todo&project=estuary` — a prefilled create link. The
 * Map's hover "+" that used to produce it is gone, but a pasted link still
 * works. Pure and exported for a unit test: only a
 * `CREATABLE_TASK_STATUSES` value is honoured (`done` or anything invalid in
 * the URL is silently ignored rather than producing a form the create schema
 * would reject), and `project` is trimmed and dropped if empty — the caller
 * still falls back to the header's project scope either way.
 */
export type CreatePrefill = { status: CreatableStatus | undefined; project: string | undefined };

export const parseCreatePrefill = (searchParams: URLSearchParams): CreatePrefill => {
  const rawStatus = searchParams.get("status");
  const status = (CREATABLE_TASK_STATUSES as readonly string[]).includes(rawStatus ?? "")
    ? (rawStatus as CreatableStatus)
    : undefined;
  const rawProject = searchParams.get("project")?.trim();
  return { status, project: rawProject === "" ? undefined : rawProject };
};

export const TaskCreatePage = () => {
  useDocumentTitle("New task");

  const navigate = useNavigate();
  const location = useLocation();
  const backPath = useBackToListPath();

  const [isDirty, setDirty] = useState(false);
  const [isDiscardOpen, setDiscardOpen] = useState(false);

  const { blocker, allowNavigation } = useUnsavedChangesGuard(isDirty);
  const mutation = useCreateTaskMutation();
  const facetsQuery = useTaskFacetsQuery();
  const [idempotencyKey] = useState(newIdempotencyKey);
  const { project: scope } = useProjectScope();
  const [searchParams] = useSearchParams();
  const prefill = parseCreatePrefill(searchParams);

  /**
   * `replace`, for the same reason the success path uses it (see above). The
   * docstring named the hazard only for submission, but an abandoned form is
   * the same entry: pushing `/tasks` over `/tasks/new` leaves the create
   * form one Back press away, so cancelling out of it and pressing Back reopens
   * a blank form the user has already declined to fill in.
   */
  const leave = () => {
    allowNavigation();
    void navigate(backPath, { replace: true });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="New task"
        description="Describe the work well enough that a human or an agent could pick it up. Everything here can be edited later."
      />

      <TaskForm
        mode="create"
        // Filed into the project the user is scoped to — the one whose list or map they came from —
        // unless the link carried its own `?status=&project=` prefill.
        defaultValues={{
          ...emptyTaskFormValues(),
          project: prefill.project ?? scope ?? "",
          ...(prefill.status === undefined ? {} : { status: prefill.status }),
        }}
        isSubmitting={mutation.isPending}
        submitLabel="Create task"
        onDirtyChange={setDirty}
        projectSuggestions={facetsQuery.data?.projects}
        labelSuggestions={facetsQuery.data?.labels}
        onCancel={() => {
          if (isDirty) {
            setDiscardOpen(true);
            return;
          }
          leave();
        }}
        onSubmit={(values, helpers) => {
          mutation.mutate(
            { ...(values as CreateTaskInput), idempotencyKey },
            {
              onSuccess: (task) => {
                allowNavigation();
                toast.success(`Task ${task.reference} created`);
                void navigate(`/tasks/${task.id}`, { replace: true, state: location.state });
              },
              onError: (error) => {
                // Maps `details` onto the fields it recognises, and everything
                // else into the summary. The typed values are untouched either
                // way — nothing on this path resets the form.
                helpers.applyServerError(error);

                // A 422 is on screen already. Anything else has no other home.
                if (!isApiClientError(error) || error.code !== "VALIDATION_ERROR") {
                  const copy = errorCopy(error);
                  toast.error(copy.title, { description: copy.description });
                }
              },
            },
          );
        }}
      />

      <ConfirmDialog
        open={isDiscardOpen || blocker.state === "blocked"}
        onOpenChange={(open) => {
          if (open) return;
          setDiscardOpen(false);
          if (blocker.state === "blocked") blocker.reset();
        }}
        title="Discard this task?"
        description="You have unsaved changes. Leaving now loses everything typed here."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        onConfirm={() => {
          setDiscardOpen(false);
          if (blocker.state === "blocked") {
            allowNavigation();
            blocker.proceed();
            return;
          }
          leave();
        }}
      />
    </div>
  );
};
