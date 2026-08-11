/**
 * Ticket reference formatting and parsing.
 *
 * The ticket's integer primary key **is** the ticket number; `reference` is a
 * presentation of it, computed at serialization time and never stored. Living
 * here means the API and the web app format identically.
 *
 * See `docs/features/Ticket_Numbering.md`.
 */

export const REFERENCE_PREFIX = "HD-";
export const REFERENCE_PAD_LENGTH = 6;

/** `42` → `"HD-000042"`. Padding is a minimum, not a truncation: ids past 999999 render wider. */
export const formatReference = (id: number): string =>
  `${REFERENCE_PREFIX}${String(id).padStart(REFERENCE_PAD_LENGTH, "0")}`;

/**
 * Accepts `HD-42`, `hd-000042`, `#42`, and a bare `42`; returns the integer, or
 * `null` for anything else.
 *
 * The match is on the **whole** number, not a prefix: `HD-4` resolves to ticket
 * 4, never to tickets 40–49. Prefix matching on an integer column would mean a
 * `CAST` and a full scan.
 */
export const parseReference = (input: string): number | null => {
  const match = /^(?:hd-|#)?(\d{1,15})$/i.exec(input.trim());
  const digits = match?.[1];
  if (digits === undefined) return null;

  const id = Number.parseInt(digits, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};
