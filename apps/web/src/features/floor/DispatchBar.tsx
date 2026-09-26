import { TASK_Q_MAX, type TaskFacets } from "@helpdesk/contracts";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { forwardRef, useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Popover,
  Select,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatDateOnly, priorityOptions } from "@/lib/formatting";
import {
  ASSIGNEE_ANY,
  ASSIGNEE_NAME_PREFIX,
  ASSIGNEE_NONE,
  ASSIGNEE_SOMEONE,
  ChipGroup,
  CREATOR_ANY,
  SEARCH_DEBOUNCE_MS,
  activeFilterChips,
  creatorLabel,
  decodeAssignee,
  encodeAssignee,
  toggleValue,
} from "@/features/tasks/TaskFilterBar";
import {
  MAP_GROUP_BY_VALUES,
  FLOOR_LINKS_MODES,
  type MapGroupBy,
  type FloorLinksMode,
  type FloorMatchMode,
  type FloorOnlyParams,
  type FloorParams,
} from "@/pages/tasks-map/useFloorParams";
import {
  type TaskListFilterPatch,
  type TaskListParams,
} from "@/pages/tasks-list/useTaskListParams";
import { FLOOR_SHIPPED_WINDOWS, type FloorShippedWindow } from "@helpdesk/contracts";

/**
 * The Map's Dispatch bar — a **compact, one row** filter bar at `md` and up,
 * unlike the list page's full `TaskFilterBar` panel. Below `md` it collapses
 * further, to `[search] [Filters (n)]`, opening a bottom sheet with
 * everything else (`compact` prop) — five rows of controls above the canvas
 * on a phone was the second visual-QA finding this replaced (the first was
 * the list page's always-open panel, which is what the one-row layout itself
 * already fixed).
 *
 * **No status chips here.** Status filtering happens on the map itself — the
 * station pins and the briefing's tiles — so `activeFilterChips` is filtered
 * to drop the `status:*` entries before rendering.
 *
 * Reuses `TaskFilterBar`'s pure pieces (`ChipGroup`, the assignee/creator
 * encoding, `activeFilterChips`) rather than duplicating that logic — the list
 * page's `TaskFilterBar` itself is untouched.
 */

export const BELTS_LABELS: Record<MapGroupBy, string> = {
  project: "By project",
  none: "One belt",
  epic: "By epic",
  chain: "By chain",
  agent: "By agent",
  label: "By label",
};

export const LINKS_LABELS: Record<FloorLinksMode, string> = {
  focus: "Focused task only",
  blocking: "Blocking only",
  all: "All",
  off: "Off",
};

/** Ref-forwarded so the page can focus it on `/`. */
export const DispatchSearchInput = forwardRef<
  HTMLInputElement,
  {
    value: string | undefined;
    onCommit: (next: string | undefined) => void;
    className?: string;
    autoFocus?: boolean;
    /** The narrow toolbar's icon-that-expands: collapse back to the icon on blur when there's nothing typed. */
    onBlurEmpty?: () => void;
  }
>(function DispatchSearchInput({ value, onCommit, className, autoFocus, onBlurEmpty }, ref) {
  const id = useId();
  const [text, setText] = useState(value ?? "");
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
    <div className={cn("relative w-44 shrink-0 sm:w-56", className)}>
      <label htmlFor={id} className="sr-only">
        Search tasks
      </label>
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        ref={ref}
        id={id}
        type="search"
        value={text}
        maxLength={TASK_Q_MAX}
        onChange={(event) => setText(event.target.value)}
        placeholder="Search… (/)"
        className="pl-8"
        autoFocus={autoFocus}
        onBlur={onBlurEmpty === undefined ? undefined : () => {
          if (text.trim() === "") onBlurEmpty();
        }}
      />
    </div>
  );
});

