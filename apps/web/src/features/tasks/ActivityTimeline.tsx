import { formatReference, type TaskEvent } from "@helpdesk/contracts";
import { Link } from "react-router-dom";
import { type ReactNode } from "react";
import { useTaskEventsQuery } from "@/api/events";
import { ErrorPanel } from "@/components/ErrorPanel";
import { Button, Skeleton } from "@/components/ui";
import { ActorBadge } from "@/features/tasks/ActorBadge";
import { isTaskStatus } from "@/lib/statusTransition";
import {
  COMMENT_KIND_LABELS,
  TASK_STATUS_LABELS,
  formatAbsolute,
  formatRelative,
  toDateTimeAttribute,
} from "@/lib/formatting";

/**
 * The task's history, from `GET /events?taskId=` — every write, by whom.
 *
 * This is how a human follows what agents did to a task: the status note and
 * the open decision describe *now*, and are replaced by the next transition;
 * this is the record. Newest first, because the question a reader brings is
 * "what happened since I last looked".
 *
 * It owns its own query and its own three states. The detail page is useful
 * without it, so a failed events request is an error panel *here*, not a
 * broken page.
 *
 * ## Payloads are read defensively
 *
 * `payload` is `record<string, unknown>` on the wire — each type's shape is
 * documented, not enforced (`docs/features/Task_Workflow_API.md` § Events). So
 * every value is checked before it is rendered, and an event whose payload is
 * not the documented shape still produces a line ("changed the status"), never
 * a crash and never `undefined` on screen.
 */

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const statusLabel = (value: unknown): string | undefined => {
  const raw = str(value);
  if (raw === undefined) return undefined;
  return isTaskStatus(raw) ? TASK_STATUS_LABELS[raw] : raw;
};

const taskLink = (value: unknown): ReactNode => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    return "another task";
  return (
    <Link to={`/tasks/${value}`} className="font-mono text-xs text-primary hover:underline">
      {formatReference(value)}
    </Link>
  );
};

/** What happened, as a phrase that follows the actor's name, plus any quoted detail. */
export const describeEvent = (event: TaskEvent): { summary: ReactNode; detail?: string } => {
  const p = event.payload;

  switch (event.type) {
    case "task.created": {
      const status = statusLabel(p.status);
      return {
        summary: status === undefined ? "created the task" : `created the task in ${status}`,
      };
    }
    case "task.updated": {
      const fields = Array.isArray(p.fields)
        ? p.fields.filter((field): field is string => typeof field === "string")
        : [];
      return { summary: fields.length === 0 ? "edited the task" : `edited ${fields.join(", ")}` };
    }
    case "task.deleted":
      return { summary: "deleted the task" };
    case "task.status_changed": {
      const from = statusLabel(p.from);
      const to = statusLabel(p.to);
      const summary =
        to === undefined
          ? "changed the status"
          : from === undefined
            ? `moved it to ${to}`
            : `moved it from ${from} to ${to}`;
      return { summary, detail: str(p.note) };
    }
    case "task.claimed":
      return { summary: "claimed it" };
    case "task.released":
      return { summary: "released its claim", detail: str(p.reason) };
    case "comment.created": {
      const kind = str(p.kind);
      if (kind === "progress") return { summary: "logged progress" };
      if (kind === "qa_feedback") return { summary: `left ${COMMENT_KIND_LABELS.qa_feedback}` };
      return { summary: "commented" };
    }
    case "comment.deleted":
      return { summary: "deleted a comment" };
    case "decision.requested":
      return { summary: "asked for a decision", detail: str(p.question) };
    case "decision.answered": {
      const choice = str(p.choice);
      return {
        summary: choice === undefined ? "answered the decision" : `answered: ${choice}`,
        detail: str(p.note),
      };
    }
    case "decision.withdrawn":
      return { summary: "withdrew the open decision" };
    case "dependency.added":
      return { summary: <>made it depend on {taskLink(p.dependsOnId)}</> };
    case "dependency.removed":
      return { summary: <>removed the dependency on {taskLink(p.dependsOnId)}</> };
    case "github.pull_request": {
      // Posted by the GitHub webhook, not a person — its `action` names what
      // happened on GitHub's side ("opened", "closed", "merged", …), read
      // defensively like every other payload here.
      const action = str(p.action);
      const number = typeof p.number === "number" ? p.number : undefined;
      const pr = number === undefined ? "a pull request" : `PR #${number}`;
      return {
        summary: action === undefined ? `updated ${pr} on GitHub` : `${action} ${pr} on GitHub`,
      };
    }
  }
};

export const ActivityTimeline = ({ taskId }: { taskId: number }) => {
  const query = useTaskEventsQuery(taskId);

  // Oldest first on the wire, page after page; newest first on screen.
  const events = (query.data?.pages.flatMap((page) => page.data) ?? []).slice().reverse();

  return (
    <section aria-labelledby="activity-heading" className="flex flex-col gap-3">
      <h2 id="activity-heading" className="text-base font-semibold text-foreground">
        Activity
      </h2>

      {query.isPending ? (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading activity">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="flex flex-col gap-1.5">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-24" />
            </div>
          ))}
        </div>
      ) : query.error !== null && query.data === undefined ? (
        <ErrorPanel
          error={query.error}
          onRetry={() => void query.refetch()}
          isRetrying={query.isFetching}
        />
      ) : events.length === 0 ? (
        <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
      ) : (
        <>
          {/*
            Above the list, because the list is newest first: the pages not yet
            loaded are the *newest* events (the feed is paged oldest first), so
            they belong on top.
          */}
          {query.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              isLoading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              Load newer activity
            </Button>
          ) : null}

          <ol className="flex flex-col gap-3 border-l border-border pl-4">
            {events.map((event) => {
              const { summary, detail } = describeEvent(event);
              return (
                <li key={event.id} className="relative flex flex-col gap-0.5 text-sm">
                  <span
                    className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full bg-border"
                    aria-hidden="true"
                  />
                  <p className="flex flex-wrap items-baseline gap-x-1.5 text-foreground">
                    <ActorBadge actor={event.actor} plain className="text-sm text-foreground" />
                    <span>{summary}</span>
                  </p>
                  {detail === undefined ? null : (
                    <p className="line-clamp-4 text-xs whitespace-pre-wrap text-muted-foreground">
                      “{detail}”
                    </p>
                  )}
                  <time
                    dateTime={toDateTimeAttribute(event.createdAt)}
                    title={formatAbsolute(event.createdAt)}
                    className="text-xs text-muted-foreground"
                  >
                    {formatRelative(event.createdAt)}
                  </time>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
};
