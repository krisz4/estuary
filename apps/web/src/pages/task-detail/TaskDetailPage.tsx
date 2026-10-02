import { taskIdParamSchema } from "@estuary/contracts";
import { useNavigate, useParams } from "react-router-dom";
import { NotFoundState } from "@/components/NotFoundState";
import { PageHeader, useBackToListPath } from "@/components/PageHeader";
import { TaskDetailView } from "@/features/tasks/TaskDetailView";

/**
 * `/tasks/:taskId` — spec: `docs/pages/Task_Detail.md`.
 *
 * A page, not a modal, so the URL is shareable — an agent can paste
 * `/tasks/42` into a hand-off note and a human lands on exactly this.
 *
 * The id is parsed with **`taskIdParamSchema` from the contracts package** —
 * the same schema the API's route uses. Two parsers for one concept is how
 * `/tasks/0000000000000000042` came to resolve differently from
 * `?q=0000000000000000042` on the server side (stage 8); the client has no
 * business inventing a third.
 *
 * The body is `TaskDetailView`, shared with the map's task modal; this page
 * adds only the id parsing and where a delete leaves for.
 */
export const TaskDetailPage = () => {
  const { taskId: raw } = useParams();
  const parsed = taskIdParamSchema.safeParse(raw);

  /*
    Split into two components rather than gating a hook with `enabled`. A
    malformed id has no request to make and no cache entry to hold, and the
    alternative — one component whose query key contains a sentinel id — puts an
    entry for a task that cannot exist into the cache.
  */
  if (!parsed.success) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Task" showBackLink />
        <NotFoundState description="That address does not contain a valid task number." />
      </div>
    );
  }

  return <TaskDetailPageView taskId={parsed.data} />;
};

const TaskDetailPageView = ({ taskId }: { taskId: number }) => {
  const navigate = useNavigate();
  // The same destination the header's back link points at.
  const backPath = useBackToListPath();
  return (
    <TaskDetailView
      taskId={taskId}
      variant="page"
      onDeleted={() => void navigate(backPath, { replace: true })}
    />
  );
};