export type DispatchBarProps = {
  params: FloorParams;
  facets: TaskFacets | undefined;
  onFiltersChange: (patch: TaskListFilterPatch, options?: { replace?: boolean }) => void;
  onClear: () => void;
  activeFilterCount: number;
  onSetGroup: (group: MapGroupBy | undefined) => void;
  onSetLinks: (links: FloorLinksMode) => void;
  onSetMatch: (match: FloorMatchMode) => void;
  onSetShipped: (shipped: FloorShippedWindow) => void;
  onApplyPreset: (patch: Partial<FloorOnlyParams>) => void;
  groupValue: MapGroupBy;
  isNeedsMeActive: boolean;
  onToggleNeedsMe: () => void;
  searchInputRef?: React.Ref<HTMLInputElement>;
  /** Below `md` — collapses to search + a "Filters" button opening a bottom sheet. Ignored when `toolbar` is set. */
  compact?: boolean;
  /**
   * The hero's map-card toolbar row: search, then two **separate** popover
   * buttons — "Filters" (priority/labels/assignee/created by/more) and "View"
   * (group/links/non-matching/shipped + the presets) — instead of the
   * `compact` mode's one combined sheet. No outer card chrome: the hero
   * supplies the toolbar row itself, above the canvas.
   */
  toolbar?: boolean;
  /**
   * `toolbar`'s own narrow layout, below `sm` (640px): the persistent search
   * field and the split Filters/View popovers don't fit the hero's toolbar
   * row at phone widths (`scrollWidth` > viewport was the actual bug) — this
   * collapses to an icon-only search that expands on tap, and one "Filters"
   * button whose sheet folds the View controls back in (the same combined
   * sheet `compact` uses).
   */
  narrow?: boolean;
};

