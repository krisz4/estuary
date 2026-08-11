import { ticketStatusSchema, type TicketStatus } from "@helpdesk/contracts";
import { allowedTransitionsFrom, errorCopy } from "@/lib/errorMessages";
import { TICKET_STATUS_LABELS } from "@/lib/formatting";

/**
 * Copy for a rejected status change, built from the **server's**
 * `details.allowed`.
 *
 * Shared by the detail page's `StatusSelect` and the edit form, which both put
 * the message on their status control. Written once because the alternative is
 * two strings that drift, and because neither screen may keep a local copy of
 * the transition table: the guard in
 * `docs/features/Ticket_Status_Lifecycle.md` is deliberately permissive and has
 * been loosened before, and a client-side table would then forbid something the
 * server allows with nothing failing anywhere.
 *
 * Returns `undefined` when there is no error at all. Any *other* error code
 * falls through to the mapped generic copy rather than to silence — a network
 * failure on a status change must still say something.
 */
export const statusChangeErrorMessage = (error: unknown): string | undefined => {
  if (error === undefined || error === null) return undefined;

  const allowed = allowedTransitionsFrom(error);
  if (allowed === undefined) return errorCopy(error).description;
  if (allowed.length === 0) return "This ticket cannot change status.";

  return `Not allowed from here. You can move it to ${formatList(allowed.map(statusLabel))} instead.`;
};

export const isTicketStatus = (value: string): value is TicketStatus =>
  ticketStatusSchema.safeParse(value).success;

/**
 * `details.allowed` is `string[]` on the wire, not `TicketStatus[]` — it is
 * server data, and a value outside the enum must render as itself rather than
 * as `undefined`.
 */
const statusLabel = (status: string): string =>
  isTicketStatus(status) ? TICKET_STATUS_LABELS[status] : status;

/** `["Open", "In progress"]` → `"Open or In progress"`. */
const formatList = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
