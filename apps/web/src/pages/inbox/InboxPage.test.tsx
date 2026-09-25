import { formatReference, type TaskSummary } from "@helpdesk/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HAND_BACK_NOTE } from "@/pages/inbox/InboxItem";
import { InboxPage } from "@/pages/inbox/InboxPage";
import {
  makeDecision,
  makePage,
  makeSummary,
  makeTask,
  mockApi,
  renderRoute,
  type MockRequest,
  type RouteHandler,
} from "@/test/harness";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

/**
 * The inbox is the human half of the agent workflow, so these tests drive
 * every hand-back through the real request path: the right transition, the
 * right payload, and — for a QA send-back — the comment that goes with it.
 */

const task = (id: number, overrides: Partial<TaskSummary>): TaskSummary =>
  makeSummary({ id, reference: formatReference(id), title: `Task ${id}`, ...overrides });

const decisionTask = task(7, {
  status: "needs_user_decision",
  title: "Pick a rate limiter",
  openDecision: makeDecision({ taskId: 7 }),
});

const actionTask = task(8, {
  status: "needs_user_action",
  title: "Rotate the staging API key",
  statusNote: "Rotate the key in 1Password and paste it into .env.staging.",
});

const qaTask = task(9, {
  status: "needs_qa",
  title: "Rate-limit exports",
  statusNote: "Added a token bucket; run the load test to verify.",
  links: [{ label: "PR #12", url: "https://github.com/x/y/pull/12" }],
});

const renderInbox = (handlers: Record<string, RouteHandler>) => {
  const api = mockApi(handlers);
  renderRoute({
    routes: [
      { path: "/inbox", element: <InboxPage /> },
      { path: "/tasks/board", element: <div>Board</div> },
    ],
    initialEntries: ["/inbox"],
  });
  return api;
};

const inboxList =
  (tasks: TaskSummary[]): RouteHandler =>
  () => ({ body: makePage(tasks, 100) });

const posted = (requests: MockRequest[], suffix: string) =>
  requests.filter((request) => request.method === "POST" && request.url.pathname.endsWith(suffix));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("InboxPage — states", () => {
  it("shows a skeleton while loading, then the groups", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderInbox({
      "GET /tasks": async () => {
        await gate;
        return { body: makePage([actionTask], 100) };
      },
    });

    expect(screen.getByLabelText("Loading inbox")).toHaveAttribute("aria-busy", "true");

    release();
    expect(await screen.findByRole("heading", { name: /Actions/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("Loading inbox")).not.toBeInTheDocument();
  });

  it("asks for exactly the three human-attention statuses, most urgent first", async () => {
    const { requests } = renderInbox({ "GET /tasks": inboxList([actionTask]) });

    await screen.findByRole("heading", { name: /Actions/ });

    const request = requests.find((r) => r.url.pathname.endsWith("/tasks"));
    expect(request?.url.searchParams.getAll("status")).toEqual([
      "needs_user_decision",
      "needs_user_action",
      "needs_qa",
    ]);
    expect(request?.url.searchParams.get("sort")).toBe("priority:desc");
    expect(request?.url.searchParams.get("pageSize")).toBe("100");
  });

  it("says nothing needs you when the queue is empty", async () => {
    renderInbox({ "GET /tasks": inboxList([]) });

    expect(await screen.findByText("Nothing needs you")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go to the board/i })).toHaveAttribute(
      "href",
      "/tasks/board",
    );
  });

  it("shows an error panel whose Retry refetches", async () => {
    const user = userEvent.setup();
    let fail = true;
    renderInbox({
      "GET /tasks": () =>
        fail
          ? {
              status: 500,
              body: { error: { code: "INTERNAL_ERROR", message: "x", requestId: "r" } },
            }
          : { body: makePage([actionTask], 100) },
    });

    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText("Something went wrong on the server")).toBeInTheDocument();

    fail = false;
    await user.click(retry);

    expect(await screen.findByText("Rotate the staging API key")).toBeInTheDocument();
  });

  it("groups by status in lifecycle order, with counts", async () => {
    renderInbox({ "GET /tasks": inboxList([qaTask, actionTask, decisionTask]) });

    await screen.findByText("Pick a rate limiter");

    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual(["Decisions (1)", "Actions (1)", "Ready for QA (1)"]);
  });
});

