import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Outlet, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppHeader } from "@/components/layout/AppHeader";
import { TaskCreatePage } from "@/pages/task-create/TaskCreatePage";
import {
  makeQueryClient,
  makeStats,
  makeTask,
  renderRoute,
  mockApi as mockHandlers,
  type RouteHandler,
} from "@/test/harness";

/** Every render of the page asks for facets (the project suggestions). */
const mockApi = (handlers: Record<string, RouteHandler>) =>
  mockHandlers({
    "GET /tasks/facets": () => ({
      body: { assignees: [], projects: ["helpdesk", "mcp-server"], creators: [] },
    }),
    ...handlers,
  });

/** Renders the current URL, so a navigation assertion can name it exactly. */
const LocationProbe = () => {
  const { pathname, search } = useLocation();
  return <span data-testid="location">{`${pathname}${search}`}</span>;
};

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const routes = [
  { path: "/tasks/new", element: <TaskCreatePage /> },
  { path: "/tasks/:taskId", element: <div>Detail page</div> },
  { path: "/tasks", element: <div>Tasks list</div> },
];

const renderCreate = (queryClient = makeQueryClient()) =>
  renderRoute({ routes, initialEntries: ["/tasks/new"], queryClient });

const fillValid = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByLabelText(/^title/i), "Add rate limiting to exports");
  await user.type(
    screen.getByLabelText(/^description/i),
    "Exports time out under load; throttle per client.",
  );
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("TaskCreatePage", () => {
  it("POSTs the contract shape and lands on the new task", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      "POST /tasks": () => ({
        status: 201,
        body: makeTask({ id: 64, reference: "TASK-000064" }),
      }),
    });

    renderCreate();
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(screen.getByText("Detail page")).toBeInTheDocument());

    const post = requests.find((r) => r.method === "POST");
    expect(post?.body).toEqual({
      title: "Add rate limiting to exports",
      description: "Exports time out under load; throttle per client.",
      status: "backlog",
      priority: "medium",
      project: null,
      assignee: null,
      acceptanceCriteria: null,
      links: [],
      parentId: null,
      idempotencyKey: expect.stringMatching(/^web:.+/),
    });
    expect(toast.success).toHaveBeenCalledWith("Task TASK-000064 created");
  });

  it("invalidates the whole tasks tree so the list picks the new row up", async () => {
    const user = userEvent.setup();
    mockApi({ "POST /tasks": () => ({ status: 201, body: makeTask({ id: 64 }) }) });

    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    renderCreate(queryClient);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["tasks"] });
    });
  });

  it("keeps every typed value when the server rejects the payload", async () => {
    const user = userEvent.setup();
    mockApi({
      "POST /tasks": () => ({
        status: 422,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid",
            details: { project: ["Project must be a slug: letters, digits, . _ -"] },
            requestId: "r1",
          },
        },
      }),
    });

    renderCreate();
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Create task" }));

    expect(
      await screen.findByText("Project must be a slug: letters, digits, . _ -"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^title/i)).toHaveValue("Add rate limiting to exports");
    // A 422 is already on screen; a toast on top of it would be noise.
    expect(toast.error).not.toHaveBeenCalled();
  });

  /**
   * The documented promise is that focus moves to the invalid field. `setError`
   * cannot keep it: `shouldFocus` calls `.focus()` on a **registered input
   * ref**, and `priority` is a Radix Select driven by `setValue` with no ref at
   * all — so this shape of payload used to consume the flag on the select, focus
   * nothing, and leave the input after it past `isFirst`. Focus landed nowhere.
   *
   * Asserting the messages render cannot see this; only `document.activeElement`
   * can.
   */
  it("focuses the topmost invalid control after a 422, including a select", async () => {
    const user = userEvent.setup();
    mockApi({
      "POST /tasks": () => ({
        status: 422,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid",
            details: {
              // Server order is deliberately the reverse of form order.
              project: ["Project must be a slug: letters, digits, . _ -"],
              priority: ["Not a known priority"],
            },
            requestId: "r1",
          },
        },
      }),
    });

    renderCreate();
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Create task" }));

    expect(await screen.findByText("Not a known priority")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("combobox", { name: /^priority/i })).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });

  /**
   * A `details` key this form does not render — `_`, or a field added API-side —
   * goes to the summary, so there is no invalid control to focus. Focus must
   * still move somewhere the message is readable.
   */
  it("focuses the error summary when the rejection names no rendered field", async () => {
    const user = userEvent.setup();
    mockApi({
      "POST /tasks": () => ({
        status: 422,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid",
            details: { _: ['Unrecognized key: "id"'] },
            requestId: "r1",
          },
        },
      }),
    });

    renderCreate();
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Create task" }));

    const summary = await screen.findByText('Unrecognized key: "id"');
    await waitFor(() => {
      expect(document.activeElement).toHaveAttribute("aria-live", "assertive");
    });
    expect(document.activeElement?.contains(summary)).toBe(true);
  });

  it("toasts for a failure that has no field to land on", async () => {
    const user = userEvent.setup();
    mockApi({
      "POST /tasks": () => ({
        status: 500,
        body: { error: { code: "INTERNAL_ERROR", message: "boom", requestId: "r1" } },
      }),
    });

    renderCreate();
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Something went wrong on the server", {
        description: "This is not your fault. Try again in a moment.",
      });
    });
    expect(screen.getByLabelText(/^title/i)).toHaveValue("Add rate limiting to exports");
    // Nothing was marked invalid and the summary is empty, so the focus pass
    // must leave the user where they were rather than on an empty region.
    expect(screen.getByRole("button", { name: "Create task" })).toHaveFocus();
  });

  it("leaves immediately when Cancel is pressed on an untouched form", async () => {
    const user = userEvent.setup();
    mockApi({});

    renderCreate();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.getByText("Tasks list")).toBeInTheDocument());
  });

  /**
   * `backToListPath(location.state)` is only reachable if something attaches
   * that state, and the header — not the list page — is how most users get
   * here. With no `state` on those links the create page always cancelled to a
   * bare `/tasks`, dropping every filter, while the code that would have
   * restored them sat there looking correct.
   */
  it("cancels back to the filtered list it was opened from", async () => {
    const user = userEvent.setup();
    mockApi({ "GET /tasks/stats": () => ({ body: makeStats() }) });

    renderRoute({
      routes: [
        {
          element: (
            <div>
              <AppHeader />
              <LocationProbe />
              <Outlet />
            </div>
          ),
          children: [
            { path: "/tasks", element: <div>Tasks list</div> },
            { path: "/tasks/new", element: <TaskCreatePage /> },
          ],
        },
      ],
      initialEntries: ["/tasks?status=todo&page=2"],
    });

    // Two "New task" links exist by design (icon-only below `sm`, labelled
    // above); both must carry the state, so assert on both and use the first.
    const newTaskLinks = screen.getAllByRole("link", { name: "New task" });
    expect(newTaskLinks).toHaveLength(2);

    await user.click(newTaskLinks[0]!);
    await screen.findByRole("button", { name: "Create task" });

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.getByText("Tasks list")).toBeInTheDocument());
    expect(screen.getByTestId("location")).toHaveTextContent("/tasks?status=todo&page=2");
  });

  /**
   * The same rule as the success path, which the page's docstring already
   * argues for: an abandoned form is as spent as a submitted one. Pushing
   * `/tasks` over `/tasks/new` leaves the blank form one Back press away.
   */
  it("replaces the form's history entry on Cancel, so Back does not reopen it", async () => {
    const user = userEvent.setup();
    mockApi({});

    const { router } = renderRoute({
      routes,
      initialEntries: ["/tasks", "/tasks/new"],
    });

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByText("Tasks list")).toBeInTheDocument());

    await act(async () => {
      await router.navigate(-1);
    });

    expect(router.state.location.pathname).toBe("/tasks");
    expect(screen.queryByRole("button", { name: "Create task" })).not.toBeInTheDocument();
  });

  /*
    The contract's `superRefine`, run by the client's resolver: its message
    lands on the criteria field, and nothing is sent.
  */
  it("requires acceptance criteria to start a task in To do", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      "POST /tasks": () => ({ status: 201, body: makeTask({ id: 64 }) }),
    });

    renderCreate();
    await fillValid(user);
    await user.click(screen.getByRole("combobox", { name: /starting status/i }));
    await user.click(await screen.findByRole("option", { name: "To do" }));
    await user.click(screen.getByRole("button", { name: "Create task" }));

    expect(
      await screen.findByText("Acceptance criteria are required before a task can be todo"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^acceptance criteria/i)).toHaveAttribute("aria-invalid", "true");
    expect(requests.some((r) => r.method === "POST")).toBe(false);

    await user.type(screen.getByLabelText(/^acceptance criteria/i), "Returns 429 over the limit.");
    await user.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(requests.some((r) => r.method === "POST")).toBe(true));
    expect(requests.find((r) => r.method === "POST")?.body).toMatchObject({
      status: "todo",
      acceptanceCriteria: "Returns 429 over the limit.",
    });
  });

  it("only offers the three statuses a task may start in", async () => {
    const user = userEvent.setup();
    mockApi({});

    renderCreate();
    await user.click(screen.getByRole("combobox", { name: /starting status/i }));

    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Backlog",
      "Needs refinement",
      "To do",
    ]);
  });

  it("suggests the projects already in use", async () => {
    mockApi({});

    const { container } = renderCreate();

    await waitFor(() => {
      expect(
        [...container.querySelectorAll("datalist option")].map((o) => o.getAttribute("value")),
      ).toEqual(["helpdesk", "mcp-server"]);
    });
    const project = screen.getByLabelText(/^project/i);
    expect(
      container.querySelector(`datalist#${CSS.escape(project.getAttribute("list")!)}`),
    ).not.toBeNull();
  });

  /*
    The point of the key: a retry after a failure the server may already have
    acted on must be the *same* create, not a second one.
  */
  it("resends the same idempotency key when a failed create is retried", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const { requests } = mockApi({
      "POST /tasks": () => {
        attempt += 1;
        return attempt === 1
          ? {
              status: 500,
              body: { error: { code: "INTERNAL_ERROR", message: "boom", requestId: "r1" } },
            }
          : { status: 201, body: makeTask({ id: 64 }) };
      },
    });

    renderCreate();
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(screen.getByText("Detail page")).toBeInTheDocument());
    const keys = requests
      .filter((r) => r.method === "POST")
      .map((r) => (r.body as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("confirms before discarding a dirty form", async () => {
    const user = userEvent.setup();
    mockApi({});

    renderCreate();
    await user.type(screen.getByLabelText(/^title/i), "Half a thought");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("Discard this task?");
    expect(screen.queryByText("Tasks list")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByLabelText(/^title/i)).toHaveValue("Half a thought");
  });
});
