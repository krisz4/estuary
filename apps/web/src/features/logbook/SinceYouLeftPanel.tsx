import { sinceYouLeftSentence, type SinceYouLeftSummary } from "@/features/logbook/sinceYouLeft";

export type SinceYouLeftPanelProps = {
  summary: SinceYouLeftSummary;
  lastVisitAt: string | null;
};

/**
 * "Since you left" — a compact, single-line briefing sentence in the same
 * tone as the floor's `Briefing` ("Since you left 14h ago: 5 shipped, 2 sent
 * back, claude-code asked 3 questions"), sitting on the top row next to the
 * range control rather than its own section. Built from the last-visit
 * timestamp in `stores/logbookVisit.ts` (floored at a 12h minimum lookback,
 * so it reads as empty only when genuinely nothing happened, not because the
 * visit was five minutes ago).
 *
 * Named `*Panel` rather than `SinceYouLeft`, which — on a case-insensitive
 * filesystem — collides with `sinceYouLeft.ts`, the pure summary this renders.
 */
export const SinceYouLeftPanel = ({ summary, lastVisitAt }: SinceYouLeftPanelProps) => {
  if (summary.firstVisit) {
    return (
      <p className="text-sm text-muted-foreground">
        First time here — the Logbook will remember when you leave, and tell you what changed next time.
      </p>
    );
  }

  const sentence = sinceYouLeftSentence(summary, lastVisitAt);

  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-sm text-pretty text-foreground">
        {sentence ?? "Nothing new since your last visit."}
      </p>
      {summary.truncated ? (
        <p className="text-xs text-muted-foreground">Only the most recent events are counted here.</p>
      ) : null}
    </div>
  );
};
