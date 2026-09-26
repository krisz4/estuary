import {
  HUMAN_ATTENTION_STATUSES,
  actorKindOf,
  formatReference,
  TASK_Q_MAX,
  TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  type TaskFacets,
  type TaskSort,
  type TaskStatus,
} from "@helpdesk/contracts";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  ACTOR_KIND_LABELS,
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  actorDisplayName,
  formatDateOnly,
  priorityOptions,
  statusOptions,
} from "@/lib/formatting";
import { SortSelect } from "@/features/tasks/SortSelect";
import {
  type TaskListFilterPatch,
  type TaskListFilters,
  type TaskListParams,
} from "@/pages/tasks-list/useTaskListParams";

/**
 * Search, filters, and (on mobile) sort.
 *
 * Three things here are load-bearing rather than stylistic:
 *
 * 1. **`q` is debounced 300ms and written with `replace`.** Typing "printer"
 *    otherwise issues seven requests and pushes seven history entries, so Back
 *    walks backwards one keystroke at a time instead of leaving the search.
 * 2. **Assignee is one control, not a select plus an "unassigned" toggle.**
 *    `assignee` and `assigneeIsNull` are mutually exclusive on the wire — two
 *    controls make the 422 reachable by clicking, one makes it unrepresentable.
 *    Its options — like the project and creator options — come from
 *    `GET /tasks/facets`, which is what makes the server's case-sensitive
 *    exact match safe (`equals` in SQLite is case-sensitive and Prisma's
 *    connector has no `mode: "insensitive"`).
 * 3. **Below `md` the controls move into a sheet**, behind a Filters button
 *    carrying a count. Seven controls stacked above the list on a 360px screen
 *    push the tasks themselves below the fold.
 */

export const SEARCH_DEBOUNCE_MS = 300;

/* ------------------------------------------------------------------ *
 * Assignee encoding
 *
 * The select's value space is strings, and two of the four choices are not
 * assignee names at all. Real names are prefixed so a person called
 * "unassigned" cannot collide with the sentinel — the same reason the API has
 * `assigneeIsNull` instead of `assignee=none`.
 * ------------------------------------------------------------------ */

export const ASSIGNEE_ANY = "any";
export const ASSIGNEE_NONE = "unassigned";
export const ASSIGNEE_SOMEONE = "assigned";
export const ASSIGNEE_NAME_PREFIX = "name:";

export const encodeAssignee = (params: TaskListParams): string => {
  if (params.assignee !== undefined) return `${ASSIGNEE_NAME_PREFIX}${params.assignee}`;
  if (params.assigneeIsNull === true) return ASSIGNEE_NONE;
  if (params.assigneeIsNull === false) return ASSIGNEE_SOMEONE;
  return ASSIGNEE_ANY;
};

export const decodeAssignee = (value: string): Partial<TaskListFilters> => {
  if (value.startsWith(ASSIGNEE_NAME_PREFIX)) {
    return { assignee: value.slice(ASSIGNEE_NAME_PREFIX.length), assigneeIsNull: undefined };
  }
  if (value === ASSIGNEE_NONE) return { assignee: undefined, assigneeIsNull: true };
  if (value === ASSIGNEE_SOMEONE) return { assignee: undefined, assigneeIsNull: false };
  return { assignee: undefined, assigneeIsNull: undefined };
};

/* ------------------------------------------------------------------ *
 * Creator and status presets
 * ------------------------------------------------------------------ */

/**
 * Creator values are whole actor strings (`agent:claude-code`), which always
 * contain a colon — so the "anyone" sentinel cannot collide with one.
 */
export const CREATOR_ANY = "any";

/** `agent:claude-code` → `claude-code (agent)`: the name first, the kind as a qualifier. */
export const creatorLabel = (actor: string): string =>
  `${actorDisplayName(actor)} (${ACTOR_KIND_LABELS[actorKindOf(actor)].toLowerCase()})`;

/**
 * Every status except the closed lane — "what is still live". The quick
 * filter that replaced the helpdesk's default "open" chip: with ten statuses,
 * ticking seven by hand is not a filter anyone would use.
 */
