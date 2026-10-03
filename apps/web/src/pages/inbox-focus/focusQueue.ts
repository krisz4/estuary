import { ATTENTION_KINDS, type AttentionKind } from "@estuary/contracts";

/**
 * The pure half of focus mode: which item is on screen, and where Skip and
 * Previous go. Kept apart from the page so the ordering rules — the part that
 * is easy to get subtly wrong — are tested without rendering anything.
 *
 * ## Why a stable order, not the live list
 *
 * The inbox polls every 15s and sorts by priority, so the live list can
 * reshuffle under the reader: a new urgent item would push itself in front of
 * the one being read, and a cleared item leaves no trace of where it was. Focus
 * mode instead keeps the ids it has seen, in the order it first saw them
 * (`appendNew`), and treats the live list only as "which of these still wait".
 * New arrivals join at the end; a cleared item stays in the order as a gap, so
 * "the next one after it" is still well defined.
 */

/** `?kind=` — one attention kind, or every kind when absent or unrecognised. */
export const parseFocusKind = (raw: string | null): AttentionKind | null =>
  raw !== null && (ATTENTION_KINDS as readonly string[]).includes(raw)
    ? (raw as AttentionKind)
    : null;

/**
 * `order` with every id from `liveIds` it has not seen appended, in
 * `liveIds`' order. Returns `order` itself when nothing is new, so a caller
 * can compare by reference to decide whether to store it.
 */
export const appendNew = (
  order: readonly number[],
  liveIds: readonly number[],
): readonly number[] => {
  const seen = new Set(order);
  const fresh = liveIds.filter((id) => !seen.has(id));
  return fresh.length === 0 ? order : [...order, ...fresh];
};

/** The first still-waiting id after `index` in `order`, or `null`. */
const liveAfter = (order: readonly number[], live: ReadonlySet<number>, index: number) =>
  order.slice(index + 1).find((id) => live.has(id)) ?? null;

/** The last still-waiting id before `index` in `order`, or `null`. */
const liveBefore = (order: readonly number[], live: ReadonlySet<number>, index: number) =>
  order
    .slice(0, Math.max(index, 0))
    .reverse()
    .find((id) => live.has(id)) ?? null;

/**
 * The item to show. The cursor while it still waits; once it is cleared (by
 * this page, or anyone else), the next one after it — wrapping back to an
 * earlier, skipped one when it was the last — and `null` when nothing is left.
 */
export const resolveCurrent = (
  order: readonly number[],
  live: ReadonlySet<number>,
  cursor: number | null,
): number | null => {
  if (cursor !== null && live.has(cursor)) return cursor;
  const index = cursor === null ? -1 : order.indexOf(cursor);
  return liveAfter(order, live, index) ?? liveBefore(order, live, index);
};

export type FocusStep = {
  /** Where Skip goes, or `null` when this is the only item left. */
  next: number | null;
  /** Skip goes back to the start of what is left, past items already skipped. */
  nextWraps: boolean;
  /** Where Previous goes, or `null` at the first remaining item. Never wraps. */
  previous: number | null;
};

export const stepsFrom = (
  order: readonly number[],
  live: ReadonlySet<number>,
  current: number,
): FocusStep => {
  const index = order.indexOf(current);
  const after = liveAfter(order, live, index);
  const wrapped = after === null ? liveBefore(order, live, index) : null;
  // Wrapping lands on the *first* remaining item, not the one just before.
  const first = order.find((id) => live.has(id) && id !== current) ?? null;
  return {
    next: after ?? (wrapped === null ? null : first),
    nextWraps: after === null && wrapped !== null,
    previous: liveBefore(order, live, index),
  };
};

/** 1-based position of `current` among the items still waiting, in focus order. */
export const positionOf = (
  order: readonly number[],
  live: ReadonlySet<number>,
  current: number,
): number => order.slice(0, order.indexOf(current) + 1).filter((id) => live.has(id)).length;
