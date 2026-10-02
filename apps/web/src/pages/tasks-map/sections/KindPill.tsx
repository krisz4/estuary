import { type AttentionKind } from "@estuary/contracts";
import { Ban, Eye, Hand, Lightbulb, PenLine, Split } from "lucide-react";
import { cn } from "@/lib/cn";
import { ATTENTION_GROUP_META } from "@/pages/inbox/attentionGroups";

const KIND_ICON = {
  decide: Split,
  act: Hand,
  review: Eye,
  refine: PenLine,
  suggested: Lightbulb,
  blocked: Ban,
} as const satisfies Record<AttentionKind, unknown>;

/**
 * What a waiting task wants from you — all six `AttentionKind`s share the
 * attention (amber) colour, because amber means "waits on you" and nothing
 * else; they differ by icon, so they are told apart by shape at a glance
 * without spending more hues on it.
 */
export const KindPill = ({ kind, className }: { kind: AttentionKind; className?: string }) => {
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
      {ATTENTION_GROUP_META[kind].title}
    </span>
  );
};
