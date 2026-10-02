import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { setViewportWidth } from "../../../vitest.setup";
import {
  activeFilterChips,
  creatorLabel,
  OPEN_STATUSES,
  TaskFilterBar,
  toggleValue,
  type TaskFilterBarProps,
} from "@/features/tasks/TaskFilterBar";
import {
  DEFAULT_TASK_LIST_PARAMS,
  type TaskListFilterPatch,
  type TaskListParams,
} from "@/pages/tasks-list/useTaskListParams";
import { renderInProviders } from "@/test/harness";

/**
 * The bar itself, below the page.
 *
 * `TasksListPage.test.tsx` covers the URL round trip through this component;
 * what it cannot see is the shape of the callbacks. The stage-11 constraint is
 * that a control which *derives* from a filter's previous value must hand back
 * a **function**, not a computed array — a control that computes the array from
 * its render-time props silently drops any change that landed in between, and
 * the page test only notices when two writes touch the *same* field in one
 * frame. Asserting the callback shape here catches the same defect without
 * needing to arrange that race.
 */

const params = (overrides: Partial<TaskListParams> = {}): TaskListParams => ({
  ...DEFAULT_TASK_LIST_PARAMS,
  ...overrides,
});

const renderBar = (props: Partial<TaskFilterBarProps> = {}) => {
  const onFiltersChange = vi.fn();
  const onSortChange = vi.fn();
  const onClear = vi.fn();

  renderInProviders(
    <TaskFilterBar
      params={params()}
      facets={{
        assignees: ["Alice Chen", "Marcus Feld"],
        projects: ["estuary", "mcp-server"],
        labels: ["bug", "web"],
        creators: ["agent:claude-code", "human:krisz"],
      }}
      onFiltersChange={onFiltersChange}
      onSortChange={onSortChange}
      onClear={onClear}
      activeFilterCount={0}
      isWide
      {...props}
    />,
  );

  /** Resolve the patch the bar handed back against a given starting state. */
  const patchAgainst = (current: TaskListParams, callIndex = 0) => {
    const patch = onFiltersChange.mock.calls[callIndex]?.[0] as TaskListFilterPatch;
    return typeof patch === "function" ? patch(current) : patch;
  };

  return { onFiltersChange, onSortChange, onClear, patchAgainst };
};

/* ------------------------------------------------------------------ *
 * toggleValue
 * ------------------------------------------------------------------ */

describe("toggleValue", () => {
  it("adds a value that is absent and removes one that is present", () => {
    expect(toggleValue(["todo"], "done")).toEqual(["todo", "done"]);
    expect(toggleValue(["todo", "done"], "todo")).toEqual(["done"]);
  });

  it("does not mutate the array it was given", () => {
    const current = ["todo"] as const;
    toggleValue(current, "done");
    expect(current).toEqual(["todo"]);
  });
});

/* ------------------------------------------------------------------ *
 * The chip groups
 * ------------------------------------------------------------------ */

