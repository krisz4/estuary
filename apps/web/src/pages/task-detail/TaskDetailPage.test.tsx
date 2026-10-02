import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type TaskEvent } from "@estuary/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/api/queryKeys";
import { TaskDetailPage } from "@/pages/task-detail/TaskDetailPage";
import {
  emptyEvents,
  makeComment,
  makeDecision,
  makeQueryClient,
  makeTask,
  mockApi as mockHandlers,
  renderRoute,
  type RouteHandler,
} from "@/test/harness";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));

/** Every detail render also asks for the task's activity. */
const mockApi = (handlers: Record<string, RouteHandler>) =>
  mockHandlers({ "GET /events": () => ({ body: emptyEvents() }), ...handlers });

const routes = [
  { path: "/tasks/:taskId", element: <TaskDetailPage /> },
  { path: "/tasks", element: <div>Tasks list</div> },
];

const renderDetail = (options: { queryClient?: ReturnType<typeof makeQueryClient> } = {}) =>
  renderRoute({ routes, initialEntries: ["/tasks/42"], ...options });

const heading = () => screen.findByRole("heading", { level: 1 });

const pickStatus = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
  await user.click(screen.getByRole("combobox", { name: /status/i }));
  await user.click(await screen.findByRole("option", { name: label }));
};

const apiError = (status: number, code: string, details?: unknown) => ({
  status,
  body: { error: { code, message: "raw", details, requestId: "r1" } },
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TaskDetailPage — states", () => {
  it("renders the task, its comments, its criteria, and who filed it", async () => {
    mockApi({
      "GET /tasks/42": () => ({
        body: makeTask({ comments: [makeComment({ body: "On it." })], commentCount: 1 }),
      }),
    });

    renderDetail();

    expect(await heading()).toHaveTextContent("Add rate limiting to the export endpoint");
    expect(screen.getByText("TASK-000042")).toBeInTheDocument();
    expect(screen.getByText("On it.")).toBeInTheDocument();
    expect(screen.getByText("Requests over 10/min get a 429.")).toBeInTheDocument();
    expect(screen.getByText("estuary")).toBeInTheDocument();
    // The creator's kind is words, not only a bot glyph.
    expect(screen.getByText("Created by").nextElementSibling).toHaveTextContent(
      "Agent claude-code",
    );
  });

  it.each([
    ["blocked", "Blocked because…"],
    ["needs_user_action", "What you need to do"],
    ["needs_qa", "QA summary"],
    ["deferred", "Deferred because…"],
  ] as const)("frames a %s status note as %s", async (status, framing) => {
    mockApi({
      "GET /tasks/42": () => ({
        body: makeTask({ status, statusNote: "Waiting on the CDN team." }),
      }),
    });

    renderDetail();

    const panel = await screen.findByRole("region", { name: framing });
    expect(panel).toHaveTextContent("Waiting on the CDN team.");
  });

  it("shows the resource not-found state for a 404, not a toast", async () => {
    mockApi({ "GET /tasks/42": () => apiError(404, "TASK_NOT_FOUND") });

    renderDetail();

    expect(await screen.findByText("This task doesn't exist")).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("shows a retryable error panel for a 500", async () => {
    mockApi({
      "GET /tasks/42": () => ({
        status: 500,
        body: { error: { code: "INTERNAL_ERROR", message: "boom", requestId: "r9" } },
      }),
    });

    renderDetail();

    expect(await screen.findByText("Something went wrong on the server")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByText("Request ID: r9")).toBeInTheDocument();
  });

  it("rejects a non-numeric id without issuing a request", async () => {
    const { requests } = mockApi({});
    renderRoute({ routes, initialEntries: ["/tasks/0x2a"] });

    expect(
      await screen.findByText("That address does not contain a valid task number."),
    ).toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });
});

describe("TaskDetailPage — concerns and needsTriage", () => {
  it("shows what the reviewer should not miss, near the status note", async () => {
    mockApi({
      "GET /tasks/42": () => ({
        body: makeTask({
          status: "needs_qa",
          statusNote: "Added the throttle.",
          concerns: "The retry logic is untested under load.",
        }),
      }),
    });
    renderDetail();

    await heading();
    expect(screen.getByText(/Don.t miss this/)).toBeInTheDocument();
    expect(
      screen.getByText("The retry logic is untested under load."),
    ).toBeInTheDocument();
  });

  it("offers Accept for an agent-filed task nobody has triaged, and clears needsTriage", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      "GET /tasks/42": () => ({ body: makeTask({ status: "todo", needsTriage: true }) }),
      "PATCH /tasks/42": () => ({ body: makeTask({ status: "todo", needsTriage: false }) }),
    });
    renderDetail();

    await heading();
    expect(screen.getByText(/Suggested by an agent/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() =>
      expect(
        requests.filter((r) => r.method === "PATCH" && r.url.pathname.endsWith("/tasks/42")),
      ).toHaveLength(1),
    );
    const patch = requests.find(
      (r) => r.method === "PATCH" && r.url.pathname.endsWith("/tasks/42"),
    );
    expect(patch?.body).toEqual({ needsTriage: false, expectedVersion: 3 });
  });
});

