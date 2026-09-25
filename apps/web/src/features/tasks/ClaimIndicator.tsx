import { actorKindOf, type TaskClaim } from "@helpdesk/contracts";
import { Bot, Lock } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  actorDisplayName,
  formatAbsolute,
  formatRelative,
  toDateTimeAttribute,
} from "@/lib/formatting";

/**
 * "Someone is working on this" — the live lease on a task.
 *
 * `claim` is `null` both when nobody ever claimed the task and when the lease
 * expired (the contract serializes an expired lease as `null`), so there is
 * exactly one "not claimed" rendering: nothing.
 *
 * A bot icon for an agent's claim, a lock for a human's. The icon is
 * decoration; the text says "Claimed by claude-code" either way.
 */
export type ClaimIndicatorProps = {
  claim: TaskClaim;
  /** Also show when the lease runs out — the detail page's variant. */
  showExpiry?: boolean;
  className?: string;
};

export const ClaimIndicator = ({ claim, showExpiry = false, className }: ClaimIndicatorProps) => {
  const Icon = actorKindOf(claim.actor) === "agent" ? Bot : Lock;

  return (
    <span
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1 text-xs text-info-subtle-foreground",
        className,
      )}
      title={`Claimed by ${claim.actor} until ${formatAbsolute(claim.expiresAt)}`}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">
        <span className="sr-only">Claimed by </span>
        {actorDisplayName(claim.actor)}
      </span>
      {showExpiry ? (
        <span className="shrink-0 text-muted-foreground">
          · lease ends{" "}
          <time dateTime={toDateTimeAttribute(claim.expiresAt)}>
            {formatRelative(claim.expiresAt)}
          </time>
        </span>
      ) : null}
    </span>
  );
};
