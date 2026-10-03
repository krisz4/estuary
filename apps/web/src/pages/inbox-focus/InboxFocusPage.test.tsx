import { formatReference, type TaskSummary } from "@estuary/contracts";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InboxFocusPage } from "@/pages/inbox-focus/InboxFocusPage";
import {
  makeComment,
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
  statusNote: "Rotate the key in 1Password.",
});
const qaTask = task(9, {
  status: "needs_qa",
  title: "Rate-limit exports",
  statusNote: "Added a token bucket.",
  description: "Exports hammer the database at month end.",
});

/** A detail handler for every id — the context panel and the next-item prefetch both read it. */
const details = (...tasks: TaskSummary[]): Record<string, RouteHandler> =>
  Object.fromEntries(
    tasks.map((t) => [
      `GET /tasks/${t.id}`,
      () => ({ body: makeTask({ ...t, comments: [], decisions: [] }) }),
    ]),
  );

const renderFocus = (handlers: Record<string, RouteHandler>, initialEntry = "/inbox/focus") => {
  const api = mockApi(handlers);
  const { router } = renderRoute({
    routes: [
      { path: "/inbox/focus", element: <InboxFocusPage /> },
      { path: "/inbox", element: <div>Inbox page</div> },
      { path: "/tasks/:taskId", element: <div>Task page</div> },
      { path: "/tasks/map", element: <div>Map</div> },
    ],
    initialEntries: [initialEntry],
  });
  return { ...api, router };
};

/** The inbox list, answered from a mutable array so a test can clear items. */
const liveList = (initial: TaskSummary[]) => {
  const state = { tasks: initial };
  const handler: RouteHandler = () => ({ body: makePage(state.tasks, 100) });
  return { state, handler };
};

const posted = (requests: MockRequest[], suffix: string) =>
  requests.filter((request) => request.method === "POST" && request.url.pathname.endsWith(suffix));

const currentTitle = () => screen.getByRole("heading", { level: 3 }).textContent;

// jsdom has no layout, so no scrolling; each new item scrolls to the top.
const scrollTo = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
});

describe("InboxFocusPage — one at a time", () => {
  it("shows a skeleton, then only the first item in inbox order", async () => {
    const list = liveList([qaTask, actionTask, decisionTask]);
    renderFocus({ "GET /tasks": list.handler, ...details(qaTask, actionTask, decisionTask) });

    expect(screen.getByLabelText("Loading focus")).toBeInTheDocument();

    // Decide comes before Act and Review, whatever the response order.
    expect(await screen.findByRole("heading", { name: "Pick a rate limiter" })).toBeInTheDocument();
    expect(screen.queryByText("Rotate the staging API key")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 3 left")).toBeInTheDocument();
    expect(screen.getByText("0 cleared")).toBeInTheDocument();
  });

  it("steps with Skip and Previous, and from the keyboard", async () => {
    const user = userEvent.setup();
    const list = liveList([decisionTask, actionTask, qaTask]);
    renderFocus({ "GET /tasks": list.handler, ...details(decisionTask, actionTask, qaTask) });

    await screen.findByRole("heading", { name: "Pick a rate limiter" });
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Skip" }));
    expect(currentTitle()).toBe("Rotate the staging API key");
    expect(screen.getByText("2 of 3 left")).toBeInTheDocument();

    await user.keyboard("j");
    expect(currentTitle()).toBe("Rate-limit exports");

    await user.keyboard("{ArrowLeft}");
    expect(currentTitle()).toBe("Rotate the staging API key");

    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(currentTitle()).toBe("Pick a rate limiter");
  });

  it("wraps Skip back to the skipped items and says so", async () => {
    const user = userEvent.setup();
    const list = liveList([actionTask, qaTask]);
    renderFocus({ "GET /tasks": list.handler, ...details(actionTask, qaTask) });

    await screen.findByRole("heading", { name: "Rotate the staging API key" });
    await user.click(screen.getByRole("button", { name: "Skip" }));
    await user.click(screen.getByRole("button", { name: "Skip" }));

    expect(currentTitle()).toBe("Rotate the staging API key");
    expect(screen.getByText(/these are the ones you skipped/)).toBeInTheDocument();
  });

  it("moves on to the next item once this one is cleared", async () => {
    const user = userEvent.setup();
    const list = liveList([actionTask, qaTask]);
    const { requests } = renderFocus({
      "GET /tasks": list.handler,
      ...details(actionTask, qaTask),
      "POST /tasks/8/transition": () => {
        list.state.tasks = [qaTask];
        return { body: makeTask({ id: 8, status: "done" }) };
      },
    });

    await screen.findByRole("heading", { name: "Rotate the staging API key" });
    await user.click(screen.getByRole("button", { name: "Mark done" }));

    await waitFor(() => expect(posted(requests, "/transition")).toHaveLength(1));
    expect(await screen.findByRole("heading", { name: "Rate-limit exports" })).toBeInTheDocument();
    expect(screen.getByText("1 of 1 left")).toBeInTheDocument();
    expect(screen.getByText("1 cleared")).toBeInTheDocument();
    // Its buttons are gone, so focus moves to the new item rather than <body>.
    expect(screen.getByLabelText("Current item")).toHaveFocus();
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
  });

  it("keeps its order when a more urgent item arrives — new items join at the end", async () => {
    const user = userEvent.setup();
    const urgent = task(11, {
      status: "needs_user_action",
      priority: "urgent",
      title: "Restart the runner",
    });
    const list = liveList([actionTask, task(12, { status: "needs_user_action", title: "Second" })]);
    renderFocus({
      "GET /tasks": list.handler,
      ...details(actionTask, urgent, task(12, {})),
      "POST /tasks/8/transition": () => {
        list.state.tasks = [urgent, task(12, { status: "needs_user_action", title: "Second" })];
        return { body: makeTask({ id: 8, status: "done" }) };
      },
    });

    await screen.findByRole("heading", { name: "Rotate the staging API key" });
    await user.click(screen.getByRole("button", { name: "Mark done" }));

    expect(await screen.findByRole("heading", { name: "Second" })).toBeInTheDocument();
    expect(screen.getByText("1 of 2 left")).toBeInTheDocument();
  });

  it("says all clear once the last item is cleared", async () => {
    const user = userEvent.setup();
    const list = liveList([actionTask]);
    renderFocus({
      "GET /tasks": list.handler,
      ...details(actionTask),
      "POST /tasks/8/transition": () => {
        list.state.tasks = [];
        return { body: makeTask({ id: 8, status: "done" }) };
      },
    });

    await screen.findByRole("heading", { name: "Rotate the staging API key" });
    await user.click(screen.getByRole("button", { name: "Mark done" }));

    expect(await screen.findByText("All clear — 1 item cleared")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to the inbox/i })).toHaveAttribute(
      "href",
      "/inbox",
    );
  });
});

