import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type TicketStatus, type TicketSummary } from "@helpdesk/contracts";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TicketDetailPage } from "@/pages/ticket-detail/TicketDetailPage";
import { TicketsBoardPage } from "@/pages/tickets-board/TicketsBoardPage";
import { TicketsListPage } from "@/pages/tickets-list/TicketsListPage";
import { queryKeys } from "@/api/queryKeys";
import { makeTicket, mockApi, renderRoute, type MockRequest } from "@/test/harness";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

/**
 * Board tests.
 *
 * **The mock API holds state.** Every other screen in this suite can answer from
 * a fixed body, but a move is only interesting because of what happens *after*
 * it: the PATCH lands, `onSettled` invalidates, all four columns refetch, and
 * the optimistic entry is dropped. Against a static mock the refetch would hand
 * back the pre-move world and the card would be seen to snap back — a failure
 * the assertion could not tell apart from a real rollback bug. So the store
 * below applies the PATCH, and "the card is in In progress" means the server
 * agrees rather than that the optimism has not expired yet.
 *
 * Dragging itself is not exercised here. `@dnd-kit` is driven by pointer
 * geometry — `MouseSensor` needs a 6px move, and collision detection needs
 * layout jsdom does not compute (every rect is 0×0) — so a "drag" in jsdom
 * asserts on the mock's arithmetic, not on the app. The **drop path is the same
 * `move()`** the status select calls, and that is what these tests drive; the
 * real drag is covered end-to-end in `e2e/board.spec.ts`, in a browser that has
 * a layout.
 */

const summary = (overrides: Partial<TicketSummary> = {}): TicketSummary => {
  const { comments: _comments, ...rest } = makeTicket();
  return { ...rest, ...overrides };
};

const STATUSES: TicketStatus[] = ["open", "in_progress", "resolved", "closed"];

/** Every ticket id the fixtures below move. */
const PATCHABLE_IDS = [1, 2, 3, 4, 5];

/** The mutable world the handlers answer from. */
let store: TicketSummary[] = [];
/** `id → the error a PATCH of that ticket should fail with`, when it should. */
let patchFailure: { status: number; body: unknown } | undefined;

const boardApi = (): { requests: MockRequest[] } =>
  mockApi({
    "GET /tickets/facets": () => ({ body: { assignees: [], categories: [] } }),

    "GET /tickets": ({ url }) => {
      const status = url.searchParams.get("status");
      const pageSize = Number(url.searchParams.get("pageSize") ?? "20");
      // No `status` is the *list* page asking for everything. The board always
      // sends one — a column is a status — so this branch only serves the list
      // route these tests render alongside it.
      const matching = status === null ? store : store.filter((ticket) => ticket.status === status);
      const data = matching.slice(0, pageSize);

      return {
        body: {
          data,
          meta: {
            page: 1,
            pageSize,
            total: matching.length,
            totalPages: Math.max(1, Math.ceil(matching.length / pageSize)),
            hasNextPage: data.length < matching.length,
            hasPrevPage: false,
          },
        },
      };
    },

    /* For the round trip through the detail page. Same suffix rule as PATCH. */
    "GET /tickets/1": () => ({
      body: makeTicket({ id: 1, reference: "HD-000001", title: "Printer jam", status: "open" }),
    }),

    /*
      `mockApi` matches a handler by *path suffix*, so one `"PATCH /tickets"` key
      would never match `/api/v1/tickets/5`. One key per id it is — and the
      suffixes stay unambiguous, because `/tickets/15` does not end with
      `/tickets/5`.
    */
    ...Object.fromEntries(
      PATCHABLE_IDS.map((id) => [
        `PATCH /tickets/${id}`,
        ({ body }: MockRequest) => {
          if (patchFailure !== undefined) return patchFailure;

          const next = (body as { status: TicketStatus }).status;
          store = store.map((ticket) => (ticket.id === id ? { ...ticket, status: next } : ticket));

          return { body: { ...makeTicket({ id, status: next }), comments: [] } };
        },
      ]),
    ),
  });

const routes = [
  { path: "/tickets", element: <TicketsListPage /> },
  { path: "/tickets/board", element: <TicketsBoardPage /> },
];

const renderBoard = (initialEntry = "/tickets/board") =>
  renderRoute({ routes, initialEntries: [initialEntry] });

/** The `<section>` for one column, found by the label that carries its count. */
const column = (label: string) => screen.getByRole("region", { name: new RegExp(`^${label} —`) });

