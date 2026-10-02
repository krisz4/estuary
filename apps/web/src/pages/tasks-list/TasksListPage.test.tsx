import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type PaginatedTasks, type TaskSummary } from "@estuary/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { setViewportWidth } from "../../../vitest.setup";
import { TasksListPage } from "@/pages/tasks-list/TasksListPage";
import { makeStats, makeSummary, mockApi } from "@/test/harness";

/* ------------------------------------------------------------------ *
 * Harness
 *
 * The network is mocked, not the query hooks: a test that mocks
 * `useTasksQuery` proves the page renders whatever it is handed and says
 * nothing about the URL → request → render path, which is the entire subject of
 * these tests. Stage 13 moved this file off its own private `fetch` stub and
 * onto the shared MSW seam in `src/test/harness.tsx`.
 * ------------------------------------------------------------------ */

const makeTask = (id: number, overrides: Partial<TaskSummary> = {}): TaskSummary =>
  makeSummary({
    id,
    reference: `TASK-${String(id).padStart(6, "0")}`,
    title: `Task ${id}`,
    status: "todo",
    ...overrides,
  });

const page = (tasks: TaskSummary[], meta: Partial<PaginatedTasks["meta"]> = {}) => ({
  data: tasks,
  meta: {
    page: 1,
    pageSize: 20,
    total: tasks.length,
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

const stubApi = ({ list }: FetchStub = {}) => {
  listRequests = [];
  listGate = null;

  // Key order is load-bearing: the harness matches by path *suffix* and takes
  // the first hit, and `/api/v1/tasks/facets` ends with `/tasks/facets`
  // before it ends with anything else. Declaring the list first would answer
  // every facets request with a page of tasks. Same trap as the API's own
  // route ordering (stage 8: facets before `:taskId`).
  const { requests } = mockApi({
    "GET /tasks/facets": () => ({
      body: { assignees: ["Alice Chen"], projects: ["estuary"], creators: ["agent:claude-code"] },
    }),
    // The header's "Clean up done" button reads its count from here.
    "GET /tasks/stats": () => ({ body: makeStats() }),
    "GET /tasks": async ({ url }) => {
      listRequests.push(url.searchParams);
      if (listGate !== null) await listGate.promise;
      return list?.(url.searchParams) ?? { body: page([makeTask(1)]) };
    },
  });

  return requests;
};

const renderPage = (entry = "/tasks") => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });

  const router = createMemoryRouter(
    [
      { path: "/tasks", element: <TasksListPage /> },
      { path: "/tasks/new", element: <p>Create page</p> },
      { path: "/tasks/:taskId", element: <p>Detail page</p> },
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

/* ------------------------------------------------------------------ *
 * States
 * ------------------------------------------------------------------ */

describe("TasksListPage states", () => {
  it("shows a skeleton before the first response, not a blank page", async () => {
    stubApi();
    renderPage();

    expect(screen.getByRole("table", { name: /loading tasks/i })).toBeInTheDocument();
    await screen.findByRole("table", { name: /sorted by/i });
  });

  it("renders the rows and the count once loaded", async () => {
    stubApi({ list: () => ({ body: page([makeTask(1), makeTask(2)], { total: 2 }) }) });
    renderPage();

    expect(await screen.findByRole("link", { name: "TASK-000001" })).toHaveAttribute(
      "href",
      "/tasks/1",
    );
    expect(screen.getByText("Showing 1–2 of 2 tasks")).toBeInTheDocument();
  });

  it("shows an error panel with a working retry", async () => {
    stubApi({
      list: () => ({
        status: 500,
        body: { error: { code: "INTERNAL_ERROR", message: "boom", requestId: "req-1" } },
      }),
    });
    renderPage();

    expect(await screen.findByText(/something went wrong on the server/i)).toBeInTheDocument();
    const listCallsBefore = listRequests.length;

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    // The claim is that Retry re-issues the *list* request. Counting every
    // request the page made would also be satisfied by a facets refetch, which
    // is not what the button says it does.
    await waitFor(() => expect(listRequests.length).toBeGreaterThan(listCallsBefore));
  });

  it("offers 'create' when nothing exists", async () => {
    stubApi({ list: () => ({ body: page([]) }) });
    renderPage();

    expect(await screen.findByText("No tasks yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /create the first task/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /clear filters/i })).not.toBeInTheDocument();
  });

  it("offers 'clear filters' when a filter matched nothing", async () => {
    stubApi({ list: () => ({ body: page([]) }) });
    renderPage("/tasks?status=done");

    expect(await screen.findByText("No tasks match these filters")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
    expect(screen.queryByText("No tasks yet")).not.toBeInTheDocument();
  });

  it("offers 'back to page 1' past the end of a non-empty result", async () => {
    stubApi({
      list: () => ({ body: page([], { page: 9, total: 63, totalPages: 4, hasPrevPage: true }) }),
    });
    renderPage("/tasks?page=9");

    expect(await screen.findByText("Nothing on this page")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to page 1" })).toBeInTheDocument();
  });

  it("dims and marks busy while refetching instead of blanking", async () => {
    stubApi({
      list: (query) => ({
        body: page([makeTask(Number(query.get("page") ?? 1))], {
          page: Number(query.get("page") ?? 1),
          total: 63,
          totalPages: 4,
          hasNextPage: true,
        }),
      }),
    });
    renderPage();

    await screen.findByRole("link", { name: "TASK-000001" });

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
    expect(within(busy).getByRole("link", { name: "TASK-000001" })).toBeInTheDocument();

    release();
    await screen.findByRole("link", { name: "TASK-000002" });
  });
});

/* ------------------------------------------------------------------ *
 * The URL rules
 * ------------------------------------------------------------------ */

describe("TasksListPage URL behaviour", () => {
  it("resets page to 1 when a filter changes", async () => {
    stubApi({
      list: (query) => ({
        body: page([makeTask(1)], { page: Number(query.get("page") ?? 1), total: 63 }),
      }),
    });
    const router = renderPage("/tasks?page=3");

    await screen.findByRole("link", { name: "TASK-000001" });
    await userEvent.click(screen.getByRole("checkbox", { name: "To do" }));

    await waitFor(() => expect(router.state.location.search).toContain("status=todo"));
    expect(router.state.location.search).not.toContain("page=3");
    // The claim is about the *request*, not only the URL: an empty page 3 of a
    // 1-page result is what this rule exists to prevent.
    expect(listRequests.at(-1)?.get("page")).toBe("1");
  });

  it("keeps the filters when only the page changes", async () => {
    stubApi({
      list: (query) => ({
        body: page([makeTask(1)], {
          page: Number(query.get("page") ?? 1),
          total: 63,
          totalPages: 4,
          hasNextPage: true,
        }),
      }),
    });
    const router = renderPage("/tasks?status=todo");

    await screen.findByRole("link", { name: "TASK-000001" });
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));

    await waitFor(() => expect(router.state.location.search).toContain("page=2"));
    expect(router.state.location.search).toContain("status=todo");
    expect(listRequests.at(-1)?.getAll("status")).toEqual(["todo"]);
  });

  it("sorts through the URL when a column header is clicked", async () => {
    stubApi();
    const router = renderPage();

    await screen.findByRole("link", { name: "TASK-000001" });
    await userEvent.click(screen.getByRole("button", { name: /sort by priority/i }));

    await waitFor(() => expect(router.state.location.search).toContain("sort=priority%3Adesc"));
    expect(listRequests.at(-1)?.get("sort")).toBe("priority:desc");
  });

  it("never forwards an unknown parameter to the API", async () => {
    stubApi();
    renderPage("/tasks?utm_source=slack&status=todo");

    await screen.findByRole("link", { name: "TASK-000001" });

    const request = listRequests.at(-1);
    expect(request?.get("utm_source")).toBeNull();
    expect(request?.getAll("status")).toEqual(["todo"]);
  });

  it("does not rewrite the box when the user types a trailing space", async () => {
    stubApi();
    renderPage();

    await screen.findByRole("link", { name: "TASK-000001" });
    const box = screen.getByRole("searchbox", { name: /search tasks/i });

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
    stubApi();
    const router = renderPage();

    await screen.findByRole("link", { name: "TASK-000001" });
    const open = screen.getByRole("checkbox", { name: "To do" });
    const urgent = screen.getByRole("checkbox", { name: "Urgent" });

    // Dispatched without awaiting a commit in between, so both handlers run
    // against the same rendered `selected` array.
    act(() => {
      fireEvent.click(open);
      fireEvent.click(urgent);
    });

    await waitFor(() => expect(router.state.location.search).toContain("priority=urgent"));
    expect(router.state.location.search).toContain("status=todo");
  });

  it("keeps both values when two chips in the *same* group are clicked in one frame", async () => {
    stubApi();
    const router = renderPage();

    await screen.findByRole("link", { name: "TASK-000001" });

    // Two chips in one group is the case the previous test cannot see: with two
    // different groups, each write touches a different field and a stale base
    // still produces the right merge. Within one group both writes target
    // `status`, so a chip that computes the next array from its render-time
    // props sends ["todo"] and then ["done"] — and the first disappears.
    act(() => {
      fireEvent.click(screen.getByRole("checkbox", { name: "To do" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Done" }));
    });

    await waitFor(() => expect(router.state.location.search).toContain("status=done"));
    expect(listRequests.at(-1)?.getAll("status")).toEqual(["todo", "done"]);
  });

  it("debounces the search box, so seven keystrokes are one request", async () => {
    stubApi();
    renderPage();

    await screen.findByRole("link", { name: "TASK-000001" });
    await userEvent.type(screen.getByRole("searchbox", { name: /search tasks/i }), "printer");

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

describe("TasksListPage responsive swap", () => {
  it("renders the table and no cards at 1280", async () => {
    stubApi();
    setViewportWidth(1280);
    renderPage();

    await screen.findByRole("link", { name: "TASK-000001" });
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("renders the table at exactly 768, the md boundary", async () => {
    stubApi();
    setViewportWidth(768);
    renderPage();

    await screen.findByRole("link", { name: "TASK-000001" });
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("renders cards and no table at 360", async () => {
    stubApi();
    setViewportWidth(360);
    renderPage();

    await screen.findByRole("link", { name: /TASK-000001/ });
    // Not "the table is hidden" — it is not in the document at all, so there is
    // no second copy of every task link to keep in step.
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByRole("list")).toBeInTheDocument();
    // The whole card is the link, which is the tradeoff the table cannot make.
    expect(screen.getByRole("link", { name: /TASK-000001/ })).toHaveAttribute("href", "/tasks/1");
  });

  it("puts the filters behind a sheet trigger below md and inline above it", async () => {
    stubApi();
    setViewportWidth(360);
    renderPage("/tasks?status=todo&priority=urgent");

    await screen.findByRole("link", { name: /TASK-000001/ });
    expect(screen.getByRole("button", { name: /filters, 2 active/i })).toBeInTheDocument();
    // The chip group lives in the sheet, so it is not rendered until it opens.
    expect(screen.queryByRole("checkbox", { name: "To do" })).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Who and where: project and creator
 * ------------------------------------------------------------------ */

describe("TasksListPage — project and creator", () => {
  it("forwards project and createdBy filters from the URL to the request", async () => {
    stubApi();
    renderPage("/tasks?project=estuary&project=mcp-server&createdBy=agent%3Aclaude-code");

    await screen.findByRole("link", { name: "TASK-000001" });
    expect(listRequests.at(-1)?.getAll("project")).toEqual(["estuary", "mcp-server"]);
    expect(listRequests.at(-1)?.get("createdBy")).toBe("agent:claude-code");
  });

  it("drops a project that is not a slug and a creator that is not an actor, keeping the rest", async () => {
    stubApi();
    renderPage("/tasks?project=Not%20A%20Slug&project=estuary&createdBy=claude&status=todo");

    await screen.findByRole("link", { name: "TASK-000001" });
    expect(listRequests.at(-1)?.getAll("project")).toEqual(["estuary"]);
    expect(listRequests.at(-1)?.get("createdBy")).toBeNull();
    expect(listRequests.at(-1)?.getAll("status")).toEqual(["todo"]);
  });

  it("shows each row's project and an agent/human creator in the table", async () => {
    stubApi({
      list: () => ({
        body: page([
          makeTask(1, { project: "estuary", createdBy: "agent:claude-code" }),
          makeTask(2, { project: null, createdBy: "human:krisz" }),
        ]),
      }),
    });
    renderPage();

    await screen.findByRole("link", { name: "TASK-000001" });
    const [, first, second] = screen.getAllByRole("row");
    expect(first).toHaveTextContent("estuary");
    expect(first).toHaveTextContent("Agent claude-code");
    expect(second).toHaveTextContent("Human krisz");
  });

  it("flags a claimed row and an open question under its title", async () => {
    stubApi({
      list: () => ({
        body: page([
          makeTask(1, {
            claim: { actor: "agent:claude-code", expiresAt: "2099-01-01T00:00:00.000Z" },
            openDependencyCount: 1,
          }),
        ]),
      }),
    });
    renderPage();

    await screen.findByRole("link", { name: "TASK-000001" });
    const [, row] = screen.getAllByRole("row");
    expect(row).toHaveTextContent("Claimed by claude-code");
    expect(row).toHaveTextContent("Waits on 1 task");
  });

  it("shows the creator on the mobile card too", async () => {
    stubApi({
      list: () => ({ body: page([makeTask(1, { createdBy: "agent:claude-code" })]) }),
    });
    setViewportWidth(360);
    renderPage();

    const card = await screen.findByRole("link", { name: /TASK-000001/ });
    expect(card).toHaveTextContent("Agent claude-code");
  });
});
