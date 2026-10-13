import { useState } from "react";
import { type TaskExport } from "@estuary/contracts";
import { toast } from "sonner";
import { api } from "@/api/http";
import { Button } from "@/components/ui";
import { errorCopy, errorDescription } from "@/lib/errorMessages";
export const ExportTasksButton = ({ project }: { project: readonly string[] }) => {
  const [pending, setPending] = useState(false);
  const download = async () => {
    setPending(true);
    try {
      const data = await api.get<TaskExport>("/tasks/export", {
        query: project.length ? { project: [...project] } : {},
      });
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `estuary-export-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success("Tasks and history exported");
    } catch (error) {
      toast.error(errorCopy(error).title, { description: errorDescription(error) });
    } finally {
      setPending(false);
    }
  };
  return (
    <Button variant="outline" isLoading={pending} onClick={() => void download()}>
      Export tasks
    </Button>
  );
};
