import { type PaginationMeta } from "@helpdesk/contracts";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button, Select } from "@/components/ui";
import { cn } from "@/lib/cn";

/**
 * Pager for an enveloped list response.
 *
 * Takes `meta` straight from the API rather than recomputing page counts from
 * `total` and `pageSize`: `buildPaginationMeta` already decided that an empty
 * result has `totalPages: 1` (so the pager never says "Page 1 of 0") and that
 * `hasNextPage` is `page < totalPages` (so it is correctly `false` on an
 * over-the-end page). A second copy of that arithmetic here would be a second
 * chance to get it wrong.
 *
 * Lives in `components/` rather than `features/tasks/` because it knows
 * nothing about tasks — only about `PaginationMeta` and two callbacks.
 */

export const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;

const ELLIPSIS = "ellipsis" as const;

/**
 * The page buttons to render: always first and last, always the current page and
 * its neighbours, `…` for the gaps.
 *
 * `1 … 4 5 6 … 9`. The gap is only collapsed when it hides **more than one**
 * page — replacing a single page number with an ellipsis of the same width is a
 * strictly worse button.
 */
export const paginationRange = (
  page: number,
  totalPages: number,
  siblings = 1,
): (number | typeof ELLIPSIS)[] => {
  const first = 1;
  const last = totalPages;

  const start = Math.max(first, page - siblings);
  const end = Math.min(last, page + siblings);

  const pages = new Set<number>([first, last]);
  for (let index = start; index <= end; index += 1) pages.add(index);

  const sorted = [...pages]
    .filter((value) => value >= first && value <= last)
    .sort((a, b) => a - b);

  const range: (number | typeof ELLIPSIS)[] = [];
  let previous: number | undefined;
  for (const value of sorted) {
    if (previous !== undefined) {
      if (value - previous === 2) range.push(previous + 1);
      else if (value - previous > 2) range.push(ELLIPSIS);
    }
    range.push(value);
    previous = value;
  }
  return range;
};

export type PaginationProps = {
  meta: PaginationMeta;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  /** The noun in "Showing 1–20 of 63 tasks". */
  itemLabel?: { singular: string; plural: string };
  className?: string;
};

export const Pagination = ({
  meta,
  onPageChange,
  onPageSizeChange,
  itemLabel = { singular: "task", plural: "tasks" },
  className,
}: PaginationProps) => {
  const { page, pageSize, total, totalPages, hasNextPage, hasPrevPage } = meta;

  const firstShown = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastShown = Math.min(page * pageSize, total);
  const noun = total === 1 ? itemLabel.singular : itemLabel.plural;
  /**
   * `?page=9` against a 4-page result is a legal request the API answers with an
   * empty page, so the pager has to have something sensible to say. Without this
   * branch the arithmetic reads "Showing 161–63 of 63" — a range running
   * backwards, which looks like a rendering bug rather than a URL past the end.
   */
  const isPastEnd = total > 0 && firstShown > total;

  const sizeOptions = [...new Set<number>([...PAGE_SIZE_OPTIONS, pageSize])]
    .sort((a, b) => a - b)
    .map((value) => ({ value: String(value), label: `${value} per page` }));

  return (
    <nav
      aria-label="Pagination"
      className={cn(
        "flex flex-col gap-3 border-t border-border pt-4",
        "sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <p className="text-xs text-muted-foreground">
        {total === 0
          ? `No ${itemLabel.plural}`
          : isPastEnd
            ? `Page ${page} is past the end — ${total.toLocaleString()} ${noun} on ${totalPages} ${totalPages === 1 ? "page" : "pages"}`
            : `Showing ${firstShown}–${lastShown} of ${total.toLocaleString()} ${noun}`}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          options={sizeOptions}
          value={String(pageSize)}
          onValueChange={(value) => onPageSizeChange(Number(value))}
          aria-label="Tasks per page"
          className="h-8 w-auto min-w-[8.5rem] text-xs"
        />

        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            aria-label="Previous page"
            disabled={!hasPrevPage}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>

          {paginationRange(page, totalPages).map((entry, index) =>
            entry === ELLIPSIS ? (
              <span
                // An ellipsis has no identity beyond its position, and the range
                // is recomputed wholesale on every page change.
                key={`gap-${index}`}
                className="px-1 text-xs text-muted-foreground"
                aria-hidden="true"
              >
                …
              </span>
            ) : (
              <Button
                key={entry}
                variant={entry === page ? "primary" : "outline"}
                size="icon"
                className="size-8 text-xs"
                aria-label={`Page ${entry}`}
                aria-current={entry === page ? "page" : undefined}
                onClick={() => onPageChange(entry)}
              >
                {entry}
              </Button>
            ),
          )}

          <Button
            variant="outline"
            size="icon"
            className="size-8"
            aria-label="Next page"
            disabled={!hasNextPage}
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      </div>
    </nav>
  );
};