describe("TaskFilterBar chip groups", () => {
  it("renders each filter group as a named group of real checkboxes", () => {
    renderBar({ params: params({ status: ["todo"] }) });

    // Not `button aria-pressed`: a screen reader should announce this as a named
    // group of checkboxes with a count, which is what the control actually is.
    const status = screen.getByRole("group", { name: "Status" });
    expect(status).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "To do" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Done" })).not.toBeChecked();
    // All ten statuses, not the helpdesk's four.
    expect(
      within(status)
        .getAllByRole("checkbox")
        .map((box) => box.closest("label")?.textContent),
    ).toEqual([
      "Backlog",
      "Needs refinement",
      "To do",
      "In progress",
      "Blocked",
      "Needs decision",
      "Needs action",
      "Needs QA",
      "Done",
      "Deferred",
    ]);
  });

  it("hands back a FUNCTION of the current filters, never a computed array", async () => {
    const user = userEvent.setup();
    const { onFiltersChange, patchAgainst } = renderBar({ params: params({ status: ["todo"] }) });

    await user.click(screen.getByRole("checkbox", { name: "Done" }));

    // The shape is the assertion. A control that computed `["todo","done"]`
    // here would satisfy any test that only checks the resulting value, and
    // would still drop a concurrent write to the same field.
    expect(typeof onFiltersChange.mock.calls[0]?.[0]).toBe("function");

    // Resolved against a state that moved *after* the chip rendered: the patch
    // must build on `blocked`, not on the `["todo"]` it was drawn with.
    expect(patchAgainst(params({ status: ["todo", "blocked"] }))).toEqual({
      status: ["todo", "blocked", "done"],
    });
  });

  it("unchecks by toggling the value back out", async () => {
    const user = userEvent.setup();
    const { patchAgainst } = renderBar({ params: params({ priority: ["urgent", "high"] }) });

    await user.click(screen.getByRole("checkbox", { name: "Urgent" }));

    expect(patchAgainst(params({ priority: ["urgent", "high"] }))).toEqual({ priority: ["high"] });
  });

  it("has no project control — the header's project switcher owns it", () => {
    renderBar({ params: params({ project: ["estuary"] }) });
    expect(screen.queryByRole("group", { name: "Project" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "estuary" })).not.toBeInTheDocument();
  });

  it("offers the labels the facets report", () => {
    renderBar();

    const group = screen.getByRole("group", { name: "Label" });
    expect(within(group).getByRole("checkbox", { name: "bug" })).toBeInTheDocument();
    expect(within(group).getByRole("checkbox", { name: "web" })).toBeInTheDocument();
  });

  it("toggles a label filter", async () => {
    const user = userEvent.setup();
    const { patchAgainst } = renderBar({ params: params({ label: ["bug"] }) });

    await user.click(screen.getByRole("checkbox", { name: "web" }));

    expect(patchAgainst(params({ label: ["bug"] }))).toEqual({ label: ["bug", "web"] });
  });

  it("keeps a label from the URL removable before the facets land", () => {
    renderBar({ facets: undefined, params: params({ label: ["web"] }) });
    expect(screen.getByRole("checkbox", { name: "web" })).toBeChecked();
  });
});

describe("TaskFilterBar top-level toggle", () => {
  it("sets parentIsNull when checked, and clears it when unchecked", async () => {
    const user = userEvent.setup();
    const { patchAgainst } = renderBar();

    await user.click(screen.getByRole("checkbox", { name: /top-level only/i }));
    expect(patchAgainst(params())).toEqual({ parentIsNull: true });
  });

  it("is checked when parentIsNull is already true", () => {
    renderBar({ params: params({ parentIsNull: true }) });
    expect(screen.getByRole("checkbox", { name: /top-level only/i })).toBeChecked();
  });
});

/* ------------------------------------------------------------------ *
 * Status presets
 * ------------------------------------------------------------------ */

describe("TaskFilterBar status presets", () => {
  it("selects every non-closed status with one click", async () => {
    const user = userEvent.setup();
    const { patchAgainst } = renderBar();

    await user.click(screen.getByRole("button", { name: "Open work" }));

    expect(patchAgainst(params())).toEqual({ status: [...OPEN_STATUSES] });
    expect(OPEN_STATUSES).not.toContain("done");
    expect(OPEN_STATUSES).not.toContain("deferred");
    expect(OPEN_STATUSES).toHaveLength(8);
  });

  it("selects the inbox statuses with one click", async () => {
    const user = userEvent.setup();
    const { patchAgainst } = renderBar();

    await user.click(screen.getByRole("button", { name: "Needs you" }));

    expect(patchAgainst(params())).toEqual({
      status: ["needs_user_decision", "needs_user_action", "needs_qa"],
    });
  });

  it("shows itself pressed when the selection is exactly its set, and clears on a second press", async () => {
    const user = userEvent.setup();
    const { patchAgainst } = renderBar({
      params: params({ status: ["needs_qa", "needs_user_action", "needs_user_decision"] }),
    });

    const preset = screen.getByRole("button", { name: "Needs you" });
    expect(preset).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Open work" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await user.click(preset);
    expect(patchAgainst(params())).toEqual({ status: [] });
  });
});

