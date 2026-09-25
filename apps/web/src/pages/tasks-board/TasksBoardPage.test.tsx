import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  TASK_STATUSES,
  formatReference,
  type TaskStatus,
  type TaskSummary,
  type TransitionInput,
} from "@helpdesk/contracts";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskDetailPage } from "@/pages/task-detail/TaskDetailPage";
import { TasksBoardPage } from "@/pages/tasks-board/TasksBoardPage";
import { TasksListPage } from "@/pages/tasks-list/TasksListPage";
import { queryKeys } from "@/api/queryKeys";
import { setViewportWidth } from "../../../vitest.setup";
import {
  emptyEvents,
  makeDecision,
  makeStats,
  makeSummary,
  makeTask,
  mockApi,
  renderRoute,
  type MockRequest,
} from "@/test/harness";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

/**
 * Board tests.
 *
 * **The mock API holds state.** Every other screen in this suite can answer from
 * a fixed body, but a move is only interesting because of what happens *after*
 * it: the transition lands, `onSettled` invalidates, the columns refetch, and
 * the optimistic entry is dropped. Against a static mock the refetch would hand
 * back the pre-move world and the card would be seen to snap back — a failure
 * the assertion could not tell apart from a real rollback bug. So the store
 * below applies the transition, and "the card is in In progress" means the
 * server agrees rather than that the optimism has not expired yet.
 *
 * Dragging itself is not exercised here. `@dnd-kit` is driven by pointer
 * geometry — `MouseSensor` needs a 6px move, and collision detection needs
 * layout jsdom does not compute (every rect is 0×0) — so a "drag" in jsdom
 * asserts on the mock's arithmetic, not on the app. The **drop path is the same
 * `move()`** the status select calls, and that is what these tests drive; the
 * real drag is covered end-to-end in `e2e/board.spec.ts`, in a browser that has
 * a layout.
 */

const summary = (overrides: Partial<TaskSummary> = {}): TaskSummary =>
  makeSummary({ reference: formatReference(overrides.id ?? 42), ...overrides });

/** The column statuses the board fetches with the closed lane collapsed. */
const OPEN_LANE_STATUSES: TaskStatus[] = TASK_STATUSES.filter(
  (status) => status !== "done" && status !== "deferred",
);

/** Every task id the fixtures below move. */
const MOVABLE_IDS = [1, 2, 3, 4, 5];

/** The mutable world the handlers answer from. */
let store: TaskSummary[] = [];
/** The error every transition should fail with, when it should. */
let transitionFailure: { status: number; body: unknown } | undefined;

