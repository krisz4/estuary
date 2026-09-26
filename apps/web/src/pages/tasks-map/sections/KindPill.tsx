import { Eye, Hand, Split } from "lucide-react";
import { cn } from "@/lib/cn";
import { needsYouKindLabel, type NeedsYouKind } from "@/pages/tasks-map/sections/useNeedsYouActions";

const KIND_ICON = { decide: Split, act: Hand, review: Eye } as const;

/**
 * "Decide" / "Act" / "Review" — what a waiting task wants from you. All three
 * share the attention (amber) colour, because amber means "waits on you" and
 * nothing else; they differ by icon, so the three kinds are told apart by
 * shape at a glance without spending two more hues on it.
 */
export const KindPill = ({ kind, className }: { kind: NeedsYouKind; className?: string }) => {
  const Icon = KIND_ICON[kind];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full bg-attention-subtle px-1.5 py-0.5",
        "text-[10px] font-semibold tracking-wide text-attention-subtle-foreground uppercase",
        className,
      )}
    >
      <Icon className="size-3" aria-hidden="true" />
      {needsYouKindLabel[kind]}
    </span>
  );
};