describe("TaskDetailPage — description escaping", () => {
  it("renders markup in the description as a text node", async () => {
    mockApi({
      "GET /tasks/42": () => ({
        body: makeTask({ description: "before <img src=x onerror=alert(1)> after" }),
      }),
    });

    const { container } = renderDetail();

    const paragraph = await screen.findByText(/before <img src=x onerror=alert\(1\)> after/);
    // The assertion that matters is structural: one text node, and no element
    // parsed out of the string anywhere in the tree.
    expect(paragraph.childNodes).toHaveLength(1);
    expect(paragraph.childNodes[0]?.nodeType).toBe(Node.TEXT_NODE);
    expect(container.querySelector("img")).toBeNull();
  });

  it("links only http(s) URLs, so a javascript: link is text", async () => {
    mockApi({
      "GET /tasks/42": () => ({
        body: makeTask({
          links: [
            { label: "PR", url: "https://github.com/x/y/pull/1" },
            { label: "Sneaky", url: "javascript:alert(1)" },
          ],
        }),
      }),
    });

    renderDetail();
    await heading();

    expect(screen.getByRole("link", { name: /^PR/ })).toHaveAttribute(
      "href",
      "https://github.com/x/y/pull/1",
    );
    expect(screen.queryByRole("link", { name: /Sneaky/ })).not.toBeInTheDocument();
    expect(screen.getByText("Sneaky: javascript:alert(1)")).toBeInTheDocument();
  });
});

