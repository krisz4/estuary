/**
 * Task reference formatting and parsing.
 *
 * The task's integer primary key **is** the task number; `reference` is a
 * presentation of it, computed at serialization time and never stored. Living
 * here means the API and the web app format identically.
 *
 * See `docs/features/Task_Numbering.md`.
 */

export const REFERENCE_PREFIX = "TASK-";
export const REFERENCE_PAD_LENGTH = 6;

/**
 * The digit-count cap every parser that turns user input into a task id shares:
 * this module's `parseReference`, and `taskIdParamSchema` /
 * `commentIdParamSchema` in the two sibling modules.
 *
 * 15 is the widest run of decimal digits that always fits inside
 * `Number.MAX_SAFE_INTEGER` — 16 does not (`9007199254740993` is not
 * representable, and would silently round).
 *
 * It lives **here** rather than in `task.ts` because `task.ts` imports
 * `comment.ts`, so a constant in either of those cannot be shared with the
 * other without closing an import cycle. This module imports nothing, so both
 * can reach it. That is what makes the three parsers a single source of truth
 * instead of three regexes that happen to agree today: with the bound written
 * out separately, `/tasks/0000000000000000042` served task 42 while
 * `?q=0000000000000000042` matched nothing.
 */
export const TASK_ID_MAX_DIGITS = 15;

/** `42` → `"TASK-000042"`. Padding is a minimum, not a truncation: ids past 999999 render wider. */
export const formatReference = (id: number): string =>
  `${REFERENCE_PREFIX}${String(id).padStart(REFERENCE_PAD_LENGTH, "0")}`;

/**
 * Accepts `TASK-42`, `task-000042`, `#42`, and a bare `42`; returns the integer, or
 * `null` for anything else.
 *
 * The match is on the **whole** number, not a prefix: `TASK-4` resolves to task
 * 4, never to tasks 40–49. Prefix matching on an integer column would mean a
 * `CAST` and a full scan.
 */
const REFERENCE_PATTERN = new RegExp(`^(?:task-|#)?(\\d{1,${TASK_ID_MAX_DIGITS}})$`, "i");

export const parseReference = (input: string): number | null => {
  const match = REFERENCE_PATTERN.exec(input.trim());
  const digits = match?.[1];
  if (digits === undefined) return null;

  const id = Number.parseInt(digits, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};