export const OPEN_STATUSES: readonly TaskStatus[] = TASK_STATUSES.filter(
  (status) => !(TERMINAL_TASK_STATUSES as readonly TaskStatus[]).includes(status),
);

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((entry) => b.includes(entry));

/**
 * A one-click status selection. A toggle: pressed when the selection is
 * exactly its set, and pressing it again clears the status filter.
 */
const StatusPreset = ({
  label,
  statuses,
  selected,
  onSelect,
}: {
  label: string;
  statuses: readonly TaskStatus[];
  selected: readonly TaskStatus[];
  onSelect: (statuses: TaskStatus[]) => void;
}) => {
  const isActive = sameSet(statuses, selected);
  return (
    <button
      type="button"
      aria-pressed={isActive}
      onClick={() => onSelect(isActive ? [] : [...statuses])}
      className={cn(
        "rounded px-1.5 py-0.5 text-xs font-normal transition-colors",
        isActive
          ? "bg-primary-subtle text-primary-subtle-foreground"
          : "text-primary hover:underline",
      )}
    >
      {label}
    </button>
  );
};

/* ------------------------------------------------------------------ *
 * Chip group
 * ------------------------------------------------------------------ */

/** `["open"]` + `"closed"` → `["open","closed"]`; applied again, back to `["open"]`. */
export const toggleValue = <TValue extends string>(
  current: readonly TValue[],
  value: TValue,
): TValue[] =>
  current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value];

/**
 * A multi-select rendered as checkbox chips.
 *
 * Real `<input type="checkbox">` elements inside `<label>`s, visually hidden and
 * styled through `peer-checked`. A row of `<button aria-pressed>` would look
 * identical and lose the group semantics: a screen reader announces this as a
 * named group of checkboxes with a count, which is what "filter by several
 * statuses" actually is.
 *
 * **It reports which value was toggled, not what the new array should be.** The
 * array it can see is the one from its last render, so computing the next array
 * here would bake in a snapshot: two chips clicked inside one frame would both
 * derive from the same starting array and the second would erase the first. Who
 * holds the current state decides — this component only knows what was clicked.
 */
export const ChipGroup = <TValue extends string>({
  legend,
  options,
  selected,
  onToggle,
  presets,
}: {
  legend: string;
  options: readonly { value: TValue; label: string }[];
  selected: TValue[];
  onToggle: (value: TValue) => void;
  /** One-click selections rendered beside the legend ("Open work", "Needs you"). */
  presets?: ReactNode;
}) => (
  <fieldset className="flex flex-col gap-1.5">
    <legend className="mb-1 text-xs font-medium text-muted-foreground">{legend}</legend>
    {/* Outside the legend, so the group's accessible name stays "Status". */}
    {presets === undefined ? null : <div className="-mt-1 flex flex-wrap gap-2">{presets}</div>}
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const isSelected = selected.includes(option.value);
        return (
          <label key={option.value} className="cursor-pointer">
            <input
              type="checkbox"
              className="peer sr-only"
              checked={isSelected}
              onChange={() => onToggle(option.value)}
            />
            <span
              className={cn(
                "inline-flex items-center rounded-full border border-border px-2.5 py-1",
                "text-xs whitespace-nowrap transition-colors",
                "peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring",
                isSelected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-card text-muted-foreground hover:bg-muted",
              )}
            >
              {option.label}
            </span>
          </label>
        );
      })}
    </div>
  </fieldset>
);

/* ------------------------------------------------------------------ *
 * Search box
 * ------------------------------------------------------------------ */

