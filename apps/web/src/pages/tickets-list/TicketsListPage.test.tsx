import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type PaginatedTickets, type TicketSummary } from "@helpdesk/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setViewportWidth } from "../../../vitest.setup";
import { TicketsListPage } from "@/pages/tickets-list/TicketsListPage";

/* ------------------------------------------------------------------ *
 * Harness
 *
 * `fetch` is stubbed, not the query hooks: a test that mocks `useTicketsQuery`
 * proves the page renders whatever it is handed and says nothing about the URL
 * → request → render path, which is the entire subject of this stage. (Stage 13
 * owns replacing this with MSW handlers, which is the same boundary with a
 * nicer API.)
 * ------------------------------------------------------------------ */

const makeTicket = (id: number, overrides: Partial<TicketSummary> = {}): TicketSummary => ({
  id,
  reference: `HD-${String(id).padStart(6, "0")}`,
  title: `Ticket ${id}`,
  description: "Something is broken.",
  status: "open",
  priority: "medium",
  category: "hardware",
  requesterName: "Dana Reyes",
  requesterEmail: "dana@example.com",
  assignee: null,
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:00:00.000Z",
  resolvedAt: null,
  closedAt: null,
  commentCount: 0,
  ...overrides,
});

const page = (tickets: TicketSummary[], meta: Partial<PaginatedTickets["meta"]> = {}) => ({
  data: tickets,
  meta: {
    page: 1,
    pageSize: 20,
    total: tickets.length,
    totalPages: 1,
    hasNextPage: false,
    hasPrevPage: false,
    ...meta,
  },
});

/** Every list request the page issued, as parsed query strings. */
let listRequests: URLSearchParams[];

/**
 * A latch the list handler awaits, so a test can observe the in-flight state.
 * Without it every response resolves in the same microtask and "keeps the
 * previous rows visible while fetching" has no window to be observed in — the
 * probe would pass or fail for reasons unrelated to the behaviour.
 */
let listGate: { promise: Promise<void>; release: () => void } | null = null;

const holdListResponses = (): (() => void) => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = () => {
      listGate = null;
      resolve();
    };
  });
  listGate = { promise, release };
  return release;
};

type FetchStub = {
  list?: (query: URLSearchParams) => { status?: number; body: unknown };
};

