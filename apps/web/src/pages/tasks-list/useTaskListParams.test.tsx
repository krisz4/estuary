import { act, render } from "@testing-library/react";
import { RouterProvider, createMemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  parseTaskListParams,
  serializeTaskListParams,
  useTaskListParams,
  type TaskListParams,
  type TaskListParamsApi,
} from "@/pages/tasks-list/useTaskListParams";

const parse = (search: string): TaskListParams => parseTaskListParams(new URLSearchParams(search));

describe("parseTaskListParams", () => {
  it("picks the keys it knows and ignores the ones it does not", () => {
    // The regression this whole module exists for: feeding the raw params into
    // the server's `.strict()` schema fails on `utm_source` and resets
    // everything else to defaults.
    const params = parse("?utm_source=slack&fbclid=xyz&status=todo&priority=urgent&page=3");

    expect(params.status).toEqual(["todo"]);
    expect(params.priority).toEqual(["urgent"]);
    expect(params.page).toBe(3);
  });

  it("falls back per field, leaving valid neighbours alone", () => {
    const params = parse("?page=abc&pageSize=999&sort=nonsense&status=todo&q=printer");

    expect(params.page).toBe(1);
    expect(params.pageSize).toBe(20);
    expect(params.sort).toEqual({ field: "createdAt", direction: "desc" });
    // The point of "per field": these two survived the three failures above.
    expect(params.status).toEqual(["todo"]);
    expect(params.q).toBe("printer");
  });

  it("rejects the numeric spellings that are not decimal integers", () => {
    // `Number("0x2a")` is 42 and `Number(" 12 ")` is 12 — both would silently
    // become a page the user never asked for.
    expect(parse("?page=0x2a").page).toBe(1);
    expect(parse("?page=1e3").page).toBe(1);
    expect(parse("?page=-1").page).toBe(1);
    expect(parse("?page=0").page).toBe(1);
    expect(parse("?page=2.5").page).toBe(1);
  });

  it("drops invalid enum members and de-duplicates the rest", () => {
    expect(parse("?status=todo&status=nope&status=todo&status=done").status).toEqual([
      "todo",
      "done",
    ]);
  });

  it("keeps project slugs, lowercased and de-duplicated, and drops anything else", () => {
    // Lowercased like the contract's `projectSchema` stores them: `HelpDesk`
    // and `helpdesk` are one project, and the filter is an exact match.
    expect(
      parse("?project=HelpDesk&project=helpdesk&project=has%20space&project=mcp-server").project,
    ).toEqual(["helpdesk", "mcp-server"]);
  });

  it("keeps a createdBy that is an actor, lowercased, and drops one that is not", () => {
    expect(parse("?createdBy=Agent%3AClaude-Code").createdBy).toBe("agent:claude-code");
    expect(parse("?createdBy=system%3Ataskmanager").createdBy).toBe("system:taskmanager");
    expect(parse("?createdBy=claude").createdBy).toBeUndefined();
    expect(parse("?createdBy=robot%3Ax").createdBy).toBeUndefined();
  });

  it("round-trips project and createdBy through the URL", () => {
    const params = parse("?project=helpdesk&project=mcp-server&createdBy=human%3Akrisz");
    expect(serializeTaskListParams(params).toString()).toBe(
      "project=helpdesk&project=mcp-server&createdBy=human%3Akrisz",
    );
  });

  it("never returns assignee and assigneeIsNull together", () => {
    // The server 422s on the pair. `assignee` wins.
    const params = parse("?assignee=Alice&assigneeIsNull=true");
    expect(params.assignee).toBe("Alice");
    expect(params.assigneeIsNull).toBeUndefined();
  });

  it("reads assigneeIsNull=false as a filter, not as absence", () => {
    expect(parse("?assigneeIsNull=false").assigneeIsNull).toBe(false);
    expect(parse("?assigneeIsNull=maybe").assigneeIsNull).toBeUndefined();
  });

  it("accepts only real calendar days and drops an inverted range", () => {
    expect(parse("?createdFrom=2026-02-31").createdFrom).toBeUndefined();
    expect(parse("?createdFrom=2026-8-1").createdFrom).toBeUndefined();
    expect(parse("?createdFrom=2026-08-01").createdFrom).toBe("2026-08-01");

    const inverted = parse("?createdFrom=2026-08-10&createdTo=2026-08-01");
    expect(inverted.createdFrom).toBe("2026-08-10");
    expect(inverted.createdTo).toBeUndefined();
  });

  it("drops a q longer than the contract allows rather than truncating it", () => {
    expect(parse(`?q=${"a".repeat(121)}`).q).toBeUndefined();
    expect(parse(`?q=${"a".repeat(120)}`).q).toHaveLength(120);
  });

  it("keeps label slugs, lowercased and de-duplicated, and drops anything invalid", () => {
    expect(parse("?label=Web&label=web&label=has%20space&label=apps/web").label).toEqual([
      "web",
      "apps/web",
    ]);
  });

  it("parses parentId, dependsOn, and dependencyOf as task ids", () => {
    expect(parse("?parentId=12").parentId).toBe(12);
    expect(parse("?parentId=0x2a").parentId).toBeUndefined();
    expect(parse("?dependsOn=7").dependsOn).toBe(7);
    expect(parse("?dependencyOf=9").dependencyOf).toBe(9);
  });

  it("never returns parentId and parentIsNull together", () => {
    const params = parse("?parentId=12&parentIsNull=true");
    expect(params.parentId).toBe(12);
    expect(params.parentIsNull).toBeUndefined();
  });
});

