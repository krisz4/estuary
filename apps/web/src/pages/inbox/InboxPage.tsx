import { type TaskSummary } from "@estuary/contracts";
import { Check, Inbox, Map as MapIcon } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useInboxQuery, useTransitionTaskMutation } from "@/api/tasks";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { ReachEyebrow } from "@/components/ReachEyebrow";
import { ErrorPanel } from "@/components/ErrorPanel";
import { Button, Skeleton } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatCount } from "@/lib/formatting";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { InboxItem } from "@/pages/inbox/InboxItem";
import { type AttentionGroup, groupByAttentionKind } from "@/pages/inbox/attentionGroups";
import { parseProjects } from "@/pages/tasks-list/useTaskListParams";
import { projectScopeSearch, useRememberProjectScope } from "@/stores/projectScope";

/**
 * `/inbox` — everything waiting on a human. Spec: `docs/pages/Inbox.md`.
 *
 * Not only the three statuses an agent explicitly hands off to a person
 * (a question, a manual step, work to verify) — also a task stuck in
 * `needs_refinement`, an agent-filed suggestion nobody has triaged, and a
 * `blocked` task with no open dependency, so nothing an agent leaves behind
 * can miss a human (`ATTENTION_KINDS` / `attentionKindOf`,
 * `groupByAttentionKind`). Every item can be cleared **without opening the
 * task** — answering, handing back, approving, refining, accepting, or
 * dismissing are all one or two clicks here.
 *
 * One request (`useInboxQuery`, `?attention=true`) rather than one per kind:
 * it polls, so a question an agent asks appears while the page is open; and
 * it sits under `tasks.lists()`, so an item cleared here — or anywhere else —
 * drops out on the invalidation that write already triggers.
 *
 * `?project=` narrows it to one repository (or several), set by the header's
 * project switcher. Unscoped, a line above the groups says which projects the
 * items come from, each a link to that project's inbox — the triage view for
 * someone running agents on several repositories at once.
 */