const stubFetch = ({ list }: FetchStub = {}) => {
  listRequests = [];
  listGate = null;

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith("/tickets/facets")) {
      return new Response(JSON.stringify({ assignees: ["Alice Chen"], categories: ["hardware"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    listRequests.push(url.searchParams);
    if (listGate !== null) await listGate.promise;
    const result = list?.(url.searchParams) ?? { body: page([makeTicket(1)]) };
    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const renderPage = (entry = "/tickets") => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });

  const router = createMemoryRouter(
    [
      { path: "/tickets", element: <TicketsListPage /> },
      { path: "/tickets/new", element: <p>Create page</p> },
      { path: "/tickets/:ticketId", element: <p>Detail page</p> },
    ],
    { initialEntries: [entry] },
  );

  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  return router;
};

beforeEach(() => {
  setViewportWidth(1280);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ *
 * States
 * ------------------------------------------------------------------ */

describe("TicketsListPage states", () => {
  it("shows a skeleton before the first response, not a blank page", async () => {
    stubFetch();
    renderPage();

    expect(screen.getByRole("table", { name: /loading tickets/i })).toBeInTheDocument();
    await screen.findByRole("table", { name: /sorted by/i });
  });

  it("renders the rows and the count once loaded", async () => {
    stubFetch({ list: () => ({ body: page([makeTicket(1), makeTicket(2)], { total: 2 }) }) });
    renderPage();

    expect(await screen.findByRole("link", { name: "HD-000001" })).toHaveAttribute(
      "href",
      "/tickets/1",
    );
    expect(screen.getByText("Showing 1–2 of 2 tickets")).toBeInTheDocument();
  });

  it("shows an error panel with a working retry", async () => {
    const fetchMock = stubFetch({
      list: () => ({
        status: 500,
        body: { error: { code: "INTERNAL_ERROR", message: "boom", requestId: "req-1" } },
      }),
    });
    renderPage();

    expect(await screen.findByText(/something went wrong on the server/i)).toBeInTheDocument();
    const callsBefore = fetchMock.mock.calls.length;

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it("offers 'create' when nothing exists", async () => {
    stubFetch({ list: () => ({ body: page([]) }) });
    renderPage();

    expect(await screen.findByText("No tickets yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /create the first ticket/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /clear filters/i })).not.toBeInTheDocument();
  });

  it("offers 'clear filters' when a filter matched nothing", async () => {
    stubFetch({ list: () => ({ body: page([]) }) });
    renderPage("/tickets?status=closed");

    expect(await screen.findByText("No tickets match these filters")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
    expect(screen.queryByText("No tickets yet")).not.toBeInTheDocument();
  });

  it("offers 'back to page 1' past the end of a non-empty result", async () => {
    stubFetch({
      list: () => ({ body: page([], { page: 9, total: 63, totalPages: 4, hasPrevPage: true }) }),
    });
    renderPage("/tickets?page=9");

    expect(await screen.findByText("Nothing on this page")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to page 1" })).toBeInTheDocument();
  });

  it("dims and marks busy while refetching instead of blanking", async () => {
    stubFetch({
      list: (query) => ({
        body: page([makeTicket(Number(query.get("page") ?? 1))], {
          page: Number(query.get("page") ?? 1),
          total: 63,
          totalPages: 4,
          hasNextPage: true,
        }),
      }),
    });
    renderPage();

    await screen.findByRole("link", { name: "HD-000001" });

    const release = holdListResponses();
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));

    const busy = await waitFor(() => {
      const element = document.querySelector('[aria-busy="true"]');
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });

    // The previous page's rows are still mounted inside the busy container —
    // dimmed, not replaced by a skeleton.
    expect(within(busy).getByRole("table")).toBeInTheDocument();
    expect(within(busy).getByRole("link", { name: "HD-000001" })).toBeInTheDocument();

    release();
    await screen.findByRole("link", { name: "HD-000002" });
  });
});

/* ------------------------------------------------------------------ *
 * The URL rules
 * ------------------------------------------------------------------ */

describe("TicketsListPage URL behaviour", () => {
  it("resets page to 1 when a filter changes", async () => {
    stubFetch({
      list: (query) => ({
        body: page([makeTicket(1)], { page: Number(query.get("page") ?? 1), total: 63 }),
      }),
    });
    const router = renderPage("/tickets?page=3");

    await screen.findByRole("link", { name: "HD-000001" });
    await userEvent.click(screen.getByRole("checkbox", { name: "Open" }));

    await waitFor(() => expect(router.state.location.search).toContain("status=open"));
    expect(router.state.location.search).not.toContain("page=3");
    // The claim is about the *request*, not only the URL: an empty page 3 of a
    // 1-page result is what this rule exists to prevent.
    expect(listRequests.at(-1)?.get("page")).toBe("1");
  });

  it("keeps the filters when only the page changes", async () => {
    stubFetch({
      list: (query) => ({
        body: page([makeTicket(1)], {
          page: Number(query.get("page") ?? 1),
          total: 63,
          totalPages: 4,
          hasNextPage: true,
        }),
      }),
    });
    const router = renderPage("/tickets?status=open");

    await screen.findByRole("link", { name: "HD-000001" });
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));

    await waitFor(() => expect(router.state.location.search).toContain("page=2"));
    expect(router.state.location.search).toContain("status=open");
    expect(listRequests.at(-1)?.getAll("status")).toEqual(["open"]);
  });

  it("sorts through the URL when a column header is clicked", async () => {
    stubFetch();
    const router = renderPage();

    await screen.findByRole("link", { name: "HD-000001" });
    await userEvent.click(screen.getByRole("button", { name: /sort by priority/i }));

    await waitFor(() => expect(router.state.location.search).toContain("sort=priority%3Adesc"));
    expect(listRequests.at(-1)?.get("sort")).toBe("priority:desc");
  });

  it("never forwards an unknown parameter to the API", async () => {
    stubFetch();
    renderPage("/tickets?utm_source=slack&status=open");

    await screen.findByRole("link", { name: "HD-000001" });

    const request = listRequests.at(-1);
    expect(request?.get("utm_source")).toBeNull();
    expect(request?.getAll("status")).toEqual(["open"]);
  });

  it("does not rewrite the box when the user types a trailing space", async () => {
    stubFetch();
    renderPage();

    await screen.findByRole("link", { name: "HD-000001" });
    const box = screen.getByRole("searchbox", { name: /search tickets/i });

    // Commit a value that differs from its trimmed form, let it land in the URL,
    // then keep typing. Recording the untrimmed text as "what we committed" made
    // the sync effect see `"foo" !== "foo "`, decide the URL had moved on its
    // own, and overwrite the focused input — "foo " + "bar" came out "foobar"
    // and searched for the wrong term.
    await userEvent.type(box, "foo ");
    await waitFor(() => expect(listRequests.at(-1)?.get("q")).toBe("foo"));

    await userEvent.type(box, "bar");
    expect(box).toHaveValue("foo bar");

    await waitFor(() => expect(listRequests.at(-1)?.get("q")).toBe("foo bar"));
  });

  it("keeps both filters when two chips are clicked in the same frame", async () => {
    stubFetch();
    const router = renderPage();

    await screen.findByRole("link", { name: "HD-000001" });
    const open = screen.getByRole("checkbox", { name: "Open" });
    const urgent = screen.getByRole("checkbox", { name: "Urgent" });

    // Dispatched without awaiting a commit in between, so both handlers run
    // against the same rendered `selected` array.
    act(() => {
      fireEvent.click(open);
      fireEvent.click(urgent);
    });

    await waitFor(() => expect(router.state.location.search).toContain("priority=urgent"));
    expect(router.state.location.search).toContain("status=open");
  });

  it("keeps both values when two chips in the *same* group are clicked in one frame", async () => {
    stubFetch();
    const router = renderPage();

    await screen.findByRole("link", { name: "HD-000001" });

    // Two chips in one group is the case the previous test cannot see: with two
    // different groups, each write touches a different field and a stale base
    // still produces the right merge. Within one group both writes target
    // `status`, so a chip that computes the next array from its render-time
    // props sends ["open"] and then ["closed"] — and the first disappears.
    act(() => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Open" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Closed" }));
    });

    await waitFor(() => expect(router.state.location.search).toContain("status=closed"));
    expect(listRequests.at(-1)?.getAll("status")).toEqual(["open", "closed"]);
  });

  it("debounces the search box, so seven keystrokes are one request", async () => {
    stubFetch();
    renderPage();

    await screen.findByRole("link", { name: "HD-000001" });
    await userEvent.type(screen.getByRole("searchbox", { name: /search tickets/i }), "printer");

    await waitFor(() => expect(listRequests.at(-1)?.get("q")).toBe("printer"));

    // The claim is not "a request eventually carried the whole word" — it is
    // that the prefixes never went out. Undebounced, this array would read
    // ["p","pr","pri","prin","print","printe","printer"].
    const searched = listRequests
      .map((request) => request.get("q"))
      .filter((value): value is string => value !== null);
    expect(searched).toEqual(["printer"]);
  });
});

/* ------------------------------------------------------------------ *
 * Responsive
 * ------------------------------------------------------------------ */

describe("TicketsListPage responsive swap", () => {
  it("renders the table and no cards at 1280", async () => {
    stubFetch();
    setViewportWidth(1280);
    renderPage();

    await screen.findByRole("link", { name: "HD-000001" });
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("renders the table at exactly 768, the md boundary", async () => {
    stubFetch();
    setViewportWidth(768);
    renderPage();

    await screen.findByRole("link", { name: "HD-000001" });
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("renders cards and no table at 360", async () => {
    stubFetch();
    setViewportWidth(360);
    renderPage();

    await screen.findByRole("link", { name: /HD-000001/ });
    // Not "the table is hidden" — it is not in the document at all, so there is
    // no second copy of every ticket link to keep in step.
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByRole("list")).toBeInTheDocument();
    // The whole card is the link, which is the tradeoff the table cannot make.
    expect(screen.getByRole("link", { name: /HD-000001/ })).toHaveAttribute("href", "/tickets/1");
  });

  it("puts the filters behind a sheet trigger below md and inline above it", async () => {
    stubFetch();
    setViewportWidth(360);
    renderPage("/tickets?status=open&priority=urgent");

    await screen.findByRole("link", { name: /HD-000001/ });
    expect(screen.getByRole("button", { name: /filters, 2 active/i })).toBeInTheDocument();
    // The chip group lives in the sheet, so it is not rendered until it opens.
    expect(screen.queryByRole("checkbox", { name: "Open" })).not.toBeInTheDocument();
  });
});