const SearchInput = ({
  value,
  onCommit,
}: {
  value: string | undefined;
  onCommit: (next: string | undefined) => void;
}) => {
  const id = useId();
  const [text, setText] = useState(value ?? "");

  /**
   * The last value this component *put into* the URL, in the form the URL holds
   * it — **trimmed**.
   *
   * It is what separates "the user typed" from "the URL changed underneath us"
   * — a Back press, or Clear all. Without it, either the effect below fights the
   * user's keystrokes or Back leaves stale text sitting in the box describing a
   * search that is no longer applied.
   *
   * Storing the untrimmed text here instead is a real bug, not a tidiness point:
   * commit `"foo "`, and the URL comes back `"foo"`, which no longer equals what
   * we recorded — so the sync effect below decides the URL moved on its own and
   * rewrites the input *while the user is still typing in it*. Typing `foo ` and
   * then `bar` produced `foobar` and searched for the wrong term. Both sides of
   * every comparison are therefore trimmed.
   */
  const committed = useRef((value ?? "").trim());

  useEffect(() => {
    const next = (value ?? "").trim();
    if (next === committed.current) return;
    committed.current = next;
    setText(next);
  }, [value]);

  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === committed.current) return;

    const timer = setTimeout(() => {
      committed.current = trimmed;
      onCommit(trimmed === "" ? undefined : trimmed);
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [text, onCommit]);

  return (
    <div className="relative flex-1">
      <label htmlFor={id} className="sr-only">
        Search tasks
      </label>
      <Search
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        id={id}
        type="search"
        value={text}
        maxLength={TASK_Q_MAX}
        onChange={(event) => setText(event.target.value)}
        placeholder="Search title, description, comments, or TASK-000042…"
        title='Every word must match somewhere on the task. Quote a phrase to search it as one term, e.g. "rate limit".'
        className="pl-9"
      />
    </div>
  );
};

/* ------------------------------------------------------------------ *
 * The bar
 * ------------------------------------------------------------------ */

export type TaskFilterBarProps = {
  params: TaskListParams;
  facets: TaskFacets | undefined;
  onFiltersChange: (patch: TaskListFilterPatch, options?: { replace?: boolean }) => void;
  onSortChange: (sort: TaskSort) => void;
  onClear: () => void;
  activeFilterCount: number;
  /** `true` at `md` and up: controls sit inline. Below, they live in a sheet. */
  isWide: boolean;
};