describe("TaskDetailPage — status change", () => {
  it("posts a transition for a status that needs nothing, and invalidates the workflow keys", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      "GET /tasks/42": () => ({ body: makeTask() }),
      "POST /tasks/42/transition": () => ({ body: makeTask({ status: "in_progress" }) }),
    });

    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    renderDetail({ queryClient });
    await heading();

    await pickStatus(user, "In progress");

    await waitFor(() => {
      expect(requests.some((r) => r.method === "POST")).toBe(true);
    });
    // Never a PATCH: status is not an editable field any more.
    expect(requests.some((r) => r.method === "PATCH")).toBe(false);
    expect(requests.find((r) => r.method === "POST")?.body).toEqual({ to: "in_progress" });

    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.tasks.lists() });
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.tasks.details() });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.tasks.stats() });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.events.all });
    // A status change adds no project or assignee, so facets are left alone.
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: queryKeys.tasks.all });
    expect(toast.success).toHaveBeenCalledWith("TASK-000042 is now In progress");
  });

  it("opens the dialog for a status that needs a reason, and posts what was typed", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      "GET /tasks/42": () => ({ body: makeTask() }),
      "POST /tasks/42/transition": () => ({
        body: makeTask({ status: "blocked", statusNote: "Waiting on the CDN team." }),
      }),
    });

    renderDetail();
    await heading();

    await pickStatus(user, "Blocked");

    const dialog = await screen.findByRole("dialog", { name: "Move TASK-000042 to Blocked" });
    expect(requests.some((r) => r.method === "POST")).toBe(false);

    await user.type(
      within(dialog).getByLabelText(/why is it blocked/i),
      "Waiting on the CDN team.",
    );
    await user.type(within(dialog).getByLabelText(/waits on tasks/i), "TASK-000012, #13");
    await user.click(within(dialog).getByRole("button", { name: "Move to Blocked" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(requests.find((r) => r.method === "POST")?.body).toEqual({
      to: "blocked",
      reason: "Waiting on the CDN team.",
      blockedBy: [12, 13],
    });
  });

  it("sends nothing when the dialog is cancelled, and the status stays", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({ "GET /tasks/42": () => ({ body: makeTask() }) });

    renderDetail();
    await heading();

    await pickStatus(user, "Deferred");
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(requests.some((r) => r.method === "POST")).toBe(false);
    expect(screen.getByRole("combobox", { name: /status/i })).toHaveTextContent("To do");
  });

  /*
    The page thought the task had criteria, so it posted `todo` directly; an
    agent had cleared them. The server's 422 reopens the move as a dialog with
    its message on the field rather than only refusing.
  */
  it("reopens a direct move as the dialog when the server asks for more", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /tasks/42": () => ({ body: makeTask({ status: "backlog" }) }),
      "POST /tasks/42/transition": () =>
        apiError(422, "VALIDATION_ERROR", {
          acceptanceCriteria: ["Acceptance criteria are required before a task can be todo"],
        }),
    });

    renderDetail();
    await heading();

    await pickStatus(user, "To do");

    const dialog = await screen.findByRole("dialog", { name: "Move TASK-000042 to To do" });
    expect(
      within(dialog).getByText("Acceptance criteria are required before a task can be todo"),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/acceptance criteria/i)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("names the claim holder inline when a move is refused, and rolls the value back", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /tasks/42": () => ({ body: makeTask({ status: "in_progress" }) }),
      "POST /tasks/42/transition": () =>
        apiError(409, "TASK_ALREADY_CLAIMED", {
          claimedBy: "agent:codex",
          expiresAt: "2026-09-25T12:00:00.000Z",
        }),
    });

    renderDetail();
    await heading();

    await pickStatus(user, "Done");

    expect(await screen.findByText(/^agent:codex holds the claim\./)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: /status/i })).toHaveTextContent("In progress");
    });
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("TaskDetailPage — decisions", () => {
  it("answers the open decision with the option picked", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      "GET /tasks/42": () => ({
        body: makeTask({ status: "needs_user_decision", openDecision: makeDecision() }),
      }),
      "POST /decision/answer": () => ({ body: makeTask({ status: "todo" }) }),
    });

    renderDetail();
    await heading();

    expect(
      screen.getByRole("heading", { name: "Which limiter should we use?" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Both are a day of work.")).toBeInTheDocument();

    const recommended = screen.getByRole("button", { name: /Token bucket/ });
    expect(recommended).toHaveTextContent("Recommended");
    expect(screen.getByRole("button", { name: /Fixed window/ })).not.toHaveTextContent(
      "Recommended",
    );

    await user.click(recommended);

    await waitFor(() => expect(requests.some((r) => r.method === "POST")).toBe(true));
    expect(requests.find((r) => r.method === "POST")?.body).toEqual({ choice: "Token bucket" });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Answered — TASK-000042 is back in To do"),
    );
  });

  it("lists past decisions with what was chosen and by whom", async () => {
    mockApi({
      "GET /tasks/42": () => ({
        body: makeTask({
          decisions: [
            makeDecision({
              id: 8,
              status: "answered",
              choice: "Fixed window",
              note: "Simpler to explain.",
              answeredBy: "human:krisz",
              answeredAt: "2026-08-02T09:00:00.000Z",
            }),
            makeDecision({ id: 6, status: "withdrawn", question: "Postgres or SQLite?" }),
          ],
        }),
      }),
    });

    renderDetail();
    await heading();

    const past = screen.getByRole("region", { name: "Past decisions" });
    expect(within(past).getByText("Fixed window")).toBeInTheDocument();
    expect(within(past).getByText("Simpler to explain.")).toBeInTheDocument();
    expect(within(past).getByText(/Answered by/)).toHaveTextContent("Answered by Human krisz");
    expect(within(past).getByText(/Withdrawn/)).toBeInTheDocument();
  });
});