const boardApi = (): { requests: MockRequest[] } =>
  mockApi({
    "GET /tasks/facets": () => ({ body: { assignees: [], projects: [], creators: [] } }),
    "GET /tasks/stats": () => ({
      body: makeStats({
        byStatus: {
          ...makeStats().byStatus,
          done: store.filter((task) => task.status === "done").length,
          deferred: store.filter((task) => task.status === "deferred").length,
        },
      }),
    }),

    "GET /tasks": ({ url }) => {
      const status = url.searchParams.get("status");
      const pageSize = Number(url.searchParams.get("pageSize") ?? "20");
      // No `status` is the *list* page asking for everything. The board always
      // sends one — a column is a status — so this branch only serves the list
      // route these tests render alongside it.
      const matching = status === null ? store : store.filter((task) => task.status === status);
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

    /* For the round trip through the detail page. */
    "GET /tasks/1": () => ({
      body: makeTask({ id: 1, reference: "TASK-000001", title: "Write the limiter" }),
    }),
    "GET /events": () => ({ body: emptyEvents() }),

    /*
      `mockApi` matches a handler by *path suffix*, so one key per id — and the
      suffixes stay unambiguous, because `/tasks/15/transition` does not end
      with `/tasks/5/transition`.
    */
    ...Object.fromEntries(
      MOVABLE_IDS.map((id) => [
        `POST /tasks/${id}/transition`,
        ({ body }: MockRequest) => {
          if (transitionFailure !== undefined) return transitionFailure;

          const next = (body as TransitionInput).to;
          store = store.map((task) => (task.id === id ? { ...task, status: next } : task));

          return { body: makeTask({ id, status: next }) };
        },
      ]),
    ),
  });

const routes = [
  { path: "/tasks", element: <TasksListPage /> },
  { path: "/tasks/board", element: <TasksBoardPage /> },
];

const renderBoard = (initialEntry = "/tasks/board") =>
  renderRoute({ routes, initialEntries: [initialEntry] });

/**
 * The `<section>` for one column, found by the label that carries its count.
 * Lanes are regions too, but they are named by their heading ("Plan"), which
 * has no " — ".
 */
const column = (label: string) =>
  // `hidden`, because a column is still asserted on while the transition
  // dialog is open — and a modal Radix dialog hides the rest of the page from
  // the accessibility tree, which is correct and not what these assert about.
  screen.getByRole("region", { name: new RegExp(`^${label} —`), hidden: true });

const columnLabels = () =>
  screen
    .getAllByRole("region")
    .map((region) => region.getAttribute("aria-label"))
    .filter((label): label is string => label !== null);

const moveCardTo = async (
  user: ReturnType<typeof userEvent.setup>,
  reference: string,
  target: string,
) => {
  await user.click(
    screen.getByRole("combobox", { name: `Move task ${reference} to another status` }),
  );
  await user.click(await screen.findByRole("option", { name: target }));
};

const listRequests = (requests: MockRequest[]) =>
  requests.filter((request) => request.url.pathname.endsWith("/tasks"));

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom's default; the 360px case below changes it for the rest of the file.
  setViewportWidth(1024);
  transitionFailure = undefined;
  store = [
    summary({ id: 1, status: "todo", title: "Write the limiter" }),
    summary({ id: 2, status: "todo", title: "Add a 429 page", acceptanceCriteria: null }),
    summary({
      id: 3,
      status: "in_progress",
      title: "Swap the queue",
      claim: { actor: "agent:claude-code", expiresAt: "2099-01-01T00:00:00.000Z" },
    }),
    summary({
      id: 4,
      status: "needs_user_decision",
      title: "Pick a limiter",
      openDecision: makeDecision({ taskId: 4 }),
      openDependencyCount: 2,
    }),
    summary({ id: 5, status: "done", title: "Old export fix" }),
  ];
});