export const TaskFilterBar = ({
  params,
  facets,
  onFiltersChange,
  onSortChange,
  onClear,
  activeFilterCount,
  isWide,
}: TaskFilterBarProps) => {
  const [sheetOpen, setSheetOpen] = useState(false);

  // Stable, so the debounce effect is not torn down and rebuilt on every render
  // of the parent — which would restart the 300ms timer and never fire it.
  const commitSearch = useCallback(
    (next: string | undefined) => onFiltersChange({ q: next }, { replace: true }),
    [onFiltersChange],
  );

  const controls = (
    <FilterControls params={params} facets={facets} onFiltersChange={onFiltersChange} />
  );

  return (
    <div className="flex flex-col gap-3">
      {/*
        The search box gets its own line below `sm`: sharing 360px with the
        Filters button and the sort select squeezed it to about five characters.
      */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <SearchInput value={params.q} onCommit={commitSearch} />

        {isWide ? null : (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => setSheetOpen(true)}
              aria-label={
                activeFilterCount === 0 ? "Filters" : `Filters, ${activeFilterCount} active`
              }
            >
              <SlidersHorizontal aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">Filters</span>
              {activeFilterCount > 0 ? (
                <span className="ml-1 rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
                  {activeFilterCount}
                </span>
              ) : null}
            </Button>

            <SortSelect sort={params.sort} onSortChange={onSortChange} className="w-auto flex-1" />
          </div>
        )}
      </div>

      {isWide ? (
        <div className="rounded-lg border border-border bg-card p-3 shadow-raised">{controls}</div>
      ) : (
        <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Filters</DialogTitle>
            </DialogHeader>
            {controls}
            <div className="flex gap-2 pt-2">
              <Button variant="outline" className="flex-1" onClick={onClear}>
                Clear all
              </Button>
              <Button className="flex-1" onClick={() => setSheetOpen(false)}>
                Show results
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      <ActiveFilterChips params={params} onFiltersChange={onFiltersChange} onClear={onClear} />
    </div>
  );
};

/* ------------------------------------------------------------------ *
 * The controls themselves — rendered inline or inside the sheet, never both
 * ------------------------------------------------------------------ */

const FilterControls = ({
  params,
  facets,
  onFiltersChange,
}: {
  params: TaskListParams;
  facets: TaskFacets | undefined;
  onFiltersChange: (patch: TaskListFilterPatch) => void;
}) => {
  const fromId = useId();
  const toId = useId();

  /*
    Labels exist only as values on tasks, so the chips are the facets — plus any
    label already selected in the URL, so a filter from a shared link stays
    visible and removable before (or without) the facets loading.

    No project chips: project is the header's `ProjectSwitcher`, the one place
    it is picked, rather than a second control for the same param here.
  */
  const labels = [...new Set([...(facets?.labels ?? []), ...params.label])]
    .sort()
    .map((value) => ({ value, label: value }));

  const assigneeOptions = [
    { value: ASSIGNEE_ANY, label: "Anyone" },
    { value: ASSIGNEE_NONE, label: "Unassigned" },
    { value: ASSIGNEE_SOMEONE, label: "Assigned to anyone" },
    ...(facets?.assignees ?? []).map((name) => ({
      value: `${ASSIGNEE_NAME_PREFIX}${name}`,
      label: name,
    })),
  ];

  const creators = [
    ...new Set([
      ...(facets?.creators ?? []),
      ...(params.createdBy === undefined ? [] : [params.createdBy]),
    ]),
  ];
  const creatorOptions = [
    { value: CREATOR_ANY, label: "Anyone" },
    ...creators.map((actor) => ({ value: actor, label: creatorLabel(actor) })),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:flex-wrap lg:gap-6">
        <ChipGroup
          legend="Status"
          options={statusOptions}
          selected={params.status}
          onToggle={(value) =>
            onFiltersChange((current) => ({ status: toggleValue(current.status, value) }))
          }
          presets={
            <>
              <StatusPreset
                label="Open work"
                statuses={OPEN_STATUSES}
                selected={params.status}
                onSelect={(status) => onFiltersChange({ status })}
              />
              <StatusPreset
                label="Needs you"
                statuses={HUMAN_ATTENTION_STATUSES}
                selected={params.status}
                onSelect={(status) => onFiltersChange({ status })}
              />
            </>
          }
        />
        <ChipGroup
          legend="Priority"
          options={priorityOptions}
          selected={params.priority}
          onToggle={(value) =>
            onFiltersChange((current) => ({ priority: toggleValue(current.priority, value) }))
          }
        />
        {labels.length === 0 ? null : (
          <ChipGroup
            legend="Label"
            options={labels}
            selected={params.label}
            onToggle={(value) =>
              onFiltersChange((current) => ({ label: toggleValue(current.label, value) }))
            }
          />
        )}
      </div>

      <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={params.parentIsNull === true}
          onChange={(event) =>
            onFiltersChange({ parentIsNull: event.target.checked ? true : undefined })
          }
          className="size-4 rounded border-input accent-primary"
        />
        Top-level only
        <span className="text-xs text-muted-foreground">(hide subtasks)</span>
      </label>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Assignee</span>
          <Select
            options={assigneeOptions}
            value={encodeAssignee(params)}
            onValueChange={(value) => onFiltersChange(decodeAssignee(value))}
            aria-label="Filter by assignee"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Created by</span>
          <Select
            options={creatorOptions}
            value={params.createdBy ?? CREATOR_ANY}
            onValueChange={(value) =>
              onFiltersChange({ createdBy: value === CREATOR_ANY ? undefined : value })
            }
            aria-label="Filter by creator"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={fromId} className="text-xs font-medium text-muted-foreground">
            Created from (UTC)
          </label>
          <Input
            id={fromId}
            type="date"
            value={params.createdFrom ?? ""}
            max={params.createdTo}
            onChange={(event) =>
              onFiltersChange({
                createdFrom: event.target.value === "" ? undefined : event.target.value,
              })
            }
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={toId} className="text-xs font-medium text-muted-foreground">
            Created to (UTC)
          </label>
          <Input
            id={toId}
            type="date"
            value={params.createdTo ?? ""}
            min={params.createdFrom}
            onChange={(event) =>
              onFiltersChange({
                createdTo: event.target.value === "" ? undefined : event.target.value,
              })
            }
          />
        </div>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ *
 * Active filter chips
 * ------------------------------------------------------------------ */

/**
 * `clear` is a function of the current state for the same reason `ChipGroup`
 * reports a value rather than an array: removing one status out of three is
 * derived from the other two, and deriving them at render time snapshots them.
 */
type ActiveChip = {
  key: string;
  label: string;
  clear: (current: TaskListParams) => Partial<TaskListFilters>;
};

/** Every active filter as one removable chip, in a stable order. */
export const activeFilterChips = (params: TaskListParams): ActiveChip[] => {
  const chips: ActiveChip[] = [];

  if (params.q !== undefined) {
    chips.push({ key: "q", label: `Search: ${params.q}`, clear: () => ({ q: undefined }) });
  }
  for (const value of params.status) {
    chips.push({
      key: `status:${value}`,
      label: `Status: ${TASK_STATUS_LABELS[value]}`,
      clear: (current) => ({ status: current.status.filter((entry) => entry !== value) }),
    });
  }
  for (const value of params.priority) {
    chips.push({
      key: `priority:${value}`,
      label: `Priority: ${TASK_PRIORITY_LABELS[value]}`,
      clear: (current) => ({ priority: current.priority.filter((entry) => entry !== value) }),
    });
  }
  for (const value of params.label) {
    chips.push({
      key: `label:${value}`,
      label: `Label: ${value}`,
      clear: (current) => ({ label: current.label.filter((entry) => entry !== value) }),
    });
  }
  if (params.assignee !== undefined) {
    chips.push({
      key: "assignee",
      label: `Assignee: ${params.assignee}`,
      clear: () => ({ assignee: undefined }),
    });
  }
  if (params.assigneeIsNull !== undefined) {
    chips.push({
      key: "assigneeIsNull",
      label: params.assigneeIsNull ? "Unassigned" : "Assigned to anyone",
      clear: () => ({ assigneeIsNull: undefined }),
    });
  }
  if (params.createdBy !== undefined) {
    chips.push({
      key: "createdBy",
      label: `Created by: ${creatorLabel(params.createdBy)}`,
      clear: () => ({ createdBy: undefined }),
    });
  }
  if (params.createdFrom !== undefined) {
    chips.push({
      key: "createdFrom",
      label: `From ${formatDateOnly(params.createdFrom)}`,
      clear: () => ({ createdFrom: undefined }),
    });
  }
  if (params.createdTo !== undefined) {
    chips.push({
      key: "createdTo",
      label: `To ${formatDateOnly(params.createdTo)}`,
      clear: () => ({ createdTo: undefined }),
    });
  }
  if (params.parentId !== undefined) {
    chips.push({
      key: "parentId",
      label: `Subtasks of ${formatReference(params.parentId)}`,
      clear: () => ({ parentId: undefined }),
    });
  }
  if (params.parentIsNull !== undefined) {
    chips.push({
      key: "parentIsNull",
      label: params.parentIsNull ? "Top-level only" : "Subtasks only",
      clear: () => ({ parentIsNull: undefined }),
    });
  }
  if (params.dependsOn !== undefined) {
    chips.push({
      key: "dependsOn",
      label: `Depends on ${formatReference(params.dependsOn)}`,
      clear: () => ({ dependsOn: undefined }),
    });
  }
  if (params.dependencyOf !== undefined) {
    chips.push({
      key: "dependencyOf",
      label: `Blocks ${formatReference(params.dependencyOf)}`,
      clear: () => ({ dependencyOf: undefined }),
    });
  }

  return chips;
};

const ActiveFilterChips = ({
  params,
  onFiltersChange,
  onClear,
}: {
  params: TaskListParams;
  onFiltersChange: (patch: TaskListFilterPatch) => void;
  onClear: () => void;
}) => {
  const chips = activeFilterChips(params);
  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          onClick={() => onFiltersChange((current) => chip.clear(current))}
          aria-label={`Remove filter: ${chip.label}`}
          className={cn(
            "inline-flex max-w-full items-center gap-1 rounded-full border border-border",
            "bg-muted px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-neutral-subtle",
          )}
        >
          <span className="truncate">{chip.label}</span>
          <X className="size-3 shrink-0 opacity-60" aria-hidden="true" />
        </button>
      ))}

      <Button variant="ghost" size="sm" onClick={onClear}>
        Clear all
      </Button>
    </div>
  );
};