describe("InboxPage — decisions", () => {
  it("renders the question and options, with the recommendation marked", async () => {
    renderInbox({ "GET /tasks": inboxList([decisionTask]) });

    expect(await screen.findByText("Which limiter should we use?")).toBeInTheDocument();
    expect(screen.getByText("Both are a day of work.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Token bucket/ })).toHaveTextContent("Recommended");
  });

  it("answers with an option, plus the note when one was typed", async () => {
    const user = userEvent.setup();
    const { requests } = renderInbox({
      "GET /tasks": inboxList([decisionTask]),
      "POST /tasks/7/decision/answer": () => ({ body: makeTask({ id: 7, status: "todo" }) }),
    });

    await screen.findByText("Which limiter should we use?");
    await user.type(
      screen.getByLabelText(/add a note/i),
      "Keep the old endpoint unlimited for a release.",
    );
    await user.click(screen.getByRole("button", { name: /Fixed window/ }));

    await waitFor(() => expect(posted(requests, "/decision/answer")).toHaveLength(1));
    expect(posted(requests, "/decision/answer")[0]?.body).toEqual({
      choice: "Fixed window",
      note: "Keep the old endpoint unlimited for a release.",
    });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Answered — TASK-000007 is back in To do"),
    );
  });

  it("answers in free text alone when no option fits", async () => {
    const user = userEvent.setup();
    const { requests } = renderInbox({
      "GET /tasks": inboxList([decisionTask]),
      "POST /tasks/7/decision/answer": () => ({ body: makeTask({ id: 7, status: "todo" }) }),
    });

    await screen.findByText("Which limiter should we use?");
    const noteOnly = screen.getByRole("button", { name: "Answer with this note only" });
    expect(noteOnly).toBeDisabled();

    await user.type(screen.getByLabelText(/add a note/i), "Neither — use the gateway's limiter.");
    await user.click(noteOnly);

    await waitFor(() => expect(posted(requests, "/decision/answer")).toHaveLength(1));
    expect(posted(requests, "/decision/answer")[0]?.body).toEqual({
      note: "Neither — use the gateway's limiter.",
    });
  });

  it("keeps the note and says why when the decision was already answered", async () => {
    const user = userEvent.setup();
    renderInbox({
      "GET /tasks": inboxList([decisionTask]),
      "POST /tasks/7/decision/answer": () => ({
        status: 409,
        body: { error: { code: "NO_OPEN_DECISION", message: "raw", requestId: "r" } },
      }),
    });

    await screen.findByText("Which limiter should we use?");
    await user.type(screen.getByLabelText(/add a note/i), "Token bucket, please.");
    await user.click(screen.getByRole("button", { name: /Token bucket/ }));

    expect(await screen.findByText(/This question was already answered/)).toBeInTheDocument();
    expect(screen.getByLabelText(/add a note/i)).toHaveValue("Token bucket, please.");
  });
});

describe("InboxPage — manual actions", () => {
  it("shows the instructions", async () => {
    renderInbox({ "GET /tasks": inboxList([actionTask]) });

    const panel = await screen.findByRole("region", { name: "What you need to do" });
    expect(panel).toHaveTextContent("Rotate the key in 1Password");
  });

  it("hands the task back to To do with a note for the next agent", async () => {
    const user = userEvent.setup();
    const { requests } = renderInbox({
      "GET /tasks": inboxList([actionTask]),
      "POST /tasks/8/transition": () => ({ body: makeTask({ id: 8, status: "todo" }) }),
    });

    await user.click(await screen.findByRole("button", { name: "Done — hand back" }));

    await waitFor(() => expect(posted(requests, "/transition")).toHaveLength(1));
    expect(posted(requests, "/transition")[0]?.body).toEqual({
      to: "todo",
      reason: HAND_BACK_NOTE,
    });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("TASK-000008 handed back — it's in To do"),
    );
  });

  it("can mark the task done instead", async () => {
    const user = userEvent.setup();
    const { requests } = renderInbox({
      "GET /tasks": inboxList([actionTask]),
      "POST /tasks/8/transition": () => ({ body: makeTask({ id: 8, status: "done" }) }),
    });

    await user.click(await screen.findByRole("button", { name: "Mark done" }));

    await waitFor(() => expect(posted(requests, "/transition")).toHaveLength(1));
    expect(posted(requests, "/transition")[0]?.body).toEqual({ to: "done" });
  });

  it("asks for acceptance criteria before handing back a task that has none", async () => {
    const user = userEvent.setup();
    const { requests } = renderInbox({
      "GET /tasks": inboxList([{ ...actionTask, acceptanceCriteria: null }]),
    });

    await user.click(await screen.findByRole("button", { name: "Done — hand back" }));

    expect(
      await screen.findByRole("dialog", { name: "Move TASK-000008 to To do" }),
    ).toBeInTheDocument();
    expect(posted(requests, "/transition")).toHaveLength(0);
  });
});