describe("TasksBoardPage — lanes and columns", () => {
  it("groups the columns into Plan, Doing, Waiting, and a collapsed Closed lane", async () => {
    const { requests } = boardApi();

    renderBoard();

    expect(await screen.findByText("Write the limiter")).toBeInTheDocument();

    for (const lane of ["Plan", "Doing", "Waiting", "Closed"]) {
      expect(screen.getByRole("heading", { level: 2, name: lane })).toBeInTheDocument();
    }

    // Lifecycle order within each lane, lane after lane; no closed columns yet.
    await waitFor(() =>
      expect(columnLabels()).toEqual([
        "Backlog — 0 tasks",
        "Needs refinement — 0 tasks",
        "To do — 2 tasks",
        "In progress — 1 task",
        "Needs QA — 0 tasks",
        "Blocked — 0 tasks",
        "Needs decision — 1 task",
        "Needs action — 0 tasks",
      ]),
    );

    // One request per visible column, each with its own status; none for the
    // collapsed lane.
    const sent = listRequests(requests).map((request) => request.url.searchParams.get("status"));
    expect([...new Set(sent)].sort()).toEqual([...OPEN_LANE_STATUSES].sort());
    for (const request of listRequests(requests)) {
      expect(request.url.searchParams.get("pageSize")).toBe("25");
      expect(request.url.searchParams.get("page")).toBe("1");
    }
  });

  it("opens the closed lane on request, fetching its columns only then", async () => {
    const user = userEvent.setup();
    const { requests } = boardApi();

    renderBoard();
    expect(await screen.findByText("Write the limiter")).toBeInTheDocument();

    const toggle = await screen.findByRole("button", { name: /show closed/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The collapsed lane says what it is hiding, from the stats.
    await waitFor(() => expect(toggle).toHaveTextContent("1 done, 0 deferred"));
    expect(screen.queryByText("Old export fix")).not.toBeInTheDocument();

    await user.click(toggle);

    expect(await within(column("Done")).findByText("Old export fix")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /hide closed/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(
      listRequests(requests).some((request) => request.url.searchParams.get("status") === "done"),
    ).toBe(true);
  });

  /**
   * The status filter is the one URL key the board reads differently from the
   * list: here it chooses columns rather than filtering rows. See the note in
   * `TasksBoardPage`.
   */
  it("shows only the filtered statuses as columns, in lifecycle order", async () => {
    boardApi();

    renderBoard("/tasks/board?status=needs_user_decision&status=todo");

    expect(await screen.findByText("Write the limiter")).toBeInTheDocument();
    expect(columnLabels()).toEqual(["To do — 2 tasks", "Needs decision — 1 task"]);
    // Lanes with nothing to show are not drawn at all.
    expect(screen.queryByRole("heading", { level: 2, name: "Doing" })).not.toBeInTheDocument();
  });

  it("opens the closed lane by itself when the filter names a closed status", async () => {
    boardApi();

    renderBoard("/tasks/board?status=done");

    expect(await within(column("Done")).findByText("Old export fix")).toBeInTheDocument();
    // A filter that picked a hidden column would look like it did nothing, so
    // there is no toggle to hide it again while the filter is on.
    expect(screen.queryByRole("button", { name: /closed/i })).not.toBeInTheDocument();
  });

  it("forwards the list's filters to every column request", async () => {
    const { requests } = boardApi();

    renderBoard("/tasks/board?priority=urgent&q=limiter&project=helpdesk&sort=priority%3Aasc");

    await waitFor(() => {
      expect(listRequests(requests)).toHaveLength(OPEN_LANE_STATUSES.length);
    });

    for (const request of listRequests(requests)) {
      expect(request.url.searchParams.get("priority")).toBe("urgent");
      expect(request.url.searchParams.get("q")).toBe("limiter");
      expect(request.url.searchParams.get("project")).toBe("helpdesk");
      expect(request.url.searchParams.get("sort")).toBe("priority:asc");
    }
  });

  it("raises the page size of one column only when it loads more", async () => {
    const user = userEvent.setup();
    store = Array.from({ length: 30 }, (_, index) =>
      summary({ id: index + 1, status: "todo", title: `Todo task ${index + 1}` }),
    );
    const { requests } = boardApi();

    renderBoard();

    expect(await screen.findByText("Todo task 1")).toBeInTheDocument();
    expect(within(column("To do")).queryByText("Todo task 26")).not.toBeInTheDocument();

    await user.click(within(column("To do")).getByRole("button", { name: "Load more" }));

    expect(await within(column("To do")).findByText("Todo task 26")).toBeInTheDocument();

    const pageSizes = listRequests(requests).map(
      (request) =>
        `${request.url.searchParams.get("status")}:${request.url.searchParams.get("pageSize")}`,
    );

    expect(pageSizes).toContain("todo:50");
    expect(pageSizes.filter((entry) => entry.endsWith(":50"))).toHaveLength(1);
  });

  it("marks a claimed card with the agent, and flags an open question and open dependencies", async () => {
    boardApi();

    renderBoard();

    const claimed = (await screen.findByText("Swap the queue")).closest("li")!;
    expect(claimed).toHaveTextContent("Claimed by claude-code");

    const waiting = screen.getByText("Pick a limiter").closest("li")!;
    expect(waiting).toHaveTextContent("Question open");
    expect(waiting).toHaveTextContent("Waits on 2 tasks");
    expect(waiting).toHaveTextContent("helpdesk");

    // Only what is true is drawn.
    const plain = screen.getByText("Write the limiter").closest("li")!;
    expect(plain).not.toHaveTextContent("Claimed by");
    expect(plain).not.toHaveTextContent("Question open");
  });
});

describe("TasksBoardPage — moving a task", () => {
  it("posts a transition and lands the card in the new column", async () => {
    const user = userEvent.setup();
    const { requests } = boardApi();

    renderBoard();

    expect(await screen.findByText("Write the limiter")).toBeInTheDocument();

    await moveCardTo(user, "TASK-000001", "In progress");

    await waitFor(() => {
      expect(within(column("In progress")).getByText("Write the limiter")).toBeInTheDocument();
    });
    expect(within(column("To do")).queryByText("Write the limiter")).not.toBeInTheDocument();

    const post = requests.find((request) => request.method === "POST");
    expect(post?.url.pathname).toMatch(/\/tasks\/1\/transition$/);
    expect(post?.body).toEqual({ to: "in_progress" });
    // Status is not a PATCHable field any more.
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);

    expect(toast.success).toHaveBeenCalledWith("TASK-000001 moved to In progress");
  });

  it("moves the counts with the card, not only the card", async () => {
    const user = userEvent.setup();
    boardApi();

    renderBoard();

    expect(await screen.findByText("Write the limiter")).toBeInTheDocument();
    expect(column("To do")).toHaveAccessibleName("To do — 2 tasks");

    await moveCardTo(user, "TASK-000001", "Backlog");

    await waitFor(() => {
      expect(column("To do")).toHaveAccessibleName("To do — 1 task");
    });
    expect(column("Backlog")).toHaveAccessibleName("Backlog — 1 task");
  });

  it("asks for a reason before a move that needs one, holding the card in its new column", async () => {
    const user = userEvent.setup();
    const { requests } = boardApi();

    renderBoard();
    expect(await screen.findByText("Write the limiter")).toBeInTheDocument();

    await moveCardTo(user, "TASK-000001", "Blocked");

    const dialog = await screen.findByRole("dialog", { name: "Move TASK-000001 to Blocked" });
    // Optimistic: the card is already where it was dropped, and nothing is sent.
    expect(within(column("Blocked")).getByText("Write the limiter")).toBeInTheDocument();
    expect(requests.some((request) => request.method === "POST")).toBe(false);

    await user.type(
      within(dialog).getByLabelText(/why is it blocked/i),
      "Needs the Redis upgrade.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Move to Blocked" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(requests.find((request) => request.method === "POST")?.body).toEqual({
      to: "blocked",
      reason: "Needs the Redis upgrade.",
    });
    expect(within(column("Blocked")).getByText("Write the limiter")).toBeInTheDocument();
  });

  it("puts the card back when the dialog is cancelled", async () => {
    const user = userEvent.setup();
    const { requests } = boardApi();

    renderBoard();
    expect(await screen.findByText("Write the limiter")).toBeInTheDocument();

    await moveCardTo(user, "TASK-000001", "Needs QA");
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(within(column("To do")).getByText("Write the limiter")).toBeInTheDocument();
    });
    expect(within(column("Needs QA")).queryByText("Write the limiter")).not.toBeInTheDocument();
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("asks for acceptance criteria only when a task moving to To do has none", async () => {
    const user = userEvent.setup();
    boardApi();

    renderBoard();
    expect(await screen.findByText("Add a 429 page")).toBeInTheDocument();

    // Task 2 has no criteria: To do needs the dialog. (Task 1 has some, which
    // is why the tests above move it without one.)
    await moveCardTo(user, "TASK-000002", "Backlog");
    await waitFor(() =>
      expect(within(column("Backlog")).getByText("Add a 429 page")).toBeInTheDocument(),
    );
    await moveCardTo(user, "TASK-000002", "To do");

    expect(
      await screen.findByRole("dialog", { name: "Move TASK-000002 to To do" }),
    ).toBeInTheDocument();
  });

  it("puts the card back and names the claim holder when the server refuses", async () => {
    const user = userEvent.setup();
    transitionFailure = {
      status: 409,
      body: {
        error: {
          code: "TASK_ALREADY_CLAIMED",
          message: "claimed",
          details: { claimedBy: "agent:codex", expiresAt: "2026-09-25T12:00:00.000Z" },
          requestId: "req-1",
        },
      },
    };
    boardApi();

    renderBoard();

    expect(await screen.findByText("Swap the queue")).toBeInTheDocument();

    await moveCardTo(user, "TASK-000003", "Backlog");

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Another agent is working on this", {
        description: expect.stringMatching(/^agent:codex holds the claim\./),
      });
    });

    expect(within(column("In progress")).getByText("Swap the queue")).toBeInTheDocument();
    expect(within(column("Backlog")).queryByText("Swap the queue")).not.toBeInTheDocument();
  });

  /**
   * A card is a link, so "click into the task while the move is in flight" is
   * one gesture away. Without the optimistic detail write the task page would
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
      "GET /tasks/facets": () => ({ body: { assignees: [], projects: [], creators: [] } }),
      "GET /tasks/stats": () => ({ body: makeStats() }),
      "GET /tasks": ({ url }) => {
        const status = url.searchParams.get("status");
        const data = store.filter((task) => task.status === status);
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
      "POST /tasks/1/transition": async () => {
        await inFlight;
        return {
          status: 409,
          body: {
            error: {
              code: "TASK_ALREADY_CLAIMED",
              message: "no",
              details: { claimedBy: "agent:codex", expiresAt: "2026-09-25T12:00:00.000Z" },
              requestId: "req-2",
            },
          },
        };
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

    // The task has been visited, so its detail row is in the cache — which is
    // the only case an optimistic write or a rollback can apply to.
    queryClient.setQueryData(queryKeys.tasks.detail(1), makeTask({ id: 1, status: "todo" }));

    renderRoute({ routes, initialEntries: ["/tasks/board"], queryClient });

    expect(await screen.findByText("Write the limiter")).toBeInTheDocument();

    await moveCardTo(user, "TASK-000001", "Done");

    await waitFor(() => {
      expect(queryClient.getQueryData<{ status: string }>(queryKeys.tasks.detail(1))?.status).toBe(
        "done",
      );
    });

    release();

    // …and the rejection puts the cached row back, rather than leaving the
    // detail page insisting on a status the server refused.
    await waitFor(() => {
      expect(queryClient.getQueryData<{ status: string }>(queryKeys.tasks.detail(1))?.status).toBe(
        "todo",
      );
    });
  });

  /**
   * A status change cannot add or remove a project, assignee or creator, and
   * the board keeps a facets observer mounted — so `tasks.all` would fire a
   * request per drag that can never return anything new. Stats, though, move.
   */
  it("refetches the lists and the stats, but not the facets", async () => {
    const user = userEvent.setup();
    const { requests } = boardApi();

    renderBoard();

    expect(await screen.findByText("Write the limiter")).toBeInTheDocument();

    const listsBefore = listRequests(requests).length;
    const statsBefore = requests.filter((r) => r.url.pathname.endsWith("/stats")).length;

    await moveCardTo(user, "TASK-000001", "In progress");

    await waitFor(() => {
      expect(within(column("In progress")).getByText("Write the limiter")).toBeInTheDocument();
    });

    expect(listRequests(requests).length).toBeGreaterThan(listsBefore);
    expect(requests.filter((r) => r.url.pathname.endsWith("/stats")).length).toBeGreaterThan(
      statsBefore,
    );
    expect(requests.filter((r) => r.url.pathname.endsWith("/facets"))).toHaveLength(1);
  });

  it("does not post when the card is set to the status it already has", async () => {
    const user = userEvent.setup();
    const { requests } = boardApi();

    renderBoard();

    expect(await screen.findByText("Write the limiter")).toBeInTheDocument();

    await moveCardTo(user, "TASK-000001", "To do");

    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });
});