describe("TaskDetailPage — claims", () => {
  it("shows who holds the claim and releases it after a confirm", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      "GET /tasks/42": () => ({
        body: makeTask({
          status: "in_progress",
          claim: { actor: "agent:claude-code", expiresAt: "2099-01-01T00:00:00.000Z" },
        }),
      }),
      "POST /tasks/42/release": () => ({ body: makeTask({ status: "todo" }) }),
    });

    renderDetail();
    await heading();

    expect(screen.getByText("Being worked on").parentElement).toHaveTextContent(
      /Claimed by claude-code\s*· lease ends/,
    );

    await user.click(screen.getByRole("button", { name: "Release" }));
    const dialog = await screen.findByRole("dialog", { name: "Release TASK-000042?" });
    // Interrupting an agent's work is gated like a delete.
    expect(requests.some((r) => r.method === "POST")).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Release claim" }));

    await waitFor(() => expect(requests.some((r) => r.method === "POST")).toBe(true));
    expect(requests.find((r) => r.method === "POST")?.body).toEqual({});
  });

  it("offers to claim an in-progress task whose lease ran out", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      "GET /tasks/42": () => ({ body: makeTask({ status: "in_progress", claim: null }) }),
      "POST /tasks/42/claim": () => ({ body: makeTask({ status: "in_progress" }) }),
    });

    renderDetail();
    await heading();

    await user.click(screen.getByRole("button", { name: "Claim it" }));

    await waitFor(() => expect(requests.some((r) => r.url.pathname.endsWith("/claim"))).toBe(true));
  });
});

describe("TaskDetailPage — dependencies", () => {
  const withDependency = () =>
    makeTask({
      dependencies: [
        {
          id: 12,
          reference: "TASK-000012",
          title: "Pick a limiter",
          status: "in_progress",
          project: "estuary",
        },
      ],
      dependents: [
        {
          id: 50,
          reference: "TASK-000050",
          title: "Ship exports",
          status: "blocked",
          project: "estuary",
        },
      ],
    });

  it("lists what it waits on and what needs it, with statuses", async () => {
    mockApi({ "GET /tasks/42": () => ({ body: withDependency() }) });

    renderDetail();
    await heading();

    const waitsOn = screen.getByRole("region", { name: "Waits on" });
    expect(within(waitsOn).getByRole("link", { name: /TASK-000012/ })).toHaveAttribute(
      "href",
      "/tasks/12",
    );
    expect(within(waitsOn).getByText("In progress")).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Needed by" })).getByText("Blocked"),
    ).toBeInTheDocument();
  });

  it("adds a dependency by any spelling of its number", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      "GET /tasks/42": () => ({ body: makeTask() }),
      "POST /tasks/42/dependencies": () => ({ body: withDependency() }),
    });

    renderDetail();
    await heading();

    await user.type(screen.getByLabelText("Add a dependency"), "task-12");
    await user.click(screen.getByRole("button", { name: "Add dependency" }));

    await waitFor(() => expect(requests.some((r) => r.method === "POST")).toBe(true));
    expect(requests.find((r) => r.method === "POST")?.body).toEqual({ dependsOnId: 12 });
  });

  it("puts a dependency cycle on the field, with the loop spelled out", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /tasks/42": () => ({ body: makeTask() }),
      "POST /tasks/42/dependencies": () =>
        apiError(409, "DEPENDENCY_CYCLE", { path: [42, 12, 42] }),
    });

    renderDetail();
    await heading();

    await user.type(screen.getByLabelText("Add a dependency"), "12");
    await user.click(screen.getByRole("button", { name: "Add dependency" }));

    expect(await screen.findByText(/#42 → #12 → #42/)).toBeInTheDocument();
    expect(screen.getByLabelText("Add a dependency")).toHaveValue("12");
  });

  it("removes a dependency", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      "GET /tasks/42": () => ({ body: withDependency() }),
      "DELETE /dependencies/12": () => ({ body: makeTask() }),
    });

    renderDetail();
    await heading();

    await user.click(screen.getByRole("button", { name: "Remove dependency on TASK-000012" }));

    await waitFor(() => expect(requests.some((r) => r.method === "DELETE")).toBe(true));
    expect(requests.find((r) => r.method === "DELETE")?.url.pathname).toMatch(
      /\/tasks\/42\/dependencies\/12$/,
    );
  });
});

