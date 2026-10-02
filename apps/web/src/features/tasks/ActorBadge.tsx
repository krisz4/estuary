import { actorKindOf, type ActorKind } from "@estuary/contracts";
import { Bot, Cog, User, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { ACTOR_KIND_LABELS, actorDisplayName } from "@/lib/formatting";

/**
 * Who did something — an agent, a human, or the server itself.
 *
 * The kind is the point of this component: the audit trail exists so a reader
 * can tell an agent's change from a human's at a glance
 * (`docs/features/Actors.md`). It is carried by an icon *and* by text — the
 * icon is `aria-hidden`, and the kind is spelled out for assistive technology
 * ("Agent claude-code"), so it never rests on the glyph alone.
 *
 * Deliberately not a coloured `Badge`: actors appear on every row of the list
 * and every comment, and the design guidelines reserve the screen's one strong
 * colour for status.
 */

const ICONS: Record<ActorKind, LucideIcon> = {
  agent: Bot,
  human: User,
  system: Cog,
};

export type ActorBadgeProps = {
  actor: string;
  /** Show only the icon and name, no chip — for dense rows. */
  plain?: boolean;
  className?: string;
};

export const ActorBadge = ({ actor, plain = false, className }: ActorBadgeProps) => {
  const kind = actorKindOf(actor);
  const Icon = ICONS[kind];
  const name = actorDisplayName(actor);

  return (
    <span
      title={actor}
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1 text-xs",
        plain
          ? "text-muted-foreground"
          : "rounded-full border border-border bg-card px-2 py-0.5 text-foreground",
        className,
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span className="sr-only">{ACTOR_KIND_LABELS[kind]} </span>
      <span className="truncate">{name}</span>
    </span>
  );
};
