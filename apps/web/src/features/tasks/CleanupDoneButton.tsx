import { Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useCleanupDoneTasksMutation, useTaskStatsQuery } from "@/api/tasks";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui";
import { errorCopy, errorDescription } from "@/lib/errorMessages";
import { formatCount } from "@/lib/formatting";

/**
 * "Clean up done" — hard-deletes every `done` task in the list's project scope
 * (`docs/features/Task_Cleanup.md`). The count comes from the stats query the
 * header already polls, so opening the dialog costs no request; the server
 * re-selects inside its own transaction, so a task reopened in between is
 * never deleted.
 *
 * Disabled at zero rather than hidden, so the action stays findable and the
 * title says why there is nothing to do.
 */
export const CleanupDoneButton = ({ project }: { project: readonly string[] }) => {
  const [isOpen, setOpen] = useState(false);
  const statsQuery = useTaskStatsQuery(project);
  const mutation = useCleanupDoneTasksMutation();

  const doneCount = statsQuery.data?.byStatus.done ?? 0;
  const scope = project.length > 0 ? project.join(", ") : "all projects";

  const confirm = () => {
    mutation.mutate(project.length > 0 ? { project: [...project] } : {}, {
      onSuccess: (result) => {
        setOpen(false);
        toast.success(
          result.deleted === 0
            ? "No done tasks to delete"
            : `Deleted ${formatCount(result.deleted, "done task")}`,
        );
      },
      onError: (error) => {
        setOpen(false);
        toast.error(errorCopy(error).title, { description: errorDescription(error) });
      },
    });
  };

  return (
    <>
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        disabled={doneCount === 0}
        title={doneCount === 0 ? `No done tasks in ${scope}` : undefined}
      >
        <Trash2 aria-hidden="true" />
        <span className="sr-only sm:not-sr-only">Clean up done</span>
      </Button>

      <ConfirmDialog
        open={isOpen}
        onOpenChange={setOpen}
        title="Clean up done tasks?"
        description={
          <>
            Permanently delete {formatCount(doneCount, "done task")} in {scope}, with their comments
            and decisions. The Logbook keeps a record of each deletion. Tasks done for longer than
            the server&apos;s retention period (90 days by default) are removed automatically.
          </>
        }
        confirmLabel={`Delete ${formatCount(doneCount, "task")}`}
        isPending={mutation.isPending}
        onConfirm={confirm}
      />
    </>
  );
};
