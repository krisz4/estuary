import { formatReference, type TaskSummary } from "@estuary/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DISMISS_REASON, HAND_BACK_NOTE, PARK_REASON } from "@/pages/inbox/InboxItem";
import { useProjectScopeStore } from "@/stores/projectScope";
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

const renderInbox = (handlers: Record<string, RouteHandler>, initialEntry = "/inbox") => {
  const api = mockApi(handlers);
  const { router } = renderRoute({
    routes: [
      { path: "/inbox", element: <InboxPage /> },
      { path: "/tasks/map", element: <div>Map</div> },
    ],
    initialEntries: [initialEntry],
  });
  return { ...api, router };
};

const inboxList =
  (tasks: TaskSummary[]): RouteHandler =>
  () => ({ body: makePage(tasks, 100) });

const posted = (requests: MockRequest[], suffix: string) =>
  requests.filter((request) => request.method === "POST" && request.url.pathname.endsWith(suffix));

const patched = (requests: MockRequest[], suffix: string) =>
  requests.filter(
    (request) => request.method === "PATCH" && request.url.pathname.endsWith(suffix),
  );

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
    expect(await screen.findByRole("heading", { name: /Act/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("Loading inbox")).not.toBeInTheDocument();
  });

  it("asks for the attention queue, most urgent first", async () => {
    const { requests } = renderInbox({ "GET /tasks": inboxList([actionTask]) });

    await screen.findByRole("heading", { name: /Act/ });

    const request = requests.find((r) => r.url.pathname.endsWith("/tasks"));
    expect(request?.url.searchParams.get("attention")).toBe("true");
    expect(request?.url.searchParams.get("sort")).toBe("priority:desc");
    expect(request?.url.searchParams.get("pageSize")).toBe("100");
  });

  it("says nothing needs you when the queue is empty", async () => {
    renderInbox({ "GET /tasks": inboxList([]) });

    expect(await screen.findByText("Nothing needs you")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go to the map/i })).toHaveAttribute(
      "href",
      "/tasks/map",
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

  it("groups by attention kind in ATTENTION_KINDS order, with counts", async () => {
    renderInbox({ "GET /tasks": inboxList([qaTask, actionTask, decisionTask]) });

    await screen.findByText("Pick a rate limiter");

    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual(["Decide (1)", "Act (1)", "Review (1)"]);
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

describe("InboxPage — projects", () => {
  it("narrows the request to the project in the URL and remembers it as the scope", async () => {
    const { requests } = renderInbox(
      { "GET /tasks": inboxList([task(3, { status: "needs_qa", project: "web-app" })]) },
      "/inbox?project=web-app",
    );

    expect(await screen.findByText("Task 3")).toBeInTheDocument();
    expect(requests[0]!.url.searchParams.getAll("project")).toEqual(["web-app"]);
    expect(screen.getByText(/Showing web-app only\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Show all projects" })).toHaveAttribute(
      "href",
      "/inbox",
    );
    await waitFor(() => expect(useProjectScopeStore.getState().project).toBe("web-app"));
  });

  it("says which project has nothing waiting, and offers every project", async () => {
    renderInbox({ "GET /tasks": inboxList([]) }, "/inbox?project=web-app");

    expect(await screen.findByText("Nothing in web-app needs you")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Show all projects" })).toHaveAttribute(
      "href",
      "/inbox",
    );
  });

  it("breaks the unscoped inbox down by project, each linking to its own inbox", async () => {
    const { requests } = renderInbox({
      "GET /tasks": inboxList([
        task(1, { status: "needs_qa", project: "web-app" }),
        task(2, { status: "needs_qa", project: "estuary" }),
        task(3, { status: "needs_user_action", project: "estuary" }),
        task(4, { status: "needs_qa", project: null }),
      ]),
    });

    expect(await screen.findByText("Task 1")).toBeInTheDocument();
    expect(requests[0]!.url.searchParams.has("project")).toBe(false);
    const breakdown = screen.getByText(/^From/);
    expect(breakdown).toHaveTextContent("From estuary (2), web-app (1)");
    expect(within(breakdown).getByRole("link", { name: "estuary" })).toHaveAttribute(
      "href",
      "/inbox?project=estuary",
    );
  });

  it("shows no breakdown when every item is from one project", async () => {
    renderInbox({
      "GET /tasks": inboxList([
        task(1, { status: "needs_qa", project: "estuary" }),
        task(2, { status: "needs_qa", project: "estuary" }),
      ]),
    });

    expect(await screen.findByText("Task 1")).toBeInTheDocument();
    expect(screen.queryByText(/^From/)).not.toBeInTheDocument();
  });
});

describe("InboxPage — review: routine vs concerns", () => {
  const routineQaTask = task(20, {
    status: "needs_qa",
    title: "Routine hand-off",
    statusNote: "Added the throttle; ran the suite locally.",
    concerns: null,
  });

  const flaggedQaTask = task(21, {
    status: "needs_qa",
    title: "Flagged hand-off",
    statusNote: "Added the throttle.",
    concerns: "The retry logic is untested under load — look closely.",
  });

  it("collapses a routine hand-off's summary behind a disclosure, Approve still one click", async () => {
    renderInbox({ "GET /tasks": inboxList([routineQaTask]) });

    await screen.findByText("Routine hand-off");
    const summary = screen.getByText(/Routine hand-off — view the summary/);
    const details = summary.closest("details");
    expect(details).not.toBeNull();
    // Collapsed by default — the summary itself is <summary>, the body behind it.
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("shows a flagged hand-off's concerns prominently, in the open", async () => {
    renderInbox({ "GET /tasks": inboxList([flaggedQaTask]) });

    await screen.findByText("Flagged hand-off");
    expect(screen.getByText(/Don.t miss this/)).toBeInTheDocument();
    expect(
      screen.getByText("The retry logic is untested under load — look closely."),
    ).toBeInTheDocument();
    // Not collapsed: the summary itself is immediately visible too.
    expect(screen.getByText("Added the throttle.")).toBeInTheDocument();
  });
});

describe("InboxPage — approve all routine", () => {
  const routineA = task(30, {
    status: "needs_qa",
    title: "Routine A",
    statusNote: "Done.",
    concerns: null,
  });
  const routineB = task(31, {
    status: "needs_qa",
    title: "Routine B",
    statusNote: "Done.",
    concerns: null,
  });
  const flagged = task(32, {
    status: "needs_qa",
    title: "Flagged C",
    statusNote: "Done.",
    concerns: "Watch the edge case.",
  });

  it("only offers the batch button with two or more routine items, and never sweeps in a flagged one", async () => {
    const user = userEvent.setup();
    const { requests } = renderInbox({
      "GET /tasks": inboxList([routineA, routineB, flagged]),
      "POST /tasks/30/transition": () => ({ body: makeTask({ id: 30, status: "done" }) }),
      "POST /tasks/31/transition": () => ({ body: makeTask({ id: 31, status: "done" }) }),
    });

    const button = await screen.findByRole("button", { name: "Approve all routine (2)" });
    await user.click(button);

    // One confirm step that names what is being approved; nothing is sent yet.
    const dialog = await screen.findByRole("dialog", { name: "Approve 2 tasks?" });
    expect(within(dialog).getByText(routineA.title)).toBeInTheDocument();
    expect(within(dialog).queryByText(flagged.title)).not.toBeInTheDocument();
    expect(posted(requests, "/transition")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Approve all" }));

    await waitFor(() => expect(posted(requests, "/transition")).toHaveLength(2));
    const approvedIds = posted(requests, "/transition")
      .map((r) => r.url.pathname.split("/").at(-2))
      .sort();
    expect(approvedIds).toEqual(["30", "31"]);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("2 tasks approved"));
  });

  it("does not show the batch button with fewer than two routine items", async () => {
    renderInbox({ "GET /tasks": inboxList([routineA, flagged]) });

    await screen.findByText("Routine A");
    expect(screen.queryByRole("button", { name: /Approve all routine/ })).not.toBeInTheDocument();
  });
});

describe("InboxPage — refine", () => {
  const refineTask = task(40, {
    status: "needs_refinement",
    title: "Unclear export target",
    statusNote: "Which format does 'export' mean here — CSV or JSON?",
  });

  it("requires acceptance criteria before it will move the task to To do", async () => {
    const user = userEvent.setup();
    const { requests } = renderInbox({ "GET /tasks": inboxList([refineTask]) });

    await user.click(await screen.findByRole("button", { name: "Ready for To do" }));

    expect(
      await screen.findByText("Acceptance criteria are required before a task can be todo"),
    ).toBeInTheDocument();
    expect(posted(requests, "/transition")).toHaveLength(0);
  });

  it("submits acceptance criteria and an optional note, moving the task to To do", async () => {
    const user = userEvent.setup();
    const { requests } = renderInbox({
      "GET /tasks": inboxList([refineTask]),
      "POST /tasks/40/transition": () => ({ body: makeTask({ id: 40, status: "todo" }) }),
    });

    await screen.findByText("Unclear export target");
    await user.type(
      screen.getByLabelText(/acceptance criteria/i),
      "Exporting produces a CSV with one row per task.",
    );
    await user.type(screen.getByLabelText(/Notes for the agent/i), "CSV, not JSON.");
    await user.click(screen.getByRole("button", { name: "Ready for To do" }));

    await waitFor(() => expect(posted(requests, "/transition")).toHaveLength(1));
    expect(posted(requests, "/transition")[0]?.body).toEqual({
      to: "todo",
      acceptanceCriteria: "Exporting produces a CSV with one row per task.",
      reason: "CSV, not JSON.",
    });
  });

  it("dismisses with a fixed reason, one click, no dialog", async () => {
    const user = userEvent.setup();
    const { requests } = renderInbox({
      "GET /tasks": inboxList([refineTask]),
      "POST /tasks/40/transition": () => ({ body: makeTask({ id: 40, status: "deferred" }) }),
    });

    await user.click(await screen.findByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(posted(requests, "/transition")).toHaveLength(1));
    expect(posted(requests, "/transition")[0]?.body).toEqual({
      to: "deferred",
      reason: DISMISS_REASON,
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("InboxPage — suggested", () => {
  const suggestedTask = task(50, {
    status: "todo",
    title: "Add a dark-mode toggle",
    description: "Add a dark-mode toggle to the settings page. Users keep asking for it.",
    needsTriage: true,
  });

  it("accepts by clearing needsTriage, without changing status", async () => {
    const user = userEvent.setup();
    const { requests } = renderInbox({
      "GET /tasks": inboxList([suggestedTask]),
      "PATCH /tasks/50": () => ({ body: makeTask({ id: 50, needsTriage: false }) }),
    });

    await user.click(await screen.findByRole("button", { name: "Accept" }));

    await waitFor(() => expect(patched(requests, "/tasks/50")).toHaveLength(1));
    expect(patched(requests, "/tasks/50")[0]?.body).toEqual({
      needsTriage: false,
      expectedVersion: suggestedTask.version,
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("TASK-000050 accepted"));
  });

  it("dismisses with a fixed reason", async () => {
    const user = userEvent.setup();
    const { requests } = renderInbox({
      "GET /tasks": inboxList([suggestedTask]),
      "POST /tasks/50/transition": () => ({ body: makeTask({ id: 50, status: "deferred" }) }),
    });

    await user.click(await screen.findByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(posted(requests, "/transition")).toHaveLength(1));
    expect(posted(requests, "/transition")[0]?.body).toEqual({
      to: "deferred",
      reason: DISMISS_REASON,
    });
  });
});

describe("InboxPage — blocked outside", () => {
  const blockedTask = task(60, {
    status: "blocked",
    title: "Blocked on vendor access",
    statusNote: "Waiting on the vendor to issue an API key.",
    openDependencyCount: 0,
    acceptanceCriteria: null,
  });

  it("opens the dialog to collect acceptance criteria when unblocking a task that has none", async () => {
    const user = userEvent.setup();
    const { requests } = renderInbox({ "GET /tasks": inboxList([blockedTask]) });

    await user.click(await screen.findByRole("button", { name: "Unblock" }));

    expect(
      await screen.findByRole("dialog", { name: "Move TASK-000060 to To do" }),
    ).toBeInTheDocument();
    expect(posted(requests, "/transition")).toHaveLength(0);
  });

  it("unblocks directly when the task already has acceptance criteria", async () => {
    const user = userEvent.setup();
    const { requests } = renderInbox({
      "GET /tasks": inboxList([{ ...blockedTask, acceptanceCriteria: "Vendor key is set." }]),
      "POST /tasks/60/transition": () => ({ body: makeTask({ id: 60, status: "todo" }) }),
    });

    await user.click(await screen.findByRole("button", { name: "Unblock" }));

    await waitFor(() => expect(posted(requests, "/transition")).toHaveLength(1));
    expect(posted(requests, "/transition")[0]?.body).toEqual({ to: "todo" });
  });

  it("parks with a fixed reason, one click, no dialog", async () => {
    const user = userEvent.setup();
    const { requests } = renderInbox({
      "GET /tasks": inboxList([blockedTask]),
      "POST /tasks/60/transition": () => ({ body: makeTask({ id: 60, status: "deferred" }) }),
    });

    await user.click(await screen.findByRole("button", { name: "Park" }));

    await waitFor(() => expect(posted(requests, "/transition")).toHaveLength(1));
    expect(posted(requests, "/transition")[0]?.body).toEqual({
      to: "deferred",
      reason: PARK_REASON,
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