const moveCardTo = async (
  user: ReturnType<typeof userEvent.setup>,
  reference: string,
  target: string,
) => {
  await user.click(
    screen.getByRole("combobox", { name: `Move ticket ${reference} to another status` }),
  );
  await user.click(await screen.findByRole("option", { name: target }));
};

beforeEach(() => {
  vi.clearAllMocks();
  patchFailure = undefined;
  store = [
    summary({ id: 1, status: "open", title: "Printer jam" }),
    summary({ id: 2, status: "open", title: "VPN drops" }),
    summary({ id: 3, status: "in_progress", title: "Laptop swap" }),
    summary({ id: 4, status: "resolved", title: "Password reset" }),
    summary({ id: 5, status: "closed", title: "Monitor flicker" }),
  ];
});

describe("TicketsBoardPage — layout", () => {
  it("renders one column per status, each fetched with its own status filter", async () => {
    const { requests } = boardApi();

    renderBoard();

    expect(await screen.findByText("Printer jam")).toBeInTheDocument();

    for (const label of ["Open", "In progress", "Resolved", "Closed"]) {
      expect(column(label)).toBeInTheDocument();
    }

    // Two tickets are open, and the column label is what a screen reader reads.
    expect(column("Open")).toHaveAccessibleName("Open — 2 tickets");
    expect(column("Resolved")).toHaveAccessibleName("Resolved — 1 ticket");

    const listRequests = requests.filter((request) => request.url.pathname.endsWith("/tickets"));
    expect(listRequests).toHaveLength(4);
    expect(listRequests.map((request) => request.url.searchParams.get("status")).sort()).toEqual(
      [...STATUSES].sort(),
    );
    for (const request of listRequests) {
      expect(request.url.searchParams.get("pageSize")).toBe("25");
      expect(request.url.searchParams.get("page")).toBe("1");
    }
  });

  it("puts each ticket in the column for its status", async () => {
    boardApi();

    renderBoard();

    expect(await screen.findByText("Printer jam")).toBeInTheDocument();
    expect(within(column("Open")).getByText("VPN drops")).toBeInTheDocument();
    expect(within(column("In progress")).getByText("Laptop swap")).toBeInTheDocument();
    expect(within(column("Closed")).getByText("Monitor flicker")).toBeInTheDocument();
  });

  /**
   * The status filter is the one URL key the board reads differently from the
   * list: here it chooses columns rather than filtering rows. See the note in
   * `TicketsBoardPage`.
   */
  it("shows only the filtered statuses as columns, in lifecycle order", async () => {
    boardApi();

    renderBoard("/tickets/board?status=resolved&status=open");

    expect(await screen.findByText("Printer jam")).toBeInTheDocument();

    const regions = screen
      .getAllByRole("region")
      .map((region) => region.getAttribute("aria-label"));
    expect(regions).toEqual(["Open — 2 tickets", "Resolved — 1 ticket"]);
  });

  it("forwards the list's filters to every column request", async () => {
    const { requests } = boardApi();

    renderBoard("/tickets/board?priority=urgent&q=vpn&sort=priority%3Aasc");

    await waitFor(() => {
      expect(requests.filter((r) => r.url.pathname.endsWith("/tickets"))).toHaveLength(4);
    });

    for (const request of requests.filter((r) => r.url.pathname.endsWith("/tickets"))) {
      expect(request.url.searchParams.get("priority")).toBe("urgent");
      expect(request.url.searchParams.get("q")).toBe("vpn");
      expect(request.url.searchParams.get("sort")).toBe("priority:asc");
    }
  });

  it("raises the page size of one column only when it loads more", async () => {
    const user = userEvent.setup();
    store = Array.from({ length: 30 }, (_, index) =>
      summary({ id: index + 1, status: "open", title: `Open ticket ${index + 1}` }),
    );
    const { requests } = boardApi();

    renderBoard();

    expect(await screen.findByText("Open ticket 1")).toBeInTheDocument();
    expect(within(column("Open")).queryByText("Open ticket 26")).not.toBeInTheDocument();

    await user.click(within(column("Open")).getByRole("button", { name: "Load more" }));

    expect(await within(column("Open")).findByText("Open ticket 26")).toBeInTheDocument();

    const pageSizes = requests
      .filter((request) => request.url.pathname.endsWith("/tickets"))
      .map(
        (request) =>
          `${request.url.searchParams.get("status")}:${request.url.searchParams.get("pageSize")}`,
      );

    expect(pageSizes).toContain("open:50");
    expect(pageSizes.filter((entry) => entry.endsWith(":50"))).toHaveLength(1);
  });
});