describe("InboxPage — QA", () => {
  it("shows the summary and the links to check", async () => {
    renderInbox({ "GET /tasks": inboxList([qaTask]) });

    const panel = await screen.findByRole("region", { name: "QA summary" });
    expect(panel).toHaveTextContent("run the load test");
    expect(screen.getByRole("link", { name: /PR #12/ })).toHaveAttribute(
      "href",
      "https://github.com/x/y/pull/12",
    );
  });

  it("approves to Done", async () => {
    const user = userEvent.setup();
    const { requests } = renderInbox({
      "GET /tasks": inboxList([qaTask]),
      "POST /tasks/9/transition": () => ({ body: makeTask({ id: 9, status: "done" }) }),
    });

    await user.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() => expect(posted(requests, "/transition")).toHaveLength(1));
    expect(posted(requests, "/transition")[0]?.body).toEqual({ to: "done" });
  });

  it("sends back to To do with the reason, and leaves a qa_feedback comment", async () => {
    const user = userEvent.setup();
    const { requests } = renderInbox({
      "GET /tasks": inboxList([qaTask]),
      "POST /tasks/9/transition": () => ({ body: makeTask({ id: 9, status: "todo" }) }),
      "POST /tasks/9/comments": () => ({ status: 201, body: {} }),
    });

    await user.click(await screen.findByRole("button", { name: "Send back" }));
    const dialog = await screen.findByRole("dialog", { name: "Send TASK-000009 back" });

    // The reason is required — an unexplained send-back is useless to an agent.
    await user.click(within(dialog).getByRole("button", { name: "Send back" }));
    expect(await within(dialog).findByText("Say what needs fixing")).toBeInTheDocument();
    expect(posted(requests, "/transition")).toHaveLength(0);

    await user.type(
      within(dialog).getByLabelText(/what needs fixing/i),
      "The 429 has no Retry-After header.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Send back" }));

    await waitFor(() => expect(posted(requests, "/comments")).toHaveLength(1));
    expect(posted(requests, "/transition")[0]?.body).toEqual({
      to: "todo",
      reason: "The 429 has no Retry-After header.",
    });
    expect(posted(requests, "/comments")[0]?.body).toEqual({
      body: "The 429 has no Retry-After header.",
      kind: "qa_feedback",
    });

    // Transition first, then the comment — the note is on the task even if the
    // comment were to fail.
    const order = requests
      .filter((r) => r.method === "POST")
      .map((r) => r.url.pathname.split("/").at(-1));
    expect(order).toEqual(["transition", "comments"]);

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("TASK-000009 sent back to To do"),
    );
  });

  it("keeps the dialog and the reason when the send-back is refused", async () => {
    const user = userEvent.setup();
    const { requests } = renderInbox({
      "GET /tasks": inboxList([qaTask]),
      "POST /tasks/9/transition": () => ({
        status: 409,
        body: {
          error: {
            code: "TASK_ALREADY_CLAIMED",
            message: "raw",
            details: { claimedBy: "agent:codex", expiresAt: "2026-09-25T12:00:00.000Z" },
            requestId: "r",
          },
        },
      }),
    });

    await user.click(await screen.findByRole("button", { name: "Send back" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/what needs fixing/i), "Missing header.");
    await user.click(within(dialog).getByRole("button", { name: "Send back" }));

    expect(await within(dialog).findByText(/agent:codex holds the claim/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/what needs fixing/i)).toHaveValue("Missing header.");
    expect(posted(requests, "/comments")).toHaveLength(0);
  });
});
