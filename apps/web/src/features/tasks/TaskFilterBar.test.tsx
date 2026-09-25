import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { setViewportWidth } from "../../../vitest.setup";
import {
  activeFilterChips,
  TicketFilterBar,
  toggleValue,
  type TicketFilterBarProps,
} from "@/features/tickets/TicketFilterBar";
import {
  DEFAULT_TICKET_LIST_PARAMS,
  type TicketListFilterPatch,
  type TicketListParams,
} from "@/pages/tickets-list/useTicketListParams";
import { renderInProviders } from "@/test/harness";

/**
 * The bar itself, below the page.
 *
 * `TicketsListPage.test.tsx` covers the URL round trip through this component;
 * what it cannot see is the shape of the callbacks. The stage-11 constraint is
 * that a control which *derives* from a filter's previous value must hand back
 * a **function**, not a computed array — a control that computes the array from
 * its render-time props silently drops any change that landed in between, and
 * the page test only notices when two writes touch the *same* field in one
 * frame. Asserting the callback shape here catches the same defect without
 * needing to arrange that race.
 */

const params = (overrides: Partial<TicketListParams> = {}): TicketListParams => ({
  ...DEFAULT_TICKET_LIST_PARAMS,
  ...overrides,
});

const renderBar = (props: Partial<TicketFilterBarProps> = {}) => {
  const onFiltersChange = vi.fn();
  const onSortChange = vi.fn();
  const onClear = vi.fn();

  renderInProviders(
    <TicketFilterBar
      params={params()}
      facets={{ assignees: ["Alice Chen", "Marcus Feld"], categories: ["hardware", "software"] }}
      onFiltersChange={onFiltersChange}
      onSortChange={onSortChange}
      onClear={onClear}
      activeFilterCount={0}
      isWide
      {...props}
    />,
  );

  /** Resolve the patch the bar handed back against a given starting state. */
  const patchAgainst = (current: TicketListParams, callIndex = 0) => {
    const patch = onFiltersChange.mock.calls[callIndex]?.[0] as TicketListFilterPatch;
    return typeof patch === "function" ? patch(current) : patch;
  };

  return { onFiltersChange, onSortChange, onClear, patchAgainst };
};

/* ------------------------------------------------------------------ *
 * toggleValue
 * ------------------------------------------------------------------ */

describe("toggleValue", () => {
  it("adds a value that is absent and removes one that is present", () => {
    expect(toggleValue(["open"], "closed")).toEqual(["open", "closed"]);
    expect(toggleValue(["open", "closed"], "open")).toEqual(["closed"]);
  });

  it("does not mutate the array it was given", () => {
    const current = ["open"] as const;
    toggleValue(current, "closed");
    expect(current).toEqual(["open"]);
  });
});

/* ------------------------------------------------------------------ *
 * The chip groups
 * ------------------------------------------------------------------ */

