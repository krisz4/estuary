import { act, render } from "@testing-library/react";
import { RouterProvider, createMemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  parseTicketListParams,
  serializeTicketListParams,
  useTicketListParams,
  type TicketListParams,
  type TicketListParamsApi,
} from "@/pages/tickets-list/useTicketListParams";

const parse = (search: string): TicketListParams =>
  parseTicketListParams(new URLSearchParams(search));

describe("parseTicketListParams", () => {
  it("picks the keys it knows and ignores the ones it does not", () => {
    // The regression this whole module exists for: feeding the raw params into
    // the server's `.strict()` schema fails on `utm_source` and resets
    // everything else to defaults.
    const params = parse("?utm_source=slack&fbclid=xyz&status=open&priority=urgent&page=3");

    expect(params.status).toEqual(["open"]);
    expect(params.priority).toEqual(["urgent"]);
    expect(params.page).toBe(3);
  });

  it("falls back per field, leaving valid neighbours alone", () => {
    const params = parse("?page=abc&pageSize=999&sort=nonsense&status=open&q=printer");

    expect(params.page).toBe(1);
    expect(params.pageSize).toBe(20);
    expect(params.sort).toEqual({ field: "createdAt", direction: "desc" });
    // The point of "per field": these two survived the three failures above.
    expect(params.status).toEqual(["open"]);
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
    expect(parse("?status=open&status=nope&status=open&status=closed").status).toEqual([
      "open",
      "closed",
    ]);
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
});

describe("serializeTicketListParams", () => {
  const base = parse("");

  it("omits every value that equals its default", () => {
    expect(serializeTicketListParams(base).toString()).toBe("");
  });

  it("writes only what differs", () => {
    const params: TicketListParams = { ...base, page: 3, status: ["open", "closed"] };
    expect(serializeTicketListParams(params).toString()).toBe("page=3&status=open&status=closed");
  });

  it("carries unknown keys through untouched", () => {
    const previous = new URLSearchParams("?utm_source=slack&page=9");
    const next = serializeTicketListParams({ ...base, page: 2 }, previous);

    expect(next.get("page")).toBe("2");
    expect(next.get("utm_source")).toBe("slack");
  });
});

/* ------------------------------------------------------------------ *
 * The hook
 * ------------------------------------------------------------------ */

type Harness = { api: TicketListParamsApi; search: string };

/**
 * Renders the hook inside a **real** router with real history, not a mocked
 * `useSearchParams`. Back and forward are the behaviour under test in two of
 * these cases, and a mock cannot have them.
 */
const renderParams = (initialEntry: string) => {
  const latest: { current: Harness | undefined } = { current: undefined };

  const Probe = () => {
    latest.current = { api: useTicketListParams(), search: useLocation().search };
    return null;
  };

  const router = createMemoryRouter([{ path: "/tickets", element: <Probe /> }], {
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

describe("useTicketListParams", () => {
  it("resets page to 1 when a filter changes", () => {
    const h = renderParams("/tickets?page=5&status=open");

    act(() => h.current.api.setFilters({ priority: ["urgent"] }));

    expect(h.current.api.params.page).toBe(1);
    expect(h.current.api.params.priority).toEqual(["urgent"]);
    expect(h.current.search).not.toContain("page=5");
  });

  it("resets page to 1 when sort changes", () => {
    const h = renderParams("/tickets?page=4");

    act(() => h.current.api.setSort({ field: "priority", direction: "desc" }));

    expect(h.current.api.params.page).toBe(1);
    expect(h.current.api.params.sort).toEqual({ field: "priority", direction: "desc" });
  });

  it("resets page to 1 when the page size changes", () => {
    const h = renderParams("/tickets?page=4&pageSize=10");

    act(() => h.current.api.setPageSize(50));

    expect(h.current.api.params.page).toBe(1);
    expect(h.current.api.params.pageSize).toBe(50);
  });

  it("leaves every filter alone when only the page changes", () => {
    const h = renderParams("/tickets?status=open&priority=urgent&q=printer&sort=title:asc");

    act(() => h.current.api.setPage(3));

    expect(h.current.api.params.page).toBe(3);
    expect(h.current.api.params.status).toEqual(["open"]);
    expect(h.current.api.params.priority).toEqual(["urgent"]);
    expect(h.current.api.params.q).toBe("printer");
    expect(h.current.api.params.sort).toEqual({ field: "title", direction: "asc" });
  });

  it("keeps sort and page size when filters are cleared", () => {
    const h = renderParams("/tickets?status=open&pageSize=50&sort=title:asc&page=2");

    act(() => h.current.api.clearFilters());

    expect(h.current.api.params.status).toEqual([]);
    expect(h.current.api.params.page).toBe(1);
    expect(h.current.api.params.pageSize).toBe(50);
    expect(h.current.api.params.sort).toEqual({ field: "title", direction: "asc" });
  });

  it("clears the other half of the assignee pair on a partial patch", () => {
    const h = renderParams("/tickets?assigneeIsNull=true");

    act(() => h.current.api.setFilters({ assignee: "Alice Chen" }));

    expect(h.current.api.params.assignee).toBe("Alice Chen");
    expect(h.current.api.params.assigneeIsNull).toBeUndefined();
    expect(h.current.search).not.toContain("assigneeIsNull");
  });

  it("keeps both changes when two writes are issued before either commits", () => {
    const h = renderParams("/tickets");

    // Both calls run inside one `act`, so React has not re-rendered — and
    // therefore not produced a new `searchParams` — between them. This is the
    // real interleaving: `setSearchParams`'s functional form hands the updater
    // the params captured in the render that built the callback, so under the
    // old code the second write built on the pre-filter URL and dropped the
    // first. Navigation runs in a transition, so this window is frames wide.
    act(() => {
      h.current.api.setFilters({ status: ["open"] });
      h.current.api.setFilters({ priority: ["urgent"] });
    });

    expect(h.current.api.params.status).toEqual(["open"]);
    expect(h.current.api.params.priority).toEqual(["urgent"]);
  });

  it("resolves a functional patch against the state at write time", () => {
    const h = renderParams("/tickets?status=open");

    act(() => {
      h.current.api.setFilters((current) => ({ status: [...current.status, "closed"] }));
      h.current.api.setFilters((current) => ({ status: [...current.status, "resolved"] }));
    });

    // Three, not two: the second patch saw the first one's result.
    expect(h.current.api.params.status).toEqual(["open", "closed", "resolved"]);
  });

  it("drags the far date bound along instead of dropping it", () => {
    const h = renderParams("/tickets?createdTo=2026-08-01");

    act(() => h.current.api.setFilters({ createdFrom: "2026-09-01" }));

    expect(h.current.api.params.createdFrom).toBe("2026-09-01");
    // Not `undefined`: the parse-time drop would empty the field and its chip
    // with no explanation, while the discarded value sat on in the address bar.
    expect(h.current.api.params.createdTo).toBe("2026-09-01");
    expect(h.current.search).toContain("createdTo=2026-09-01");
  });

  it("drags the near bound down when the end date moves back past it", () => {
    const h = renderParams("/tickets?createdFrom=2026-09-01");

    act(() => h.current.api.setFilters({ createdTo: "2026-08-01" }));

    expect(h.current.api.params.createdFrom).toBe("2026-08-01");
    expect(h.current.api.params.createdTo).toBe("2026-08-01");
  });

  it("pushes a filter change so Back undoes it", async () => {
    const h = renderParams("/tickets?status=open");

    act(() => h.current.api.setFilters({ status: ["closed"] }));
    expect(h.current.api.params.status).toEqual(["closed"]);

    await act(async () => {
      await h.router.navigate(-1);
    });
    expect(h.current.api.params.status).toEqual(["open"]);
  });

  it("replaces rather than pushes when asked, so typing does not fill history", async () => {
    const h = renderParams("/tickets");

    // One pushed entry to land on, then two replaced ones standing in for
    // keystrokes that each got past the debounce.
    act(() => h.current.api.setFilters({ status: ["open"] }));
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