describe("TicketsBoardPage — moving a ticket", () => {
  it("PATCHes the status and lands the card in the new column", async () => {
    const user = userEvent.setup();
    const { requests } = boardApi();

    renderBoard();

    expect(await screen.findByText("Printer jam")).toBeInTheDocument();

    await moveCardTo(user, "HD-000001", "In progress");

    await waitFor(() => {
      expect(within(column("In progress")).getByText("Printer jam")).toBeInTheDocument();
    });
    expect(within(column("Open")).queryByText("Printer jam")).not.toBeInTheDocument();

    const patch = requests.find((request) => request.method === "PATCH");
    expect(patch?.url.pathname).toMatch(/\/tickets\/1$/);
    expect(patch?.body).toEqual({ status: "in_progress" });

    expect(toast.success).toHaveBeenCalledWith("HD-000001 moved to In progress");
  });

  it("moves the counts with the card, not only the card", async () => {
    const user = userEvent.setup();
    boardApi();

    renderBoard();

    expect(await screen.findByText("Printer jam")).toBeInTheDocument();
    expect(column("Open")).toHaveAccessibleName("Open — 2 tickets");

    await moveCardTo(user, "HD-000001", "Resolved");

    await waitFor(() => {
      expect(column("Open")).toHaveAccessibleName("Open — 1 ticket");
    });
    expect(column("Resolved")).toHaveAccessibleName("Resolved — 2 tickets");
  });

  /**
   * The transition table lives on the server. The board offers every column to
   * every card on purpose, so a rejection has to be survivable.
   */
  it("puts the card back and quotes the server's allowed targets on a 409", async () => {
    const user = userEvent.setup();
    patchFailure = {
      status: 409,
      body: {
        error: {
          code: "INVALID_STATUS_TRANSITION",
          message: "closed cannot become resolved",
          details: { from: "closed", to: "resolved", allowed: ["open", "in_progress"] },
          requestId: "req-1",
        },
      },
    };
    boardApi();

    renderBoard();

    expect(await screen.findByText("Monitor flicker")).toBeInTheDocument();

    await moveCardTo(user, "HD-000005", "Resolved");

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("That status change is not allowed", {
        description: "Not allowed from here. You can move it to Open or In progress instead.",
      });
    });

    expect(within(column("Closed")).getByText("Monitor flicker")).toBeInTheDocument();
    expect(within(column("Resolved")).queryByText("Monitor flicker")).not.toBeInTheDocument();
  });

  /**
   * A card is a link, so "click into the ticket while the move is in flight" is
   * one gesture away. Without the optimistic detail write the ticket page would
   * render the cached pre-move status while the board behind it showed the new
   * one.
   */
  it("writes the new status into the detail cache before the server answers", async () => {
    const user = userEvent.setup();
    let release = () => {};
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });

    mockApi({
      "GET /tickets/facets": () => ({ body: { assignees: [], categories: [] } }),
      "GET /tickets": ({ url }) => {
        const status = url.searchParams.get("status");
        const data = store.filter((ticket) => ticket.status === status);
        return {
          body: {
            data,
            meta: {
              page: 1,
              pageSize: 25,
              total: data.length,
              totalPages: 1,
              hasNextPage: false,
              hasPrevPage: false,
            },
          },
        };
      },
      "PATCH /tickets/1": async () => {
        await inFlight;
        return { status: 409, body: patchFailure?.body };
      },
    });

    /*
      Not `makeQueryClient()`: its `gcTime: 0` collects an observer-less entry
      the instant it is written, and the detail row seeded below has no observer
      (the detail page is not mounted — that is the whole scenario). The app's
      own client uses the 5-minute default, so this is the realistic setting, not
      a lenient one.
    */
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 60_000, staleTime: 0 },
        mutations: { retry: false },
      },
    });

    // The ticket has been visited, so its detail row is in the cache — which is
    // the only case an optimistic write or a rollback can apply to.
    queryClient.setQueryData(queryKeys.tickets.detail(1), makeTicket({ id: 1, status: "open" }));

    patchFailure = {
      status: 409,
      body: {
        error: {
          code: "INVALID_STATUS_TRANSITION",
          message: "no",
          details: { from: "open", to: "resolved", allowed: ["in_progress"] },
          requestId: "req-2",
        },
      },
    };

    renderRoute({ routes, initialEntries: ["/tickets/board"], queryClient });

    expect(await screen.findByText("Printer jam")).toBeInTheDocument();

    await moveCardTo(user, "HD-000001", "Resolved");

    await waitFor(() => {
      expect(
        queryClient.getQueryData<{ status: string }>(queryKeys.tickets.detail(1))?.status,
      ).toBe("resolved");
    });

    release();

    // …and the rejection puts the cached row back, rather than leaving the
    // detail page insisting on a status the server refused.
    await waitFor(() => {
      expect(
        queryClient.getQueryData<{ status: string }>(queryKeys.tickets.detail(1))?.status,
      ).toBe("open");
    });
  });

  /**
   * A status change cannot add or remove an assignee or a category, and the
   * board keeps a facets observer mounted — so `tickets.all` would fire a
   * request per drag that can never return anything new.
   */
  it("refetches the lists and the ticket's detail, but not the facets", async () => {
    const user = userEvent.setup();
    const { requests } = boardApi();

    renderBoard();

    expect(await screen.findByText("Printer jam")).toBeInTheDocument();

    const listsBefore = requests.filter((r) => r.url.pathname.endsWith("/tickets")).length;

    await moveCardTo(user, "HD-000001", "In progress");

    await waitFor(() => {
      expect(within(column("In progress")).getByText("Printer jam")).toBeInTheDocument();
    });

    expect(requests.filter((r) => r.url.pathname.endsWith("/tickets")).length).toBeGreaterThan(
      listsBefore,
    );
    expect(requests.filter((r) => r.url.pathname.endsWith("/facets"))).toHaveLength(1);
  });

  it("does not PATCH when the card is set to the status it already has", async () => {
    const user = userEvent.setup();
    const { requests } = boardApi();

    renderBoard();

    expect(await screen.findByText("Printer jam")).toBeInTheDocument();

    await moveCardTo(user, "HD-000001", "Open");

    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });
});

