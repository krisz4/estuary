import { type TicketStatus } from "@helpdesk/contracts";
import { Field, Select } from "@/components/ui";
import { isTicketStatus, statusChangeErrorMessage } from "@/lib/statusTransition";
import { statusOptions } from "@/lib/formatting";

/**
 * The inline status control on the ticket detail page.
 *
 * Status is the most common edit on a helpdesk ticket, so it does not require
 * entering the edit form (`docs/pages/Ticket_Detail.md` § 5). Picking a value
 * fires the PATCH immediately; the control is disabled while it is in flight, so
 * a second pick cannot race the first.
 *
 * The 409 message comes from `statusChangeErrorMessage`, which reads
 * `details.allowed` off the server's response — see that file for why the client
 * holds no transition table of its own.
 */

export type StatusSelectProps = {
  value: TicketStatus;
  onChange: (status: TicketStatus) => void;
  isPending?: boolean;
  /** The last failed status change, or `null`. Cleared by the caller on retry. */
  error?: unknown;
};

export const StatusSelect = ({ value, onChange, isPending = false, error }: StatusSelectProps) => (
  <Field label="Status" error={statusChangeErrorMessage(error)}>
    {(field) => (
      <Select<TicketStatus>
        options={statusOptions}
        value={value}
        disabled={isPending}
        onValueChange={(next) => {
          // Radix hands back a bare string. Parsing it through the contract enum
          // keeps an impossible value out of a PATCH body typed as if it could
          // not happen. `next !== value` is what stops Radix's initial
          // synchronisation from firing a no-op PATCH on mount.
          if (isTicketStatus(next) && next !== value) onChange(next);
        }}
        id={field.id}
        aria-describedby={field["aria-describedby"]}
        aria-invalid={field["aria-invalid"]}
        className="sm:w-full"
      />
    )}
  </Field>
);