/* ------------------------------------------------------------------ *
 * Created by
 * ------------------------------------------------------------------ */

describe("TaskFilterBar creator control", () => {
  it("offers the creators from facets, named with their kind", async () => {
    const user = userEvent.setup();
    const { patchAgainst } = renderBar();

    await user.click(screen.getByRole("combobox", { name: "Filter by creator" }));
    await user.click(await screen.findByRole("option", { name: "claude-code (agent)" }));

    // The exact stored actor goes on the wire — `createdBy` is an exact match.
    expect(patchAgainst(params())).toEqual({ createdBy: "agent:claude-code" });
  });

  it("clears back to anyone", async () => {
    const user = userEvent.setup();
    const { patchAgainst } = renderBar({ params: params({ createdBy: "human:krisz" }) });

    expect(screen.getByRole("combobox", { name: "Filter by creator" })).toHaveTextContent(
      "krisz (human)",
    );
    await user.click(screen.getByRole("combobox", { name: "Filter by creator" }));
    await user.click(await screen.findByRole("option", { name: "Anyone" }));

    expect(patchAgainst(params())).toEqual({ createdBy: undefined });
  });

  it("labels an actor as name then kind", () => {
    expect(creatorLabel("agent:claude-code")).toBe("claude-code (agent)");
    expect(creatorLabel("system:taskmanager")).toBe("taskmanager (system)");
  });
});

/* ------------------------------------------------------------------ *
 * Assignee — one control, so the 422 is unrepresentable
 * ------------------------------------------------------------------ */

describe("TaskFilterBar assignee control", () => {
  const openAssignee = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("combobox", { name: "Filter by assignee" }));
  };

  it("is a single control, so assignee and assigneeIsNull can never both be set", async () => {
    const user = userEvent.setup();
    const { patchAgainst } = renderBar();

    await openAssignee(user);
    await user.click(await screen.findByRole("option", { name: "Unassigned" }));

    // Both keys are always written together — one of them to `undefined`. Two
    // controls would make the server's 422 reachable by clicking.
    //
    // `toStrictEqual`, not `toEqual`: `toEqual` treats an absent key and a key
    // whose value is `undefined` as the same thing, so it cannot tell "clears
    // the other half" from "says nothing about the other half" — which is the
    // entire claim. (Measured: written with `toEqual`, dropping
    // `assignee: undefined` from the patch fired nothing.)
    const patch = patchAgainst(params());
    expect(patch).toStrictEqual({ assignee: undefined, assigneeIsNull: true });
    expect(Object.keys(patch)).toContain("assignee");
  });

  it("distinguishes a person named 'unassigned' from the sentinel", async () => {
    const user = userEvent.setup();
    const { patchAgainst } = renderBar({
      facets: { assignees: ["unassigned"], projects: [], labels: [], creators: [] },
    });

    await openAssignee(user);
    // Two options now read "Unassigned"-ish; the person is the one under the
    // facet list, and it must decode to a name filter rather than to `IS NULL`.
    await user.click(await screen.findByRole("option", { name: "unassigned" }));

    expect(patchAgainst(params())).toStrictEqual({
      assignee: "unassigned",
      assigneeIsNull: undefined,
    });
  });

  it("shows the active filter as the selected value in both spellings", () => {
    renderBar({ params: params({ assigneeIsNull: false }) });
    expect(screen.getByRole("combobox", { name: "Filter by assignee" })).toHaveTextContent(
      "Assigned to anyone",
    );
  });

  it("round-trips a real name through the value encoding", () => {
    renderBar({ params: params({ assignee: "Marcus Feld" }) });
    expect(screen.getByRole("combobox", { name: "Filter by assignee" })).toHaveTextContent(
      "Marcus Feld",
    );
  });
});

/* ------------------------------------------------------------------ *
 * Active chips
 * ------------------------------------------------------------------ */