describe("TaskDetailPage — activity", () => {
  const event = (overrides: Partial<TaskEvent>): TaskEvent => ({
    id: 1,
    taskId: 42,
    taskTitle: "Some task",
    project: "estuary",
    type: "task.created",
    actor: "agent:claude-code",
    payload: {},
    createdAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  });

  it("asks for this task's events and renders them newest first, as sentences", async () => {
    const { requests } = mockApi({
      "GET /tasks/42": () => ({ body: makeTask() }),
      "GET /events": () => ({
        body: {
          data: [
            event({ id: 1, type: "task.created", payload: { status: "backlog", title: "x" } }),
            event({
              id: 2,
              type: "task.status_changed",
              payload: { from: "backlog", to: "blocked", note: "Waiting on the CDN team." },
            }),
            event({
              id: 3,
              type: "dependency.added",
              actor: "human:krisz",
              payload: { dependsOnId: 12 },
            }),
            // Not the documented shape — must still render a line, not crash.
            event({ id: 4, type: "task.updated", payload: { fields: "title" } }),
          ],
          meta: { nextAfter: 4, hasMore: false },
        },
      }),
    });

    renderDetail();
    await heading();

    const activity = screen.getByRole("region", { name: "Activity" });
    await waitFor(() => expect(within(activity).getAllByRole("listitem")).toHaveLength(4));

    const lines = within(activity)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(lines[0]).toContain("edited the task");
    expect(lines[1]).toContain("made it depend on TASK-000012");
    expect(lines[2]).toContain("moved it from Backlog to Blocked");
    expect(lines[2]).toContain("“Waiting on the CDN team.”");
    expect(lines[3]).toContain("created the task in Backlog");

    const eventsRequest = requests.find((r) => r.url.pathname.endsWith("/events"));
    expect(eventsRequest?.url.searchParams.get("taskId")).toBe("42");
  });

  it("has its own empty and error states, and the page still works", async () => {
    const user = userEvent.setup();
    let fail = true;
    mockHandlers({
      "GET /tasks/42": () => ({ body: makeTask() }),
      "GET /events": () =>
        fail
          ? {
              status: 503,
              body: { error: { code: "INTERNAL_ERROR", message: "x", requestId: "r" } },
            }
          : { body: emptyEvents() },
    });

    renderDetail();
    await heading();

    const activity = screen.getByRole("region", { name: "Activity" });
    const retry = await within(activity).findByRole("button", { name: "Retry" });

    fail = false;
    await user.click(retry);

    expect(await within(activity).findByText("No activity recorded yet.")).toBeInTheDocument();
  });
});

describe("TaskDetailPage — delete", () => {
  it("confirms first, then deletes, toasts, and leaves for the list", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      "GET /tasks/42": () => ({
        body: makeTask({ comments: [makeComment()], commentCount: 1 }),
      }),
      "DELETE /tasks/42": () => ({ status: 204 }),
    });

    renderDetail();
    await heading();

    await user.click(screen.getByRole("button", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleDescription(/This also deletes its 1 comment\./);
    // Nothing has been sent yet — the confirm is a real gate, not decoration.
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Delete task" }));

    await waitFor(() => expect(screen.getByText("Tasks list")).toBeInTheDocument());
    expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
    expect(toast.success).toHaveBeenCalledWith("TASK-000042 deleted");

    // No GET for the deleted task — or its timeline — AFTER the DELETE. This
    // page is still mounted when the mutation's own onSuccess runs, so an
    // eager invalidation would refetch the row that was just removed.
    const afterDelete = requests.slice(requests.findIndex((r) => r.method === "DELETE") + 1);
    expect(afterDelete.filter((r) => r.method === "GET")).toEqual([]);
  });

  it("sends nothing when the confirm is cancelled", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({ "GET /tasks/42": () => ({ body: makeTask() }) });

    renderDetail();
    await heading();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);
  });
});
