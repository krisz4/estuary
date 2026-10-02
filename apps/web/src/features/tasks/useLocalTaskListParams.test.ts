import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { applyFilterPatch, useLocalTaskListParams } from "@/features/tasks/useLocalTaskListParams";
import { DEFAULT_TASK_LIST_PARAMS } from "@/pages/tasks-list/useTaskListParams";

const initial = { ...DEFAULT_TASK_LIST_PARAMS, status: ["backlog" as const], project: ["estuary"] };

describe("applyFilterPatch", () => {
  it("merges, resets the page, and keeps the assignee pair mutually exclusive", () => {
    const current = { ...initial, page: 3, assigneeIsNull: true };
    const next = applyFilterPatch(current, { assignee: "krisz" });
    expect(next.page).toBe(1);
    expect(next.assignee).toBe("krisz");
    expect(next.assigneeIsNull).toBeUndefined();
  });

  it("resolves a function patch against the current state", () => {
    const next = applyFilterPatch(initial, (current) => ({
      status: [...current.status, "todo"],
    }));
    expect(next.status).toEqual(["backlog", "todo"]);
  });
});

describe("useLocalTaskListParams", () => {
  it("starts from the initial params and reports them as initial", () => {
    const { result } = renderHook(() => useLocalTaskListParams(initial));
    expect(result.current.params.status).toEqual(["backlog"]);
    expect(result.current.isInitialFilters).toBe(true);
  });

  it("paging alone doesn't count as changing the filters", () => {
    const { result } = renderHook(() => useLocalTaskListParams(initial));
    act(() => result.current.setPage(2));
    expect(result.current.params.page).toBe(2);
    expect(result.current.isInitialFilters).toBe(true);
  });

  it("clearing keeps the project scope; resetting returns to the opening filters", () => {
    const { result } = renderHook(() => useLocalTaskListParams(initial));
    act(() => result.current.setFilters({ priority: ["high"] }));
    expect(result.current.isInitialFilters).toBe(false);

    act(() => result.current.clearFilters());
    expect(result.current.params.status).toEqual([]);
    expect(result.current.params.project).toEqual(["estuary"]);

    act(() => result.current.resetFilters());
    expect(result.current.params.status).toEqual(["backlog"]);
    expect(result.current.params.priority).toEqual([]);
    expect(result.current.isInitialFilters).toBe(true);
  });

  it("ignores a new `initial` object on re-render", () => {
    const { result, rerender } = renderHook((props) => useLocalTaskListParams(props), {
      initialProps: initial,
    });
    act(() => result.current.setFilters({ q: "rate limit" }));
    rerender({ ...initial });
    expect(result.current.params.q).toBe("rate limit");
  });
});