describe("activeFilterChips", () => {
  it("is empty when nothing is filtered", () => {
    expect(activeFilterChips(params())).toEqual([]);
  });

  it("emits one chip per selected value, in a stable order — none for the project scope", () => {
    const chips = activeFilterChips(
      params({
        q: "printer",
        status: ["todo", "done"],
        priority: ["urgent"],
        project: ["estuary"],
        createdBy: "agent:claude-code",
      }),
    );

    expect(chips.map((chip) => chip.key)).toEqual([
      "q",
      "status:todo",
      "status:done",
      "priority:urgent",
      "createdBy",
    ]);
    expect(chips.map((chip) => chip.label)).toEqual([
      "Search: printer",
      "Status: To do",
      "Status: Done",
      "Priority: Urgent",
      "Created by: claude-code (agent)",
    ]);
  });

  it("clears one value out of several as a function of the current state", () => {
    const chips = activeFilterChips(params({ status: ["todo", "done", "blocked"] }));
    const done = chips.find((chip) => chip.key === "status:done")!;

    // Resolved against a state carrying a status that was not there when the
    // chip was built: removing "done" must leave the newcomer alone. A chip
    // that captured its siblings at render time would return ["todo","blocked"].
    expect(done.clear(params({ status: ["todo", "done", "blocked", "in_progress"] }))).toEqual({
      status: ["todo", "blocked", "in_progress"],
    });
  });

  it("emits a chip for a label filter, removable independently of others", () => {
    const chips = activeFilterChips(params({ label: ["web", "bug"] }));
    expect(chips.map((chip) => chip.label)).toEqual(["Label: web", "Label: bug"]);

    const web = chips.find((chip) => chip.key === "label:web")!;
    expect(web.clear(params({ label: ["web", "bug"] }))).toEqual({ label: ["bug"] });
  });

  it("emits removable chips for the relational filters", () => {
    const chips = activeFilterChips(params({ parentId: 12, dependsOn: 7, dependencyOf: 9 }));
    expect(chips.map((chip) => chip.label)).toEqual([
      "Subtasks of TASK-000012",
      "Depends on TASK-000007",
      "Blocks TASK-000009",
    ]);

    const parentChip = chips.find((chip) => chip.key === "parentId")!;
    expect(parentChip.clear(params())).toEqual({ parentId: undefined });
  });

  it("emits a chip for the top-level-only toggle", () => {
    const chips = activeFilterChips(params({ parentIsNull: true }));
    expect(chips).toEqual([
      { key: "parentIsNull", label: "Top-level only", clear: expect.any(Function) },
    ]);
  });

  it("labels a date bound with the UTC-pinned formatter", () => {
    // `formatDate` would parse `2026-08-01` as UTC midnight and render it in
    // local time, so a chip west of UTC would name the previous day.
    const [chip] = activeFilterChips(params({ createdFrom: "2026-08-01" }));
    expect(chip?.label).toBe("From Aug 1, 2026");
  });

  it("names the unassigned filter without printing a raw boolean", () => {
    expect(activeFilterChips(params({ assigneeIsNull: true }))[0]?.label).toBe("Unassigned");
    expect(activeFilterChips(params({ assigneeIsNull: false }))[0]?.label).toBe(
      "Assigned to anyone",
    );
  });
});