describe("serializeTaskListParams", () => {
  const base = parse("");

  it("omits every value that equals its default", () => {
    expect(serializeTaskListParams(base).toString()).toBe("");
  });

  it("writes only what differs", () => {
    const params: TaskListParams = { ...base, page: 3, status: ["todo", "done"] };
    expect(serializeTaskListParams(params).toString()).toBe("page=3&status=todo&status=done");
  });

  it("carries unknown keys through untouched", () => {
    const previous = new URLSearchParams("?utm_source=slack&page=9");
    const next = serializeTaskListParams({ ...base, page: 2 }, previous);

    expect(next.get("page")).toBe("2");
    expect(next.get("utm_source")).toBe("slack");
  });
});

/* ------------------------------------------------------------------ *
 * The hook
 * ------------------------------------------------------------------ */

type Harness = { api: TaskListParamsApi; search: string };

/**
 * Renders the hook inside a **real** router with real history, not a mocked
 * `useSearchParams`. Back and forward are the behaviour under test in two of
 * these cases, and a mock cannot have them.
 */
const renderParams = (initialEntry: string) => {
  const latest: { current: Harness | undefined } = { current: undefined };

  const Probe = () => {
    latest.current = { api: useTaskListParams(), search: useLocation().search };
    return null;
  };

  const router = createMemoryRouter([{ path: "/tasks", element: <Probe /> }], {
    initialEntries: [initialEntry],
  });

  render(<RouterProvider router={router} />);

  return {
    get current(): Harness {
      if (latest.current === undefined) throw new Error("probe never rendered");
      return latest.current;
    },
    router,
  };
};