describe("TasksBoardPage — at 360px", () => {
  /*
    jsdom has no layout, so "fits at 360px" is proven in `e2e/board.spec.ts`.
    What this can prove is the structure the mobile layout depends on: every
    lane is its own scroll container, so a phone scrolls one lane sideways
    rather than the whole page.
  */
  it("gives each lane its own horizontal scroller", async () => {
    setViewportWidth(360);
    boardApi();

    renderBoard();
    expect(await screen.findByText("Write the limiter")).toBeInTheDocument();

    const plan = screen.getByRole("region", { name: "Plan" });
    const scroller = column("To do").parentElement!;
    expect(plan).toContainElement(scroller);
    expect(scroller.className).toMatch(/overflow-x-auto/);
    expect(scroller.className).toMatch(/min-w-0/);
    // Below `md` the sort lives in the filter bar, so it is not rendered twice.
    expect(screen.getAllByRole("combobox", { name: "Sort tasks" })).toHaveLength(1);
  });
});

describe("ViewSwitch", () => {
  it("carries the filters from the list to the board and back", async () => {
    const user = userEvent.setup();
    boardApi();

    const { router } = renderRoute({
      routes,
      initialEntries: ["/tasks?priority=urgent&q=vpn"],
    });

    await user.click(await screen.findByRole("link", { name: "Board" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tasks/board");
    });
    expect(router.state.location.search).toBe("?priority=urgent&q=vpn");

    await user.click(screen.getByRole("link", { name: "List" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tasks");
    });
    expect(router.state.location.search).toBe("?priority=urgent&q=vpn");
  });
});

/**
 * The regression this suite exists for: the board is a *second* list route, and
 * every screen reached from it has to know which of the two to go back to.
 * `location.state.from` carries only the search string, so before the view
 * store the back link took a board user to `/tasks` — same filters, wrong
 * screen.
 */
describe("the remembered view", () => {
  const routesWithDetail = [...routes, { path: "/tasks/:taskId", element: <TaskDetailPage /> }];

  it("returns to the board — with its filters — from a task opened on it", async () => {
    const user = userEvent.setup();
    boardApi();

    const { router } = renderRoute({
      routes: routesWithDetail,
      initialEntries: ["/tasks/board?priority=urgent"],
    });

    await user.click(await screen.findByRole("link", { name: "TASK-000001" }));

    const back = await screen.findByRole("link", { name: /back to tasks/i });
    expect(back).toHaveAttribute("href", "/tasks/board?priority=urgent");

    await user.click(back);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tasks/board");
    });
    expect(router.state.location.search).toBe("?priority=urgent");
  });

  it("returns to the list from a task opened on the list", async () => {
    const user = userEvent.setup();
    boardApi();

    renderRoute({
      routes: routesWithDetail,
      initialEntries: ["/tasks?priority=urgent"],
    });

    await user.click(await screen.findByRole("link", { name: "TASK-000001" }));

    expect(await screen.findByRole("link", { name: /back to tasks/i })).toHaveAttribute(
      "href",
      "/tasks?priority=urgent",
    );
  });

  /*
    Switching view is what changes the answer — not the task, and not the
    history entry the detail page happens to sit on.
  */
  it("follows the view the user switched to before opening the task", async () => {
    const user = userEvent.setup();
    boardApi();

    renderRoute({ routes: routesWithDetail, initialEntries: ["/tasks"] });

    await user.click(await screen.findByRole("link", { name: "Board" }));
    await user.click(await screen.findByRole("link", { name: "TASK-000001" }));

    expect(await screen.findByRole("link", { name: /back to tasks/i })).toHaveAttribute(
      "href",
      "/tasks/board",
    );
  });
});
