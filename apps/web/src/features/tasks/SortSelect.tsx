import { formatTaskSort, type TaskSort } from "@helpdesk/contracts";
import { Select } from "@/components/ui";

/**
 * The mobile sort control.
 *
 * Below `md` there is no table, so there are no column headers to click — this
 * is the only way to sort on a phone, not a convenience duplicate.
 *
 * The options are **named orderings**, not a field picker plus a direction
 * toggle. "Priority: high to low" is what a user is actually choosing;
 * `priority:desc` is how the API spells it, and the fact that the API sorts that
 * one by a rank column rather than alphabetically is exactly the sort of detail
 * a label should absorb.
 */

export const SORT_OPTIONS: { sort: TaskSort; label: string }[] = [
  { sort: { field: "createdAt", direction: "desc" }, label: "Newest first" },
  { sort: { field: "createdAt", direction: "asc" }, label: "Oldest first" },
  { sort: { field: "updatedAt", direction: "desc" }, label: "Recently updated" },
  { sort: { field: "priority", direction: "desc" }, label: "Priority: high to low" },
  { sort: { field: "priority", direction: "asc" }, label: "Priority: low to high" },
  { sort: { field: "status", direction: "asc" }, label: "Status: backlog first" },
  { sort: { field: "status", direction: "desc" }, label: "Status: closed first" },
  { sort: { field: "title", direction: "asc" }, label: "Title: A to Z" },
  { sort: { field: "title", direction: "desc" }, label: "Title: Z to A" },
  { sort: { field: "id", direction: "desc" }, label: "Reference: highest first" },
  { sort: { field: "id", direction: "asc" }, label: "Reference: lowest first" },
];

const OPTIONS = SORT_OPTIONS.map(({ sort, label }) => ({ value: formatTaskSort(sort), label }));

const BY_VALUE = new Map(SORT_OPTIONS.map(({ sort }) => [formatTaskSort(sort), sort]));

export type SortSelectProps = {
  sort: TaskSort;
  onSortChange: (sort: TaskSort) => void;
  className?: string;
};

export const SortSelect = ({ sort, onSortChange, className }: SortSelectProps) => {
  const value = formatTaskSort(sort);

  return (
    <Select
      // A hand-edited `?sort=title:desc` is valid but need not be in the list;
      // falling back to `undefined` shows the placeholder rather than silently
      // rewriting the user's URL to something else.
      options={OPTIONS}
      value={BY_VALUE.has(value) ? value : undefined}
      onValueChange={(next) => {
        const parsed = BY_VALUE.get(next);
        if (parsed !== undefined) onSortChange(parsed);
      }}
      placeholder="Sort"
      aria-label="Sort tasks"
      className={className}
    />
  );
};