describe("ViewSwitch", () => {
  it("carries the filters from the list to the board and back", async () => {
    const user = userEvent.setup();
    boardApi();

    const { router } = renderRoute({
      routes,
      initialEntries: ["/tickets?priority=urgent&q=vpn"],
    });

    await user.click(await screen.findByRole("link", { name: "Board" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tickets/board");
    });
    expect(router.state.location.search).toBe("?priority=urgent&q=vpn");

    await user.click(screen.getByRole("link", { name: "List" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tickets");
    });
    expect(router.state.location.search).toBe("?priority=urgent&q=vpn");
  });
});

/**
 * The regression this suite exists for: the board is a *second* list route, and
 * every screen reached from it has to know which of the two to go back to.
 * `location.state.from` carries only the search string, so before the view
 * store the back link took a board user to `/tickets` — same filters, wrong
 * screen.
 */
describe("the remembered view", () => {
  const routesWithDetail = [
    ...routes,
    { path: "/tickets/:ticketId", element: <TicketDetailPage /> },
  ];

  it("returns to the board — with its filters — from a ticket opened on it", async () => {
    const user = userEvent.setup();
    boardApi();

    const { router } = renderRoute({
      routes: routesWithDetail,
      initialEntries: ["/tickets/board?priority=urgent"],
    });

    await user.click(await screen.findByRole("link", { name: "HD-000001" }));

    const back = await screen.findByRole("link", { name: /back to tickets/i });
    expect(back).toHaveAttribute("href", "/tickets/board?priority=urgent");

    await user.click(back);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tickets/board");
    });
    expect(router.state.location.search).toBe("?priority=urgent");
  });

  it("returns to the list from a ticket opened on the list", async () => {
    const user = userEvent.setup();
    boardApi();

    renderRoute({
      routes: routesWithDetail,
      initialEntries: ["/tickets?priority=urgent"],
    });

    await user.click(await screen.findByRole("link", { name: "HD-000001" }));

    expect(await screen.findByRole("link", { name: /back to tickets/i })).toHaveAttribute(
      "href",
      "/tickets?priority=urgent",
    );
  });

  /*
    Switching view is what changes the answer — not the ticket, and not the
    history entry the detail page happens to sit on.
  */
  it("follows the view the user switched to before opening the ticket", async () => {
    const user = userEvent.setup();
    boardApi();

    renderRoute({ routes: routesWithDetail, initialEntries: ["/tickets"] });

    await user.click(await screen.findByRole("link", { name: "Board" }));
    await user.click(await screen.findByRole("link", { name: "HD-000001" }));

    expect(await screen.findByRole("link", { name: /back to tickets/i })).toHaveAttribute(
      "href",
      "/tickets/board",
    );
  });
});
