import { type TaskPriority } from "@helpdesk/contracts";
import { AlertTriangle, ArrowUp, type LucideIcon } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui";
import { cn } from "@/lib/cn";
import { TASK_PRIORITY_LABELS } from "@/lib/formatting";

/**
 * Priority pill, per `docs/features/Task_Priority.md` § UI mapping:
 * `low` outline/muted, `medium` outline/neutral, `high` amber + `ArrowUp`,
 * `urgent` red + `AlertTriangle`.
 *
 * The two low ends are outlines rather than fills on purpose. Filling all four
 * makes a list of mostly-medium tasks look like an alert board, and the design
 * guidelines allow exactly one strong colour on this screen — which status has
 * already spent.
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