export const InboxPage = () => {
  useDocumentTitle("Inbox");

  const [searchParams] = useSearchParams();
  const projects = parseProjects(searchParams.getAll("project"));
  useRememberProjectScope(projects);

  const { data, error, isPending, isFetching, refetch } = useInboxQuery(projects);
  const tasks = data?.data ?? [];
  const total = data?.meta.total ?? 0;

  const groups = groupByAttentionKind(tasks);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <ReachEyebrow name="The pools" place="where work waits on you" />
        <h1 className="text-2xl font-semibold text-foreground">Inbox</h1>
        <p className="text-sm text-muted-foreground">
          Everything agents are waiting on you for: questions, manual steps, work to verify, and
          anything left unattended.
        </p>
        {/* Scoped and empty, the empty state says the same thing, with the same link. */}
        {projects.length > 0 ? (
          groups.length === 0 ? null : (
            <p className="text-sm text-muted-foreground">
              Showing {projects.join(", ")} only.{" "}
              <Link
                to="/inbox"
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                Show all projects
              </Link>
            </p>
          )
        ) : (
          <ProjectBreakdown tasks={tasks} />
        )}
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
          art="still-water"
          title={
            projects.length > 0
              ? `Nothing in ${projects.join(", ")} needs you`
              : "Nothing needs you"
          }
          description="Slack water: no questions, manual steps, or work waiting for review. When an agent needs a human, it shows up here."
          action={
            projects.length > 0 ? (
              <Button asChild variant="outline">
                <Link to="/inbox">
                  <Inbox aria-hidden="true" />
                  Show all projects
                </Link>
              </Button>
            ) : (
              <Button asChild variant="outline">
                <Link to="/tasks/map">
                  <MapIcon aria-hidden="true" />
                  Go to the map
                </Link>
              </Button>
            )
          }
        />
      ) : (
        <>
          {groups.map((group) => (
            <InboxGroup key={group.kind} group={group} />
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

/**
 * "From estuary (3), web-app (2)" — which projects the unscoped inbox's items
 * belong to, each linking to that project's inbox. Counted from the items
 * loaded, so under the 100-item cap it describes what is shown, which the
 * "most urgent of" line already says is not everything.
 *
 * Only when there are two or more projects: one is already on every card.
 */
const ProjectBreakdown = ({ tasks }: { tasks: TaskSummary[] }) => {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (task.project !== null) counts.set(task.project, (counts.get(task.project) ?? 0) + 1);
  }
  if (counts.size < 2) return null;

  const entries = [...counts].sort(
    ([a, countA], [b, countB]) => countB - countA || a.localeCompare(b),
  );
  return (
    <p className="text-sm text-muted-foreground">
      From{" "}
      {entries.map(([project, count], index) => (
        <span key={project}>
          {index > 0 ? ", " : null}
          <Link
            to={`/inbox${projectScopeSearch(project)}`}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {project}
          </Link>{" "}
          <span className="tabular-nums">({count})</span>
        </span>
      ))}
    </p>
  );
};

const InboxGroup = ({ group }: { group: AttentionGroup }) => {
  const { kind, title, hint, tasks } = group;
  const headingId = `inbox-${kind}`;
  // Only `review` items with no `concerns` are routine — a flagged hand-off
  // is never swept up in the batch, however many routine siblings it has.
  const routineTasks = kind === "review" ? tasks.filter((task) => task.concerns === null) : [];

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-0.5">
          <h2 id={headingId} className="text-base font-semibold text-foreground">
            {title} <span className="font-normal text-muted-foreground">({tasks.length})</span>
          </h2>
          <p className="text-sm text-muted-foreground">{hint}</p>
        </div>
        {routineTasks.length >= 2 ? <ApproveAllRoutine tasks={routineTasks} /> : null}
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

/**
 * "Approve all routine (N)" — the Review group's header action, only shown
 * with two or more routine (no `concerns`) hand-offs. Transitions each to
 * `done` in turn and reports one toast summarising the outcome; a task
 * flagged with `concerns` is never in `tasks` here, so it can never be swept
 * into a batch approval.
 *
 * One confirm step, listing what will be approved: it is a bulk move to
 * `done`, and "routine" only means the agent raised no concerns — hand-offs
 * filed before `concerns` existed count as routine too.
 */
const ApproveAllRoutine = ({ tasks }: { tasks: TaskSummary[] }) => {
  const mutation = useTransitionTaskMutation();
  const [isRunning, setIsRunning] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const run = async () => {
    setIsRunning(true);
    let approved = 0;
    let failed = 0;
    for (const task of tasks) {
      try {
        await mutation.mutateAsync({ taskId: task.id, input: { to: "done" } });
        approved += 1;
      } catch {
        failed += 1;
      }
    }
    setIsRunning(false);
    setConfirming(false);
    if (failed === 0) {
      toast.success(`${formatCount(approved, "task")} approved`);
    } else {
      toast.error(
        `${formatCount(approved, "task")} approved, ${formatCount(failed, "task")} failed`,
        {
          description: "Open the ones that failed to see why.",
        },
      );
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        isLoading={isRunning}
        onClick={() => setConfirming(true)}
        className="shrink-0"
      >
        <Check aria-hidden="true" />
        Approve all routine ({tasks.length})
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Approve ${formatCount(tasks.length, "task")}?`}
        description={
          <>
            No agent raised concerns on these. Each moves to done.
            {/* Spans, not a list: the description renders inside a <p>. */}
            <span className="mt-2 block max-h-60 overflow-y-auto text-left">
              {tasks.map((task) => (
                <span key={task.id} className="block truncate">
                  <span className="font-mono text-xs">{task.reference}</span> {task.title}
                </span>
              ))}
            </span>
          </>
        }
        confirmLabel="Approve all"
        confirmVariant="primary"
        isPending={isRunning}
        onConfirm={() => void run()}
      />
    </>
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
            className={cn(
              "flex flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-raised",
            )}
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
