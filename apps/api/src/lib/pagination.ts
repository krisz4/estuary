import { buildPaginationMeta, type Paginated, type PaginationMeta } from "@helpdesk/contracts";

/**
 * Offset paging helpers.
 *
 * The `meta` **shape and its arithmetic live in `packages/contracts`**
 * (`buildPaginationMeta`) — the web pager derives its state from the same
 * function, so a second copy here would be exactly the hand-written duplicate
 * checklist rule #1 in `CLAUDE.md` forbids. What this module adds is the part
 * that is server-only: turning a validated `{ page, pageSize }` into Prisma's
 * `skip`/`take`, and assembling the envelope around a page of rows.
 *
 * Two properties of `buildPaginationMeta` that callers depend on, restated here
 * because they are the two most commonly re-broken:
 *
 * - `totalPages` is `Math.max(1, ceil(total / pageSize))`, never `0`, so an
 *   empty result does not render as "Page 1 of 0".
 * - `hasNextPage` is `page < totalPages`, so an over-the-end page reports
 *   `false` rather than "there might be more".
 *
 * See `docs/features/Task_Query_Filter_Sort_Page.md` § Response envelope.
 */

export interface PageRequest {
  page: number;
  pageSize: number;
}

/**
 * `{ page, pageSize }` → Prisma's `{ skip, take }`.
 *
 * `page` is bounded by `MAX_PAGE` in the query schema, which is what keeps
 * `skip` inside the Int32 the query engine expects. This function trusts that
 * bound rather than re-checking it: a clamp here would turn a nonsense page into
 * a silently different page, which is the same class of bug as clamping
 * `pageSize`.
 */
export const toSkipTake = ({ page, pageSize }: PageRequest): { skip: number; take: number } => ({
  skip: (page - 1) * pageSize,
  take: pageSize,
});

/**
 * Wraps a page of already-serialized rows in the standard `{ data, meta }`
 * envelope. `total` is the count of rows matching the filter, **not** the length
 * of `rows`.
 */
export const paginate = <TItem>(
  rows: TItem[],
  { page, pageSize, total }: PageRequest & { total: number },
): Paginated<TItem> => ({
  data: rows,
  meta: buildPaginationMeta({ page, pageSize, total }),
});

export { buildPaginationMeta };
export type { Paginated, PaginationMeta };
