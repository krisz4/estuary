import { type HumanWait } from "@estuary/contracts";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui";
import { formatWaitDuration, isStillWaiting } from "@/features/logbook/waiting";
import { TASK_STATUS_LABELS } from "@/lib/formatting";

export type LongestWaitsListProps = {
  waits: HumanWait[];
};

/** The ten longest human-wait stints in range (longest first, per the API). Still-waiting ones are called out. */
export const LongestWaitsList = ({ waits }: LongestWaitsListProps) => {
  if (waits.length === 0) {
    return <p className="text-sm text-muted-foreground">No one waited on a human in this range.</p>;
  }

  return (
    <ol className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card shadow-raised">
      {waits.map((wait) => (
        <li
          key={`${wait.taskId}-${wait.startedAt}`}
          className="flex items-center justify-between gap-3 px-3 py-2"
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            <Link
              to={`/tasks/${wait.taskId}`}
              className="flex min-w-0 items-baseline gap-1.5 text-sm font-medium text-foreground hover:text-primary hover:underline"
            >
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                #{wait.taskId}
              </span>
              <span className="line-clamp-2 min-w-0">{wait.title ?? "(deleted task)"}</span>
            </Link>
            <span className="text-xs text-muted-foreground">{TASK_STATUS_LABELS[wait.status]}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isStillWaiting(wait) ? (
              <Badge tone="warning" dot>
                Still waiting
              </Badge>
            ) : null}
            <span className="font-mono text-sm text-foreground">
              {formatWaitDuration(wait.minutes)}
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
};