describe("TicketFilterBar chip groups", () => {
  it("renders each filter group as a named group of real checkboxes", () => {
    renderBar({ params: params({ status: ["open"] }) });

    // Not `button aria-pressed`: a screen reader should announce this as a named
    // group of checkboxes with a count, which is what the control actually is.
    expect(screen.getByRole("group", { name: "Status" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Open" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Closed" })).not.toBeChecked();
  });

  it("hands back a FUNCTION of the current filters, never a computed array", async () => {
    const user = userEvent.setup();
    const { onFiltersChange, patchAgainst } = renderBar({ params: params({ status: ["open"] }) });

    await user.click(screen.getByRole("checkbox", { name: "Closed" }));

    // The shape is the assertion. A control that computed `["open","closed"]`
    // here would satisfy any test that only checks the resulting value, and
    // would still drop a concurrent write to the same field.
    expect(typeof onFiltersChange.mock.calls[0]?.[0]).toBe("function");

    // Resolved against a state that moved *after* the chip rendered: the patch
    // must build on `resolved`, not on the `["open"]` it was drawn with.
    expect(patchAgainst(params({ status: ["open", "resolved"] }))).toEqual({
      status: ["open", "resolved", "closed"],
    });
  });

  it("unchecks by toggling the value back out", async () => {
    const user = userEvent.setup();
    const { patchAgainst } = renderBar({ params: params({ priority: ["urgent", "high"] }) });

    await user.click(screen.getByRole("checkbox", { name: "Urgent" }));

    expect(patchAgainst(params({ priority: ["urgent", "high"] }))).toEqual({ priority: ["high"] });
  });

  it("narrows the category chips to the facets when they have loaded", () => {
    renderBar();

    expect(screen.getByRole("checkbox", { name: "Hardware" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Software" })).toBeInTheDocument();
    // `network` is in the enum but not in these facets, so it is not offered —
    // a chip that can only ever return zero rows is noise.
    expect(screen.queryByRole("checkbox", { name: "Network" })).not.toBeInTheDocument();
  });

  it("falls back to the full category enum before the facets land", () => {
    // An empty select while a 1ms request is in flight reads as a broken
    // control, so `undefined` facets must not mean "no options".
    renderBar({ facets: undefined });

    expect(screen.getByRole("checkbox", { name: "Network" })).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Assignee — one control, so the 422 is unrepresentable
 * ------------------------------------------------------------------ */

describe("TicketFilterBar assignee control", () => {
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
    const { patchAgainst } = renderBar({ facets: { assignees: ["unassigned"], categories: [] } });

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

  it("emits one chip per selected value, in a stable order", () => {
    const chips = activeFilterChips(
      params({ q: "printer", status: ["open", "closed"], priority: ["urgent"] }),
    );

    expect(chips.map((chip) => chip.key)).toEqual([
      "q",
      "status:open",
      "status:closed",
      "priority:urgent",
    ]);
    expect(chips.map((chip) => chip.label)).toEqual([
      "Search: printer",
      "Status: Open",
      "Status: Closed",
      "Priority: Urgent",
    ]);
  });

  it("clears one value out of several as a function of the current state", () => {
    const chips = activeFilterChips(params({ status: ["open", "closed", "resolved"] }));
    const closed = chips.find((chip) => chip.key === "status:closed")!;

    // Resolved against a state carrying a status that was not there when the
    // chip was built: removing "closed" must leave the newcomer alone. A chip
    // that captured its siblings at render time would return ["open","resolved"].
    expect(closed.clear(params({ status: ["open", "closed", "resolved", "in_progress"] }))).toEqual(
      {
        status: ["open", "resolved", "in_progress"],
      },
    );
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

describe("TicketFilterBar active chips", () => {
  it("offers a labelled remove button per chip plus one Clear all", async () => {
    const user = userEvent.setup();
    const { onClear, patchAgainst } = renderBar({
      params: params({ status: ["open"], priority: ["urgent"] }),
    });

    await user.click(screen.getByRole("button", { name: "Remove filter: Status: Open" }));
    expect(patchAgainst(params({ status: ["open"], priority: ["urgent"] }))).toEqual({
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

describe("TicketFilterBar layout", () => {
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
    renderBar({ isWide: false, params: params({ status: ["open"] }), activeFilterCount: 2 });

    // Not rendered twice: the controls exist inline *or* in the sheet, never
    // both, so there is no second copy of every checkbox to keep in step.
    expect(screen.queryByRole("group", { name: "Status" })).not.toBeInTheDocument();

    const trigger = screen.getByRole("button", { name: "Filters, 2 active" });
    await user.click(trigger);

    expect(await screen.findByRole("group", { name: "Status" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Open" })).toBeChecked();
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

describe("TicketFilterBar search box", () => {
  it("commits with replace, so typing does not fill the history stack", async () => {
    const user = userEvent.setup();
    const { onFiltersChange } = renderBar();

    await user.type(screen.getByRole("searchbox", { name: /search tickets/i }), "printer");

    await waitFor(() => expect(onFiltersChange).toHaveBeenCalled());
    // Both halves matter: `q` is the patch, `{ replace: true }` is what keeps
    // Back from stepping through one keystroke at a time.
    expect(onFiltersChange).toHaveBeenLastCalledWith({ q: "printer" }, { replace: true });
  });

  it("commits undefined, not an empty string, when the box is cleared", async () => {
    const user = userEvent.setup();
    const { onFiltersChange } = renderBar({ params: params({ q: "printer" }) });

    await user.clear(screen.getByRole("searchbox", { name: /search tickets/i }));

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
          <TicketFilterBar
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
    const box = screen.getByRole("searchbox", { name: /search tickets/i });
    expect(box).toHaveValue("printer");

    await user.click(screen.getByRole("button", { name: "Go back" }));

    // Stale text in the box would describe a search that is no longer applied.
    await waitFor(() => expect(box).toHaveValue(""));
  });

  it("caps typed input at the contract's maximum", () => {
    renderBar();
    expect(screen.getByRole("searchbox", { name: /search tickets/i })).toHaveAttribute(
      "maxlength",
      "120",
    );
  });
});
