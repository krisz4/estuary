import { z } from "zod";

export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 20;
export const MIN_PAGE_SIZE = 1;
/** Values above this are **rejected**, not clamped — clamping hides a client bug. */
export const MAX_PAGE_SIZE = 100;
/**
 * Upper bound on `page`. Chosen so `(MAX_PAGE - 1) * MAX_PAGE_SIZE` stays inside
 * Int32, which is the width of Prisma's `skip` in the query engine. Without it a
 * URL like `?page=99999999999` overflows and 500s, instead of returning the
 * documented empty page with correct `meta`.
 */
export const MAX_PAGE = 1_000_000;

export const paginationMetaSchema = z
  .object({
    page: z.number().int().min(1),
    pageSize: z.number().int().min(MIN_PAGE_SIZE).max(MAX_PAGE_SIZE),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().min(1),
    hasNextPage: z.boolean(),
    hasPrevPage: z.boolean(),
  })
  .strict();
export type PaginationMeta = z.infer<typeof paginationMetaSchema>;

/**
 * Builds the `meta` block for a list response.
 *
 * `totalPages` is `Math.max(1, ceil(total / pageSize))` so an empty result still
 * reports one page — otherwise the pager renders "Page 1 of 0". `hasNextPage` is
 * `page < totalPages`, which makes it correctly `false` on an over-the-end page
 * rather than "there might be more".
 */
export const buildPaginationMeta = ({
  page,
  pageSize,
  total,
}: {
  page: number;
  pageSize: number;
  total: number;
}): PaginationMeta => {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return {
    page,
    pageSize,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  };
};

/**
 * `{ data, meta }` for a given row schema. List responses are always enveloped;
 * single-resource responses return the object directly.
 */
export const paginatedSchema = <TItem extends z.ZodType>(item: TItem) =>
  z
    .object({
      data: z.array(item),
      meta: paginationMetaSchema,
    })
    .strict();

export type Paginated<TItem> = {
  data: TItem[];
  meta: PaginationMeta;
};
