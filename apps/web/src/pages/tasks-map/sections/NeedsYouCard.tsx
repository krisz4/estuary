import { type TaskSummary } from "@helpdesk/contracts";
import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatRelative } from "@/lib/formatting";
import { KindPill } from "@/pages/tasks-map/sections/KindPill";
import { useNeedsYouActions } from "@/pages/tasks-map/sections/useNeedsYouActions";

/**
 * The hero rail's compact card — ~90–120px, not a stretched `InboxItem`
 * (that renders the full decision form and ran to 438px). One-click primary
 * action from `useNeedsYouActions`; anything needing typed input opens the
 * real task (`onOpen`) instead of trying to fit a form in this footprint.
 */
export const NeedsYouCard = ({
  task,
  onOpen,
  className,
}: {
  task: TaskSummary;
  onOpen: (taskId: number) => void;
  className?: string;
}) => {
  const { kind, contextLine, primaryLabel, runPrimary, isPrimaryPending, secondaryLabel } = useNeedsYouActions(task);

  return (
    <article
      className={cn(
        // The amber left edge is the rail's through-line: every card in it is
        // something waiting on you, and the eye can follow the stripe down.
        "flex flex-col gap-1.5 rounded-lg border border-border border-l-[3px] border-l-attention bg-card p-2.5 text-sm",
        "shadow-raised transition-shadow hover:shadow-floating",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        {kind === null ? null : <KindPill kind={kind} />}
        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">{task.reference}</span>
      </div>
      <button
        type="button"
        onClick={() => onOpen(task.id)}
        className="line-clamp-2 text-left text-sm leading-snug font-medium text-foreground hover:underline"
      >
        {task.title}
      </button>
      <p className="line-clamp-1 text-xs text-muted-foreground">{contextLine}</p>
      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <time className="shrink-0 text-[11px] text-muted-foreground">{formatRelative(task.updatedAt)}</time>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => onOpen(task.id)}
          >
            {secondaryLabel}
          </Button>
          {primaryLabel === null || runPrimary === null ? null : (
            <Button
              type="button"
              size="sm"
              className="h-7 px-2 text-xs"
              isLoading={isPrimaryPending}
              onClick={runPrimary}
            >
              {primaryLabel}
            </Button>
          )}
        </div>
      </div>
    </article>
  );
};