describe("useTaskListParams", () => {
  it("resets page to 1 when a filter changes", () => {
    const h = renderParams("/tasks?page=5&status=todo");

    act(() => h.current.api.setFilters({ priority: ["urgent"] }));

    expect(h.current.api.params.page).toBe(1);
    expect(h.current.api.params.priority).toEqual(["urgent"]);
    expect(h.current.search).not.toContain("page=5");
  });

  it("resets page to 1 when sort changes", () => {
    const h = renderParams("/tasks?page=4");

    act(() => h.current.api.setSort({ field: "priority", direction: "desc" }));

    expect(h.current.api.params.page).toBe(1);
    expect(h.current.api.params.sort).toEqual({ field: "priority", direction: "desc" });
  });

  it("resets page to 1 when the page size changes", () => {
    const h = renderParams("/tasks?page=4&pageSize=10");

    act(() => h.current.api.setPageSize(50));

    expect(h.current.api.params.page).toBe(1);
    expect(h.current.api.params.pageSize).toBe(50);
  });

  it("leaves every filter alone when only the page changes", () => {
    const h = renderParams("/tasks?status=todo&priority=urgent&q=printer&sort=title:asc");

    act(() => h.current.api.setPage(3));

    expect(h.current.api.params.page).toBe(3);
    expect(h.current.api.params.status).toEqual(["todo"]);
    expect(h.current.api.params.priority).toEqual(["urgent"]);
    expect(h.current.api.params.q).toBe("printer");
    expect(h.current.api.params.sort).toEqual({ field: "title", direction: "asc" });
  });

  it("keeps sort and page size when filters are cleared", () => {
    const h = renderParams("/tasks?status=todo&pageSize=50&sort=title:asc&page=2");

    act(() => h.current.api.clearFilters());

    expect(h.current.api.params.status).toEqual([]);
    expect(h.current.api.params.page).toBe(1);
    expect(h.current.api.params.pageSize).toBe(50);
    expect(h.current.api.params.sort).toEqual({ field: "title", direction: "asc" });
  });

  it("treats project as the header's scope: not counted, and kept when filters are cleared", () => {
    const h = renderParams("/tasks?project=helpdesk&status=todo");

    expect(h.current.api.activeFilterCount).toBe(1);

    act(() => h.current.api.clearFilters());

    expect(h.current.api.params.status).toEqual([]);
    expect(h.current.api.params.project).toEqual(["helpdesk"]);
    expect(h.current.api.hasActiveFilters).toBe(false);
  });

  it("clears the other half of the parentId/parentIsNull pair on a partial patch", () => {
    const h = renderParams("/tasks?parentIsNull=true");

    act(() => h.current.api.setFilters({ parentId: 12 }));

    expect(h.current.api.params.parentId).toBe(12);
    expect(h.current.api.params.parentIsNull).toBeUndefined();
    expect(h.current.search).not.toContain("parentIsNull");
  });

  it("resets page to 1 when the label filter changes", () => {
    const h = renderParams("/tasks?page=3");

    act(() => h.current.api.setFilters({ label: ["web"] }));

    expect(h.current.api.params.page).toBe(1);
    expect(h.current.api.params.label).toEqual(["web"]);
  });

  it("clears the other half of the assignee pair on a partial patch", () => {
    const h = renderParams("/tasks?assigneeIsNull=true");

    act(() => h.current.api.setFilters({ assignee: "Alice Chen" }));

    expect(h.current.api.params.assignee).toBe("Alice Chen");
    expect(h.current.api.params.assigneeIsNull).toBeUndefined();
    expect(h.current.search).not.toContain("assigneeIsNull");
  });

  /**
   * The direction above cannot fail, and that is worth saying out loud: three
   * layers enforce this exclusion — the parser, `serializeTaskListParams`, and
   * `setFilters` — and **`assignee` wins in all three**. Setting `assignee` over
   * a live `assigneeIsNull` therefore comes out right even with `setFilters`'s
   * guard deleted, because serialize's `else if` already drops the loser.
   * (Verified: with the guard removed, that test still passes.)
   *
   * This is the direction where `assignee` losing is the *point*. Without the
   * guard, `merged` carries both, serialize keeps `assignee`, and picking
   * "Unassigned" while a name filter is active leaves the URL on
   * `?assignee=Alice+Chen` — the control visibly does nothing when clicked.
   */
  it("switches to unassigned over a live assignee filter, the direction serialize cannot rescue", () => {
    const h = renderParams("/tasks?assignee=Alice%20Chen");

    act(() => h.current.api.setFilters({ assigneeIsNull: true }));

    expect(h.current.api.params.assigneeIsNull).toBe(true);
    expect(h.current.api.params.assignee).toBeUndefined();
    expect(h.current.search).toContain("assigneeIsNull=true");
    expect(h.current.search).not.toContain("assignee=Alice");
  });

  /**
   * `serializeTaskListParams` carrying unknown keys is unit-tested as a pure
   * function. Nothing pinned that the **hook** hands it the previous params at
   * all — drop the second argument at the call site and the pure test stays
   * green while every shared link loses its campaign tag on the first click.
   */
  it("keeps an unknown parameter in the URL across a real write", () => {
    const h = renderParams("/tasks?utm_source=slack&status=todo");

    act(() => h.current.api.setFilters({ priority: ["urgent"] }));

    expect(h.current.search).toContain("utm_source=slack");
    expect(h.current.api.params.priority).toEqual(["urgent"]);
  });

  it("keeps both changes when two writes are issued before either commits", () => {
    const h = renderParams("/tasks");

    // Both calls run inside one `act`, so React has not re-rendered — and
    // therefore not produced a new `searchParams` — between them. This is the
    // real interleaving: `setSearchParams`'s functional form hands the updater
    // the params captured in the render that built the callback, so under the
    // old code the second write built on the pre-filter URL and dropped the
    // first. Navigation runs in a transition, so this window is frames wide.
    act(() => {
      h.current.api.setFilters({ status: ["todo"] });
      h.current.api.setFilters({ priority: ["urgent"] });
    });

    expect(h.current.api.params.status).toEqual(["todo"]);
    expect(h.current.api.params.priority).toEqual(["urgent"]);
  });

  it("resolves a functional patch against the state at write time", () => {
    const h = renderParams("/tasks?status=todo");

    act(() => {
      h.current.api.setFilters((current) => ({ status: [...current.status, "done"] }));
      h.current.api.setFilters((current) => ({ status: [...current.status, "blocked"] }));
    });

    // Three, not two: the second patch saw the first one's result.
    expect(h.current.api.params.status).toEqual(["todo", "done", "blocked"]);
  });

  it("drags the far date bound along instead of dropping it", () => {
    const h = renderParams("/tasks?createdTo=2026-08-01");

    act(() => h.current.api.setFilters({ createdFrom: "2026-09-01" }));

    expect(h.current.api.params.createdFrom).toBe("2026-09-01");
    // Not `undefined`: the parse-time drop would empty the field and its chip
    // with no explanation, while the discarded value sat on in the address bar.
    expect(h.current.api.params.createdTo).toBe("2026-09-01");
    expect(h.current.search).toContain("createdTo=2026-09-01");
  });

  it("drags the near bound down when the end date moves back past it", () => {
    const h = renderParams("/tasks?createdFrom=2026-09-01");

    act(() => h.current.api.setFilters({ createdTo: "2026-08-01" }));

    expect(h.current.api.params.createdFrom).toBe("2026-08-01");
    expect(h.current.api.params.createdTo).toBe("2026-08-01");
  });

  it("pushes a filter change so Back undoes it", async () => {
    const h = renderParams("/tasks?status=todo");

    act(() => h.current.api.setFilters({ status: ["done"] }));
    expect(h.current.api.params.status).toEqual(["done"]);

    await act(async () => {
      await h.router.navigate(-1);
    });
    expect(h.current.api.params.status).toEqual(["todo"]);
  });

  it("replaces rather than pushes when asked, so typing does not fill history", async () => {
    const h = renderParams("/tasks");

    // One pushed entry to land on, then two replaced ones standing in for
    // keystrokes that each got past the debounce.
    act(() => h.current.api.setFilters({ status: ["todo"] }));
    act(() => h.current.api.setFilters({ q: "pri" }, { replace: true }));
    act(() => h.current.api.setFilters({ q: "printer" }, { replace: true }));
    expect(h.current.api.params.q).toBe("printer");

    // A single Back leaves the search entirely. Were these pushes, it would step
    // back to `q=pri` and the whole search would take three presses to escape.
    await act(async () => {
      await h.router.navigate(-1);
    });
    expect(h.current.api.params.q).toBeUndefined();
    expect(h.current.api.params.status).toEqual([]);
  });
});