describe("InboxFocusPage — context", () => {
  it("shows the description and the latest comments", async () => {
    renderFocus({
      "GET /tasks": liveList([qaTask]).handler,
      "GET /tasks/9": () => ({
        body: makeTask({
          ...qaTask,
          decisions: [],
          comments: [
            makeComment({ id: 1, body: "First pass" }),
            makeComment({ id: 2, body: "Second pass" }),
            makeComment({ id: 3, body: "Third pass" }),
            makeComment({ id: 4, body: "Load test is green" }),
          ],
        }),
      }),
    });

    expect(
      await screen.findByText("Exports hammer the database at month end."),
    ).toBeInTheDocument();
    expect(await screen.findByText("Load test is green")).toBeInTheDocument();
    expect(screen.queryByText("First pass")).not.toBeInTheDocument();
    expect(screen.getByText("1 earlier comment on the task page")).toBeInTheDocument();
  });
});

describe("InboxFocusPage — slices and exits", () => {
  it("narrows to one kind from ?kind=, with chips to the other slices", async () => {
    const list = liveList([decisionTask, actionTask, qaTask]);
    renderFocus(
      { "GET /tasks": list.handler, ...details(decisionTask, actionTask, qaTask) },
      "/inbox/focus?project=estuary&kind=review",
    );

    expect(await screen.findByRole("heading", { name: "Rate-limit exports" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Focus: Review");
    expect(screen.getByText("1 of 1 left")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Review/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /^All/ })).toHaveAttribute(
      "href",
      "/inbox/focus?project=estuary",
    );
  });

  it("offers the rest of the queue when a kind slice is empty", async () => {
    renderFocus(
      { "GET /tasks": liveList([actionTask]).handler, ...details(actionTask) },
      "/inbox/focus?kind=review",
    );

    expect(await screen.findByText("Nothing in Review needs you")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /focus on everything else \(1\)/i })).toHaveAttribute(
      "href",
      "/inbox/focus",
    );
  });

  it("says nothing needs you when the queue is empty", async () => {
    renderFocus({ "GET /tasks": liveList([]).handler });
    expect(await screen.findByText("Nothing needs you")).toBeInTheDocument();
  });

  it("opens the task with o and exits to the inbox with Esc", async () => {
    const user = userEvent.setup();
    const { router } = renderFocus({
      "GET /tasks": liveList([actionTask]).handler,
      ...details(actionTask),
    });

    await screen.findByRole("heading", { name: "Rotate the staging API key" });
    await user.keyboard("o");
    expect(router.state.location.pathname).toBe("/tasks/8");

    await router.navigate("/inbox/focus?project=estuary");
    await screen.findByRole("heading", { name: "Rotate the staging API key" });
    await user.keyboard("{Escape}");
    expect(router.state.location.pathname).toBe("/inbox");
    expect(router.state.location.search).toBe("?project=estuary");
  });

  it("ignores shortcuts while typing", async () => {
    const user = userEvent.setup();
    renderFocus({
      "GET /tasks": liveList([decisionTask, actionTask]).handler,
      ...details(decisionTask, actionTask),
    });

    await screen.findByRole("heading", { name: "Pick a rate limiter" });
    await user.type(screen.getByLabelText(/add a note/i), "jk");

    expect(currentTitle()).toBe("Pick a rate limiter");
    expect(screen.getByLabelText(/add a note/i)).toHaveValue("jk");
  });
});