export const DispatchBar = ({
  params,
  facets,
  onFiltersChange,
  onClear,
  activeFilterCount,
  onSetGroup,
  onSetLinks,
  onSetMatch,
  onSetShipped,
  onApplyPreset,
  groupValue,
  isNeedsMeActive,
  onToggleNeedsMe,
  searchInputRef,
  compact = false,
  toolbar = false,
  narrow = false,
}: DispatchBarProps) => {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const commitSearch = useCallback(
    (next: string | undefined) => onFiltersChange({ q: next }, { replace: true }),
    [onFiltersChange],
  );

  const labels = [...new Set([...(facets?.labels ?? []), ...params.label])].sort().map((value) => ({
    value,
    label: value,
  }));
  const assigneeOptions = [
    { value: ASSIGNEE_ANY, label: "Anyone" },
    { value: ASSIGNEE_NONE, label: "Unassigned" },
    { value: ASSIGNEE_SOMEONE, label: "Assigned to anyone" },
    ...(facets?.assignees ?? []).map((name) => ({ value: `${ASSIGNEE_NAME_PREFIX}${name}`, label: name })),
  ];
  const creators = [
    ...new Set([...(facets?.creators ?? []), ...(params.createdBy === undefined ? [] : [params.createdBy])]),
  ];
  const creatorOptions = [
    { value: CREATOR_ANY, label: "Anyone" },
    ...creators.map((actor) => ({ value: actor, label: creatorLabel(actor) })),
  ];

  // No status chips on the floor — status is filtered from the canvas rail
  // and the shift report, never from a chip here.
  const chips = activeFilterChips(params).filter((chip) => !chip.key.startsWith("status:"));

  const priorityField = (
    <ChipGroup
      legend="Priority"
      options={priorityOptions}
      selected={params.priority}
      onToggle={(value) =>
        onFiltersChange((current: TaskListParams) => ({ priority: toggleValue(current.priority, value) }))
      }
    />
  );

  const labelsField =
    labels.length === 0 ? null : (
      <ChipGroup
        legend="Label"
        options={labels}
        selected={params.label}
        onToggle={(value) => onFiltersChange((current: TaskListParams) => ({ label: toggleValue(current.label, value) }))}
      />
    );

  const assigneeField = (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">Assignee</span>
      <Select
        options={assigneeOptions}
        value={encodeAssignee(params)}
        onValueChange={(value) => onFiltersChange(decodeAssignee(value))}
        aria-label="Filter by assignee"
      />
    </div>
  );

  const createdByField = (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">Created by</span>
      <Select
        options={creatorOptions}
        value={params.createdBy ?? CREATOR_ANY}
        onValueChange={(value) => onFiltersChange({ createdBy: value === CREATOR_ANY ? undefined : value })}
        aria-label="Filter by creator"
      />
    </div>
  );

  const moreFields = (
    <div className="flex flex-col gap-3">
      <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={params.parentIsNull === true}
          onChange={(event) => onFiltersChange({ parentIsNull: event.target.checked ? true : undefined })}
          className="size-4 rounded border-input accent-primary"
        />
        Top-level only
      </label>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Created from (UTC)</span>
        <Input
          type="date"
          value={params.createdFrom ?? ""}
          max={params.createdTo}
          onChange={(event) => onFiltersChange({ createdFrom: event.target.value === "" ? undefined : event.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Created to (UTC)</span>
        <Input
          type="date"
          value={params.createdTo ?? ""}
          min={params.createdFrom}
          onChange={(event) => onFiltersChange({ createdTo: event.target.value === "" ? undefined : event.target.value })}
        />
      </div>
    </div>
  );

  const viewControls = (
    <>
      <FieldSelect
        label="Group"
        value={groupValue}
        onValueChange={(value) => onSetGroup(value)}
        options={MAP_GROUP_BY_VALUES.map((mode) => ({ value: mode, label: BELTS_LABELS[mode] }))}
      />
      <FieldSelect
        label="Links"
        value={params.links}
        onValueChange={onSetLinks}
        options={FLOOR_LINKS_MODES.map((mode) => ({ value: mode, label: LINKS_LABELS[mode] }))}
      />
      <MatchToggle value={params.match} onChange={onSetMatch} />
      <FieldSelect
        label="Shipped"
        value={params.shipped}
        onValueChange={onSetShipped}
        options={FLOOR_SHIPPED_WINDOWS.map((window) => ({
          value: window,
          label: window === "24h" ? "Last 24h" : "Last 7 days",
        }))}
      />
    </>
  );

  const presets = (
    <>
      <PresetButton active={isNeedsMeActive} onClick={onToggleNeedsMe}>
        Needs me
      </PresetButton>
      <PresetButton
        active={groupValue === "chain" && params.links === "all"}
        onClick={() => onApplyPreset({ group: "chain", links: "all" })}
      >
        Chains
      </PresetButton>
      <PresetButton active={params.stale} onClick={() => onApplyPreset({ stale: !params.stale })}>
        Stale
      </PresetButton>
      <PresetButton active={params.working} onClick={() => onApplyPreset({ working: !params.working })}>
        Agents working
      </PresetButton>
    </>
  );

  const chipsRow =
    chips.length === 0 ? null : (
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            onClick={() => onFiltersChange((current: TaskListParams) => chip.clear(current))}
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

  const liveRegion = (
    <p aria-live="polite" className="sr-only">
      {activeFilterCount === 0 ? "No filters active" : `${activeFilterCount} filter${activeFilterCount === 1 ? "" : "s"} active`}
    </p>
  );

  const filtersBadgeCount =
    params.priority.length +
    params.label.length +
    (params.assignee !== undefined || params.assigneeIsNull !== undefined ? 1 : 0) +
    (params.createdBy !== undefined ? 1 : 0) +
    (params.createdFrom !== undefined ? 1 : 0) +
    (params.createdTo !== undefined ? 1 : 0) +
    (params.parentIsNull === true ? 1 : 0);

  // The combined "everything" sheet — every field plus the view controls and
  // presets in one `Dialog` — shared by `compact` and the narrow toolbar
  // (`toolbar && narrow`) rather than built twice: both collapse Filters and
  // View into one trigger, they just wrap it in a different surrounding row.
  const filtersAndViewDialog = (
    <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Filters</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {priorityField}
          {labelsField}
          {assigneeField}
          {createdByField}
          {moreFields}
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <div className="flex flex-wrap items-center gap-2">{viewControls}</div>
            <div className="flex flex-wrap items-center gap-1.5">{presets}</div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" className="flex-1" onClick={onClear}>
            Clear all
          </Button>
          <Button className="flex-1" onClick={() => setSheetOpen(false)}>
            Show results
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  const filtersButton = (
    <Button
      type="button"
      variant="outline"
      onClick={() => setSheetOpen(true)}
      aria-label={activeFilterCount === 0 ? "Filters" : `Filters, ${activeFilterCount} active`}
    >
      <SlidersHorizontal aria-hidden="true" />
      Filters
      {activeFilterCount > 0 ? (
        <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground">{activeFilterCount}</span>
      ) : null}
    </Button>
  );

  if (toolbar && narrow) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          {searchOpen ? (
            <DispatchSearchInput
              ref={searchInputRef}
              value={params.q}
              onCommit={commitSearch}
              className="w-full sm:w-auto"
              autoFocus
              onBlurEmpty={() => setSearchOpen(false)}
            />
          ) : (
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Search"
              onClick={() => setSearchOpen(true)}
            >
              <Search aria-hidden="true" />
            </Button>
          )}
          {searchOpen ? null : filtersButton}
        </div>
        {liveRegion}
        {chipsRow}
        {filtersAndViewDialog}
      </div>
    );
  }

  if (toolbar) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <DispatchSearchInput ref={searchInputRef} value={params.q} onCommit={commitSearch} />

        <Popover label="Filters" badgeCount={filtersBadgeCount} panelClassName="w-72">
          {() => (
            <div className="flex flex-col gap-4">
              {priorityField}
              {labelsField}
              {assigneeField}
              {createdByField}
              {moreFields}
            </div>
          )}
        </Popover>

        <Popover label="View" panelClassName="w-64">
          {() => (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">{viewControls}</div>
              <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-2">{presets}</div>
            </div>
          )}
        </Popover>

        {liveRegion}
        {chipsRow}
      </div>
    );
  }

  if (compact) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-2">
        <div className="flex items-center gap-2">
          <DispatchSearchInput ref={searchInputRef} value={params.q} onCommit={commitSearch} className="flex-1 sm:flex-none" />
          {filtersButton}
        </div>
        {liveRegion}
        {chipsRow}
        {filtersAndViewDialog}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <DispatchSearchInput ref={searchInputRef} value={params.q} onCommit={commitSearch} />

        <Popover label="Priority" badgeCount={params.priority.length}>
          {() => priorityField}
        </Popover>

        {labels.length === 0 ? null : (
          <Popover label="Labels" badgeCount={params.label.length}>
            {() => labelsField}
          </Popover>
        )}

        <Popover
          label="Assignee"
          badgeCount={params.assignee !== undefined || params.assigneeIsNull !== undefined ? 1 : 0}
        >
          {() => assigneeField}
        </Popover>

        <Popover label="Created by" badgeCount={params.createdBy !== undefined ? 1 : 0}>
          {() => createdByField}
        </Popover>

        <Popover
          label="More"
          badgeCount={
            (params.createdFrom !== undefined ? 1 : 0) +
            (params.createdTo !== undefined ? 1 : 0) +
            (params.parentIsNull === true ? 1 : 0)
          }
          panelClassName="w-64"
        >
          {() => moreFields}
        </Popover>

        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

        {viewControls}

        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

        {presets}
      </div>

      {liveRegion}
      {chipsRow}
    </div>
  );
};

