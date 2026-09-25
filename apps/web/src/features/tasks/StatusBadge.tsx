import { type TicketStatus } from "@helpdesk/contracts";
import { Badge, type BadgeTone } from "@/components/ui";
import { cn } from "@/lib/cn";
import { TICKET_STATUS_LABELS } from "@/lib/formatting";

/**
 * Status pill, per `docs/features/Ticket_Status_Lifecycle.md` § UI mapping.
 *
 * `open` and `closed` both map to the neutral quartet, so they are separated by
 * weight rather than hue: `open` keeps full-contrast neutral text, `closed`
 * recedes to `muted-foreground` so active work reads first in a 60-row list.
 * That is a deliberate pairing, not two tones that happen to collide.
 *
 * The text label is always rendered — colour never carries meaning alone.
 */

const TONES: Record<TicketStatus, BadgeTone> = {
  open: "neutral",
  in_progress: "info",
  resolved: "success",
  closed: "neutral",
};

const OVERRIDES: Partial<Record<TicketStatus, string>> = {
  closed: "bg-muted text-muted-foreground",
};

export type StatusBadgeProps = {
  status: TicketStatus;
  className?: string;
};

export const StatusBadge = ({ status, className }: StatusBadgeProps) => (
  <Badge tone={TONES[status]} dot className={cn(OVERRIDES[status], className)}>
    {TICKET_STATUS_LABELS[status]}
  </Badge>
);
