import { type TaskStatus } from "@helpdesk/contracts";
import { Badge, type BadgeTone } from "@/components/ui";
import { cn } from "@/lib/cn";
import { TASK_STATUS_LABELS } from "@/lib/formatting";

/**
 * Status pill, per `docs/features/Task_Status_Lifecycle.md` § UI mapping.
 *
 * Ten statuses and six tones, so hue is grouped by *what the status asks of
 * the reader* rather than one colour each — ten hues on one screen is noise:
 *
 * | Tone | Statuses | Reads as |
 * | ---- | -------- | -------- |
 * | `attention` | needs decision / action / QA | "needs you" — the inbox; amber, the same as the map's pools |
 * | `destructive` | blocked | stuck |
 * | `warning` | needs refinement | not ready |
 * | `info` | in progress | moving |
 * | `success` | done | finished |
 * | `neutral` | to do | ready, waiting its turn |
 * | muted | backlog, deferred | recedes, so live work reads first |
 *
 * Not `primary`: blue is the colour of things you can click, and a status
 * pill in the same blue as the buttons beside it reads as one more button.
 *
 * The two muted statuses share a treatment and are told apart by their label,
 * which is always rendered — colour never carries meaning alone.
 */

const TONES: Record<TaskStatus, BadgeTone> = {
  backlog: "neutral",
  needs_refinement: "warning",
  todo: "neutral",
  in_progress: "info",
  blocked: "destructive",
  needs_user_decision: "attention",
  needs_user_action: "attention",
  needs_qa: "attention",
  done: "success",
  deferred: "neutral",
};

const RECEDES = "bg-muted text-muted-foreground";

const OVERRIDES: Partial<Record<TaskStatus, string>> = {
  backlog: RECEDES,
  deferred: RECEDES,
};

export type StatusBadgeProps = {
  status: TaskStatus;
  className?: string;
};

export const StatusBadge = ({ status, className }: StatusBadgeProps) => (
  <Badge tone={TONES[status]} dot className={cn(OVERRIDES[status], className)}>
    {TASK_STATUS_LABELS[status]}
  </Badge>
);