const FieldSelect = <TValue extends string>({
  label,
  value,
  onValueChange,
  options,
}: {
  label: string;
  value: TValue;
  onValueChange: (value: TValue) => void;
  options: readonly { value: TValue; label: string }[];
}) => (
  <div className="flex items-center gap-1">
    <span className="text-xs text-muted-foreground">{label}</span>
    <Select options={options} value={value} onValueChange={onValueChange} aria-label={label} className="h-8 text-xs" />
  </div>
);

const MatchToggle = ({
  value,
  onChange,
}: {
  value: FloorMatchMode;
  onChange: (value: FloorMatchMode) => void;
}) => (
  <div className="inline-flex overflow-hidden rounded-md border border-border" role="group" aria-label="Non-matching tasks">
    {(["dim", "hide"] as const).map((mode) => (
      <button
        key={mode}
        type="button"
        aria-pressed={value === mode}
        onClick={() => onChange(mode)}
        className={cn(
          "px-2 py-1 text-xs capitalize transition-colors",
          value === mode ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-muted",
        )}
      >
        {mode}
      </button>
    ))}
  </div>
);

const PresetButton = ({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    aria-pressed={active}
    onClick={onClick}
    className={cn(
      "rounded-full border px-2.5 py-1 text-xs transition-colors",
      active
        ? "border-primary bg-primary-subtle text-primary-subtle-foreground"
        : "border-border bg-card text-muted-foreground hover:bg-muted",
    )}
  >
    {children}
  </button>
);

/** For anything wanting a plain date label (kept next to `More`'s date fields). */
export const dateChipLabel = (date: string): string => formatDateOnly(date);
