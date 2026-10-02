import { type Decision } from "@estuary/contracts";
import { ActorBadge } from "@/features/tasks/ActorBadge";
import { formatAbsolute, formatRelative, toDateTimeAttribute } from "@/lib/formatting";

/**
 * Decisions that are no longer open — answered or withdrawn — newest first, as
 * the API orders `Task.decisions`.
 *
 * The answered ones are the reason a task went back to `todo`: the status note
 * that recorded the answer is replaced by the very next transition, so this is
 * where the answer stays readable for the next agent and the next human.
 */
export const PastDecisions = ({ decisions }: { decisions: readonly Decision[] }) => (
  <ol className="flex flex-col gap-2">
    {decisions.map((decision) => (
      <li
        key={decision.id}
        className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2.5 text-sm shadow-raised"
      >
        <p className="font-medium text-foreground">{decision.question}</p>

        {decision.status === "withdrawn" ? (
          <p className="text-muted-foreground">Withdrawn — the task moved on without an answer.</p>
        ) : (
          <>
            {decision.choice === null ? null : (
              <p className="text-foreground">
                <span className="text-muted-foreground">Chose: </span>
                {decision.choice}
              </p>
            )}
            {decision.note === null ? null : (
              <p className="whitespace-pre-wrap text-foreground">
                <span className="text-muted-foreground">Note: </span>
                {decision.note}
              </p>
            )}
          </>
        )}

        <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          {decision.answeredBy === null ? (
            <>
              Asked by <ActorBadge actor={decision.requestedBy} plain />
            </>
          ) : (
            <>
              Answered by <ActorBadge actor={decision.answeredBy} plain />
            </>
          )}
          {decision.answeredAt === null ? null : (
            <time
              dateTime={toDateTimeAttribute(decision.answeredAt)}
              title={formatAbsolute(decision.answeredAt)}
            >
              {formatRelative(decision.answeredAt)}
            </time>
          )}
        </p>
      </li>
    ))}
  </ol>
);
