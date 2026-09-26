import { type TaskPriority } from "@helpdesk/contracts";
import { AlertTriangle, ArrowUp, type LucideIcon } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui";
import { cn } from "@/lib/cn";
import { TASK_PRIORITY_LABELS } from "@/lib/formatting";

/**
 * Priority pill, per `docs/features/Task_Priority.md` § UI mapping:
 * `low` outline/muted, `medium` outline/neutral, `high` yellow outline +
 * `ArrowUp`, `urgent` red fill + `AlertTriangle`.
 *
 * Everything below `urgent` is an **outline**, and status pills are fills:
 * the shape tells the two columns apart before the colour does. That matters
 * in dark mode, where a filled "High" (yellow) and a filled "Needs QA" (amber)
 * both darken to the same brown. Filling all four would also make a list of
 * mostly-medium tasks look like an alert board. `urgent` alone stays filled —
 * it is rare and is meant to shout.
 *
 * Icons are `aria-hidden`; the label carries the meaning.
 */

const TONES: Record<TaskPriority, BadgeTone> = {
  low: "neutral",
  medium: "neutral",
  high: "warning",
  urgent: "destructive",
};

const OVERRIDES: Partial<Record<TaskPriority, string>> = {
  low: "bg-transparent border border-border text-muted-foreground",
  medium: "bg-transparent border border-border text-foreground",
  high: "bg-transparent border border-warning/60 text-warning",
};

const ICONS: Partial<Record<TaskPriority, LucideIcon>> = {
  high: ArrowUp,
  urgent: AlertTriangle,
};

/** The left stripe on a mobile card. Same ordering signal, no extra row height. */
export const PRIORITY_STRIPE: Record<TaskPriority, string> = {
  low: "border-l-border",
  medium: "border-l-neutral",
  high: "border-l-warning",
  urgent: "border-l-destructive",
};

export type PriorityBadgeProps = {
  priority: TaskPriority;
  className?: string;
};

export const PriorityBadge = ({ priority, className }: PriorityBadgeProps) => {
  const Icon = ICONS[priority];

  return (
    <Badge tone={TONES[priority]} className={cn(OVERRIDES[priority], className)}>
      {Icon === undefined ? null : <Icon className="size-3" aria-hidden="true" />}
      {TASK_PRIORITY_LABELS[priority]}
    </Badge>
  );
};
