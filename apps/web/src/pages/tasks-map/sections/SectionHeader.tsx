import { type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type SectionTone = "attention" | "info" | "primary" | "neutral";

/** The accent bar and count pill per tone — the same hue the section's content uses. */
const TONE: Record<SectionTone, { bar: string; count: string }> = {
  attention: { bar: "bg-attention", count: "bg-attention-subtle text-attention-subtle-foreground" },
  info: { bar: "bg-info", count: "bg-info-subtle text-info-subtle-foreground" },
  primary: { bar: "bg-primary", count: "bg-primary-subtle text-primary-subtle-foreground" },
  neutral: {
    bar: "bg-muted-foreground/60",
    count: "bg-neutral-subtle text-neutral-subtle-foreground",
  },
};

/**
 * The one section-header shape used by every section on the Map landing
 * page: a small eyebrow label, the title, a count, and an optional
 * right-aligned action. Kept as a single component so every section reads as
 * part of the same page rather than five differently-styled panels stapled
 * together.
 *
 * `tone` colours a short accent bar and the count pill, so scrolling the page
 * the sections are told apart by colour before their titles are read — amber
 * for what waits on you, blue for what is moving, and so on.
 */
export const SectionHeader = ({
  eyebrow,
  title,
  count,
  action,
  tone = "neutral",
}: {
  eyebrow: string;
  title: string;
  count?: number | string;
  action?: ReactNode;
  tone?: SectionTone;
}) => (
  <div className="flex flex-wrap items-end justify-between gap-2 border-b border-border pb-3">
    <div className="flex items-stretch gap-3">
      <span aria-hidden="true" className={cn("w-1 shrink-0 rounded-full", TONE[tone].bar)} />
      <div>
        <p className="font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
          {eyebrow}
        </p>
        <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-foreground">
          {title}
          {count === undefined ? null : (
            <span
              className={cn(
                "rounded-full px-2 py-0.5 font-mono text-xs font-semibold tabular-nums",
                TONE[tone].count,
              )}
            >
              {count}
            </span>
          )}
        </h2>
      </div>
    </div>
    {action === undefined ? null : <div className="flex items-center gap-2">{action}</div>}
  </div>
);
