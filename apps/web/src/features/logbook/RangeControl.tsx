import { LOGBOOK_RANGE_LABELS, LOGBOOK_RANGES, type LogbookRange } from "@/features/logbook/range";
import { cn } from "@/lib/cn";

export type RangeControlProps = {
  range: LogbookRange;
  onRangeChange: (range: LogbookRange) => void;
};

/** The presets' own value doubles as its short label — "24h", "7d", "30d", "90d" — for phones. */
const SHORT_LABELS: Partial<Record<LogbookRange, string>> = {
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
};

/**
 * The four presets, always a single row (never wrapping to two — the short
 * labels below `sm` keep four buttons plus their border/padding under a
 * 360px viewport). `custom` (an explicit `from`/`to` in the URL) has no
 * button — it is reached by editing the link.
 *
 * Each button's accessible name is set via `aria-label` to the full label
 * ("Last 30 days") regardless of which text is visible — the short form is
 * `aria-hidden`, so a screen reader and a query like
 * `getByRole("button", { name: "Last 30 days" })` see the same name at every
 * breakpoint.
 */
export const RangeControl = ({ range, onRangeChange }: RangeControlProps) => (
  <div
    role="group"
    aria-label="Range"
    className="inline-flex flex-nowrap gap-1 overflow-x-auto rounded-md border border-border p-1"
  >
    {LOGBOOK_RANGES.filter((candidate) => candidate !== "custom").map((candidate) => (
      <button
        key={candidate}
        type="button"
        aria-pressed={range === candidate}
        aria-label={LOGBOOK_RANGE_LABELS[candidate]}
        onClick={() => onRangeChange(candidate)}
        className={cn(
          "shrink-0 rounded px-2.5 py-1 text-sm font-medium whitespace-nowrap transition-colors",
          range === candidate
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <span className="sm:hidden" aria-hidden="true">
          {SHORT_LABELS[candidate]}
        </span>
        <span className="hidden sm:inline" aria-hidden="true">
          {LOGBOOK_RANGE_LABELS[candidate]}
        </span>
      </button>
    ))}
    {range === "custom" ? (
      <span className="shrink-0 rounded bg-neutral px-2.5 py-1 text-sm font-medium whitespace-nowrap text-neutral-foreground">
        {LOGBOOK_RANGE_LABELS.custom}
      </span>
    ) : null}
  </div>
);