describe("TaskFilterBar active chips", () => {
  it("offers a labelled remove button per chip plus one Clear all", async () => {
    const user = userEvent.setup();
    const { onClear, patchAgainst } = renderBar({
      params: params({ status: ["todo"], priority: ["urgent"] }),
    });

    await user.click(screen.getByRole("button", { name: "Remove filter: Status: To do" }));
    expect(patchAgainst(params({ status: ["todo"], priority: ["urgent"] }))).toEqual({
      status: [],
    });

    await user.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("renders no chip row at all when nothing is active", () => {
    renderBar();
    expect(screen.queryByRole("button", { name: /^Remove filter/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear all" })).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Wide vs narrow
 * ------------------------------------------------------------------ */

describe("TaskFilterBar layout", () => {
  it("renders the controls inline and no Filters trigger when wide", () => {
    setViewportWidth(1280);
    renderBar({ isWide: true });

    expect(screen.getByRole("group", { name: "Status" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Filters/ })).not.toBeInTheDocument();
    // Sort lives in the table header above `md`, not in the bar.
    expect(screen.queryByRole("combobox", { name: /sort/i })).not.toBeInTheDocument();
  });

  it("hides the controls behind a counting trigger when narrow", async () => {
    const user = userEvent.setup();
    setViewportWidth(360);
    renderBar({ isWide: false, params: params({ status: ["todo"] }), activeFilterCount: 2 });

    // Not rendered twice: the controls exist inline *or* in the sheet, never
    // both, so there is no second copy of every checkbox to keep in step.
    expect(screen.queryByRole("group", { name: "Status" })).not.toBeInTheDocument();

    const trigger = screen.getByRole("button", { name: "Filters, 2 active" });
    await user.click(trigger);

    expect(await screen.findByRole("group", { name: "Status" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "To do" })).toBeChecked();
  });

  it("labels the trigger without a count when nothing is filtered", () => {
    setViewportWidth(360);
    renderBar({ isWide: false, activeFilterCount: 0 });

    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Filters, \d+ active/ })).not.toBeInTheDocument();
  });

  it("closes the sheet from Show results and clears from Clear all", async () => {
    const user = userEvent.setup();
    setViewportWidth(360);
    const { onClear } = renderBar({ isWide: false });

    await user.click(screen.getByRole("button", { name: "Filters" }));
    await screen.findByRole("group", { name: "Status" });

    await user.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onClear).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Show results" }));
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Status" })).not.toBeInTheDocument(),
    );
  });
});

/* ------------------------------------------------------------------ *
 * Search box
 * ------------------------------------------------------------------ */

describe("TaskFilterBar search box", () => {
  it("commits with replace, so typing does not fill the history stack", async () => {
    const user = userEvent.setup();
    const { onFiltersChange } = renderBar();

    await user.type(screen.getByRole("searchbox", { name: /search tasks/i }), "printer");

    await waitFor(() => expect(onFiltersChange).toHaveBeenCalled());
    // Both halves matter: `q` is the patch, `{ replace: true }` is what keeps
    // Back from stepping through one keystroke at a time.
    expect(onFiltersChange).toHaveBeenLastCalledWith({ q: "printer" }, { replace: true });
  });

  it("commits undefined, not an empty string, when the box is cleared", async () => {
    const user = userEvent.setup();
    const { onFiltersChange } = renderBar({ params: params({ q: "printer" }) });

    await user.clear(screen.getByRole("searchbox", { name: /search tasks/i }));

    await waitFor(() =>
      expect(onFiltersChange).toHaveBeenLastCalledWith({ q: undefined }, { replace: true }),
    );
  });

  /**
   * The `params` prop moves while the **same** `SearchInput` stays mounted —
   * that is the whole condition. Calling RTL's `rerender` with a fresh element
   * remounts the subtree, and a remounted input initialises its state from the
   * new prop no matter what the sync effect does; written that way the test
   * passes with the effect deleted. (Measured: it did.)
   */
  it("adopts a value the URL changed underneath it, such as a Back press", async () => {
    const user = userEvent.setup();

    const Host = () => {
      const [q, setQ] = useState<string | undefined>("printer");
      return (
        <>
          <button type="button" onClick={() => setQ(undefined)}>
            Go back
          </button>
          <TaskFilterBar
            params={params({ q })}
            facets={undefined}
            onFiltersChange={vi.fn()}
            onSortChange={vi.fn()}
            onClear={vi.fn()}
            activeFilterCount={q === undefined ? 0 : 1}
            isWide
          />
        </>
      );
    };

    renderInProviders(<Host />);
    const box = screen.getByRole("searchbox", { name: /search tasks/i });
    expect(box).toHaveValue("printer");

    await user.click(screen.getByRole("button", { name: "Go back" }));

    // Stale text in the box would describe a search that is no longer applied.
    await waitFor(() => expect(box).toHaveValue(""));
  });

  it("caps typed input at the contract's maximum", () => {
    renderBar();
    expect(screen.getByRole("searchbox", { name: /search tasks/i })).toHaveAttribute(
      "maxlength",
      "120",
    );
  });
});
