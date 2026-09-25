import { HUMAN_ATTENTION_STATUSES, type TaskStatus, type TaskSummary } from "@helpdesk/contracts";
import { Columns3, Inbox } from "lucide-react";
import { Link } from "react-router-dom";
import { useInboxQuery } from "@/api/tasks";
import { EmptyState } from "@/components/EmptyState";
import { ErrorPanel } from "@/components/ErrorPanel";
import { Button, Skeleton } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatCount } from "@/lib/formatting";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { InboxItem } from "@/pages/inbox/InboxItem";

/**
 * `/inbox` — everything waiting on a human. Spec: `docs/pages/Inbox.md`.
 *
 * Agents stop and hand work to a person in exactly three ways
 * (`HUMAN_ATTENTION_STATUSES`): they ask a question (`needs_user_decision`),
 * they need a manual step done (`needs_user_action`), or they finished and
 * want it verified (`needs_qa`). This page is those three queues, each with
 * the controls to clear an item **without opening the task** — answering,
 * handing back, approving or sending back are all one or two clicks here.
 *
 * One request (`useInboxQuery`) rather than three: it is a single list query
 * with a repeated `status`, grouped client-side in lifecycle order. It polls, so
 * a question an agent asks appears while the page is open; and it sits under
 * `tasks.lists()`, so an item cleared here — or anywhere else — drops out on
 * the invalidation that write already triggers.
 */

const GROUPS: Record<(typeof HUMAN_ATTENTION_STATUSES)[number], { title: string; hint: string }> = {
  needs_user_decision: {
    title: "Decisions",
    hint: "An agent asked a question. Pick an option, or answer in your own words.",
  },
  needs_user_action: {
    title: "Actions",
    hint: "A manual step only a human can do. Do it, then hand the task back.",
  },
  needs_qa: {
    title: "Ready for QA",
    hint: "The work is done. Check it against the acceptance criteria.",
  },
};

export const InboxPage = () => {
  useDocumentTitle("Inbox");

  const { data, error, isPending, isFetching, refetch } = useInboxQuery();
  const tasks = data?.data ?? [];
  const total = data?.meta.total ?? 0;

  const groups = HUMAN_ATTENTION_STATUSES.map((status) => ({
    status,
    tasks: tasks.filter((task) => task.status === status),
  })).filter((group) => group.tasks.length > 0);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">Inbox</h1>
        <p className="text-sm text-muted-foreground">
          What agents are waiting on you for: questions, manual steps, and work to verify.
        </p>
      </header>

      {/* Announced, not shown twice: the group headings carry the visible counts. */}
      <p aria-live="polite" className="sr-only">
        {data === undefined ? "" : `${formatCount(total, "task")} waiting on you`}
      </p>

      {/* A failed poll keeps the items on screen and explains itself above them. */}
      {error !== null && data !== undefined ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} isRetrying={isFetching} />
      ) : null}

      {isPending ? (
        <InboxSkeleton />
      ) : error !== null && data === undefined ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} isRetrying={isFetching} />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="Nothing needs you"
          description="No questions, manual steps, or work waiting for review. When an agent needs a human, it shows up here."
          action={
            <Button asChild variant="outline">
              <Link to="/tasks/board">
                <Columns3 aria-hidden="true" />
                Go to the board
              </Link>
            </Button>
          }
        />
      ) : (
        <>
          {groups.map((group) => (
            <InboxGroup key={group.status} status={group.status} tasks={group.tasks} />
          ))}
          {total > tasks.length ? (
            <p className="text-sm text-muted-foreground">
              Showing the {tasks.length} most urgent of {total}. Clear some to see the rest.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
};

const InboxGroup = ({ status, tasks }: { status: TaskStatus; tasks: TaskSummary[] }) => {
  const { title, hint } = GROUPS[status as keyof typeof GROUPS];
  const headingId = `inbox-${status}`;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 id={headingId} className="text-base font-semibold text-foreground">
          {title} <span className="font-normal text-muted-foreground">({tasks.length})</span>
        </h2>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
      <ul className="flex flex-col gap-3">
        {tasks.map((task) => (
          <li key={task.id}>
            <InboxItem task={task} />
          </li>
        ))}
      </ul>
    </section>
  );
};

/** Two groups of card-shaped placeholders — the real layout's shape. */
const InboxSkeleton = () => (
  <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading inbox">
    {[2, 1].map((count, group) => (
      <div key={group} className="flex flex-col gap-3">
        <Skeleton className="h-5 w-32" />
        {Array.from({ length: count }, (_, index) => (
          <div
            key={index}
            className={cn("flex flex-col gap-3 rounded-lg border border-border bg-card p-4")}
          >
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-16 w-full" />
            <div className="flex gap-2">
              <Skeleton className="h-9 w-28" />
              <Skeleton className="h-9 w-24" />
            </div>
          </div>
        ))}
      </div>
    ))}
  </div>
);
