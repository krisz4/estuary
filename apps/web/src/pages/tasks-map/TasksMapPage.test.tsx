import { type FloorSnapshot, type FloorTask } from "@estuary/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  makePage,
  makeSummary,
  makeTask,
  mockApi,
  renderRoute,
  type RouteHandler,
} from "@/test/harness";
import { resetProjectScopeStore } from "@/stores/projectScope";
import { resetTaskViewStore } from "@/stores/taskView";
import { resetLogbookVisitStore } from "@/stores/logbookVisit";
import { resetMapVisitStore } from "@/stores/mapVisit";
import { setViewportWidth } from "../../../vitest.setup";
import { TasksMapPage } from "@/pages/tasks-map/TasksMapPage";
import { computeSince, statusListTitle } from "@/pages/tasks-map/TasksMapPage";

let nextId = 1;

const floorTask = (overrides: Partial<FloorTask> = {}): FloorTask => {
  const id = overrides.id ?? nextId++;
  return {
    id,
    reference: `TASK-${String(id).padStart(6, "0")}`,
    title: overrides.title ?? `Task ${id}`,
    status: overrides.status ?? "backlog",
    statusNote: overrides.statusNote ?? null,
    priority: overrides.priority ?? "medium",
    project: overrides.project === undefined ? "estuary" : overrides.project,
    assignee: overrides.assignee ?? null,
    labels: overrides.labels ?? [],
    parentId: overrides.parentId ?? null,
    childCount: overrides.childCount ?? 0,
    createdBy: overrides.createdBy ?? "human:krisz",
    claim: overrides.claim ?? null,
    pullRequestUrl: overrides.pullRequestUrl ?? null,
    version: overrides.version ?? 1,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    completedAt: overrides.completedAt ?? null,
    openBlockerCount: overrides.openBlockerCount ?? 0,
    unblocksCount: overrides.unblocksCount ?? 0,
    matches: overrides.matches ?? true,
  };
};

const floorSnapshot = (tasks: FloorTask[]): FloorSnapshot => ({
  tasks,
  edges: [],
  refs: [],
  meta: {
    total: tasks.length,
    truncated: false,
    olderClosedCount: 0,
    statusCounts: {
      backlog: tasks.filter((t) => t.status === "backlog").length,
      needs_refinement: 0,
      todo: tasks.filter((t) => t.status === "todo").length,
      in_progress: tasks.filter((t) => t.status === "in_progress").length,
      blocked: tasks.filter((t) => t.status === "blocked").length,
      needs_user_decision: tasks.filter((t) => t.status === "needs_user_decision").length,
      needs_user_action: tasks.filter((t) => t.status === "needs_user_action").length,
      needs_qa: tasks.filter((t) => t.status === "needs_qa").length,
      done: tasks.filter((t) => t.status === "done").length,
      deferred: 0,
    },
    matchCount: tasks.filter((t) => t.matches).length,
    shippedSince: "2026-01-01T00:00:00.000Z",
    at: null,
    lastEventId: 0,
    generatedAt: "2026-01-02T00:00:00.000Z",
  },
});

const emptyEventLog = () => ({
  body: { data: [], meta: { nextAfter: 0, nextBefore: null, hasMore: false } },
});
const emptyInbox = () => ({ body: { data: [], meta: { total: 0 } } });
const emptyHistory = () => ({
  body: {
    range: { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z", bucket: "day" },
    buckets: [],
    cycleTimes: [],
    longestWaits: [],
    agents: [],
  },
});

const renderMap = (handlers: Record<string, RouteHandler>, initialEntry = "/tasks/map") => {
  const api = mockApi({
    "GET /tasks/facets": () => ({
      body: { assignees: [], projects: [], creators: [], labels: [] },
    }),
    "GET /events": emptyEventLog,
    "GET /tasks": emptyInbox,
    "GET /stats/history": emptyHistory,
    ...handlers,
  });
  const { router } = renderRoute({
    routes: [{ path: "/tasks/map", element: <TasksMapPage /> }],
    initialEntries: [initialEntry],
  });
  return { ...api, router };
};

describe("computeSince", () => {
  const now = new Date("2026-02-01T00:00:00.000Z").getTime();
  const H = 60 * 60 * 1000;

  it("defaults to the window floor when there is no last visit", () => {
    expect(computeSince(null, 12 * H, now)).toBe(new Date(now - 12 * H).toISOString());
    expect(computeSince(null, 24 * H, now)).toBe(new Date(now - 24 * H).toISOString());
  });

  it("floors the lookback at the window minimum even when the last visit was very recent — the '37 seconds ago' bug", () => {
    const visit = new Date(now - 37_000).toISOString();
    expect(computeSince(visit, 12 * H, now)).toBe(new Date(now - 12 * H).toISOString());
  });

  it("uses the last visit itself once it is older than the window minimum", () => {
    const visit = new Date(now - 18 * H).toISOString();
    expect(computeSince(visit, 12 * H, now)).toBe(visit);
  });

  it("caps at 7 days even when the last visit was longer ago", () => {
    const visit = new Date(now - 30 * 24 * H).toISOString();
    expect(computeSince(visit, 12 * H, now)).toBe(new Date(now - 7 * 24 * H).toISOString());
  });
});

describe("statusListTitle", () => {
  it("names the briefing tiles' status sets, and labels a single station", () => {
    expect(statusListTitle(["needs_user_decision", "needs_user_action", "needs_qa"])).toBe(
      "Waiting on you",
    );
    expect(statusListTitle(["done", "deferred"])).toBe("Shipped");
    expect(statusListTitle(["backlog"])).toBe("Backlog");
  });
});

describe("TasksMapPage", () => {
  beforeEach(() => {
    resetProjectScopeStore();
    resetTaskViewStore();
    resetLogbookVisitStore();
    resetMapVisitStore();
    setViewportWidth(1024);
    nextId = 1;
  });

  it("shows a loading skeleton, then the hero and the sections", async () => {
    const tasks = [
      floorTask({ status: "needs_user_decision", title: "Pick a limiter" }),
      floorTask({ status: "in_progress", title: "Ship the thing" }),
    ];
    renderMap({ "GET /floor": () => ({ body: floorSnapshot(tasks) }) });

    await waitFor(() => expect(screen.getByLabelText("What happened")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: /Map/, level: 1 })).toBeInTheDocument();
    // The map's canvas region and the "All tasks" section both exist on the one long page.
    expect(screen.getByRole("heading", { name: /All tasks/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /In flight/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Recently/ })).toBeInTheDocument();
  });

  it("shows an error panel with retry, and recovers", async () => {
    let calls = 0;
    renderMap({
      "GET /floor": () => {
        calls += 1;
        if (calls === 1)
          return { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "boom" } } };
        return { body: floorSnapshot([floorTask({ title: "Recovered task" })]) };
      },
    });

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(screen.getAllByText("Recovered task").length).toBeGreaterThan(0));
  });

  it("shows the empty-map CTA when nothing is on the map", async () => {
    renderMap({ "GET /floor": () => ({ body: floorSnapshot([]) }) });
    await waitFor(() => expect(screen.getByText("Nothing on the map")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /file the first task/i })).toBeInTheDocument();
  });

  it("the 'Blocked' tile opens the blocked list in a dialog and leaves the map unfiltered", async () => {
    const tasks = [
      floorTask({ id: 1, status: "blocked", title: "Blocked one", openBlockerCount: 1 }),
      floorTask({ id: 2, status: "todo", title: "Ready task" }),
    ];
    const { requests } = renderMap({
      "GET /floor": () => ({ body: floorSnapshot(tasks) }),
      "GET /tasks": ({ url }) =>
        url.searchParams.getAll("status").join() === "blocked"
          ? { body: makePage([makeSummary({ id: 1, status: "blocked", title: "Blocked one" })]) }
          : emptyInbox(),
    });

    await waitFor(() => expect(screen.getAllByText("Ready task").length).toBeGreaterThan(0));
    await userEvent.click(screen.getByRole("button", { name: /on tasks/ }));

    const dialog = await screen.findByRole("dialog", { name: "Blocked" });
    await waitFor(() =>
      expect(within(dialog).getAllByText("Blocked one").length).toBeGreaterThan(0),
    );
    expect(
      requests.some(
        (request) =>
          request.url.pathname.endsWith("/tasks") &&
          request.url.searchParams.getAll("status").join() === "blocked",
      ),
    ).toBe(true);
    // The map underneath is untouched: no `status` filter, the todo task still there.
    expect(screen.getAllByText("Ready task", { ignore: "[role=dialog] *" }).length).toBeGreaterThan(
      0,
    );
    expect(
      requests.some(
        (request) =>
          request.url.pathname.endsWith("/floor") && request.url.searchParams.has("status"),
      ),
    ).toBe(false);
  });

  it("opens a task inside the same large dialog; Escape goes back to the list, then closes", async () => {
    const { requests } = renderMap(
      {
        "GET /floor": () => ({
          body: floorSnapshot([floorTask({ id: 3, title: "Backlog item" })]),
        }),
        "GET /tasks": ({ url }) =>
          url.searchParams.getAll("status").join() === "backlog"
            ? { body: makePage([makeSummary({ id: 3, status: "backlog", title: "Backlog item" })]) }
            : emptyInbox(),
        "GET /tasks/3": () => ({
          body: makeTask({ id: 3, title: "Backlog item", description: "The full description" }),
        }),
      },
      "/tasks/map?list=backlog",
    );

    const list = await screen.findByRole("dialog", { name: "Backlog" });
    await userEvent.type(within(list).getByRole("searchbox"), "item");
    // The search is debounced; let it land before leaving the list.
    await waitFor(() =>
      expect(requests.some((request) => request.url.searchParams.get("q") === "item")).toBe(true),
    );
    const row = await within(list).findAllByRole("link", { name: /Backlog item/ });
    await userEvent.click(row[0]!);

    // Same dialog, now showing the task — never a second one stacked on top.
    const task = await screen.findByRole("dialog", { name: "Backlog item" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(task).getByText("The full description")).toBeInTheDocument();
    expect(within(task).getByRole("button", { name: /Backlog/ })).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    const back = await screen.findByRole("dialog", { name: "Backlog" });
    // The search typed before opening the task survived the round trip.
    expect(within(back).getByRole("searchbox")).toHaveValue("item");

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("opens a task from the 'All tasks' ledger in the large dialog, and closes it", async () => {
    const tasks = [floorTask({ id: 7, title: "Open me from the map" })];
    renderMap({
      "GET /floor": () => ({ body: floorSnapshot(tasks) }),
      "GET /tasks/7": () => ({
        body: {
          id: 7,
          reference: "TASK-000007",
          title: "Open me from the map",
          description: "…",
          status: "backlog",
          statusNote: null,
          priority: "medium",
          project: "estuary",
          assignee: null,
          acceptanceCriteria: null,
          links: [],
          labels: [],
          parentId: null,
          childCount: 0,
          createdBy: "human:krisz",
          claim: null,
          version: 1,
          openDependencyCount: 0,
          openDecision: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          startedAt: null,
          completedAt: null,
          commentCount: 0,
          comments: [],
          decisions: [],
          parent: null,
          children: [],
          dependencies: [],
          dependents: [],
        },
      }),
    });

    await waitFor(() =>
      expect(screen.getAllByText("Open me from the map").length).toBeGreaterThan(0),
    );
    await userEvent.click(screen.getAllByRole("button", { name: /Open me from the map/ })[0]!);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("TASK-000007");

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("renders the needs-you queue's empty state distinctly from 'nothing on the map'", async () => {
    renderMap({ "GET /floor": () => ({ body: floorSnapshot([floorTask({ status: "todo" })]) }) });
    await waitFor(() =>
      expect(screen.getAllByText("Nothing needs you.").length).toBeGreaterThan(0),
    );
  });

  it("shows a live claim in 'In flight' and 'No agent is working right now.' when there is none", async () => {
    const claimed = floorTask({
      status: "in_progress",
      title: "Claimed task",
      claim: { actor: "agent:claude-code", expiresAt: "2026-06-01T00:00:00.000Z" },
    });
    renderMap({ "GET /floor": () => ({ body: floorSnapshot([claimed]) }) });
    await waitFor(() => expect(screen.getByText("agent:claude-code")).toBeInTheDocument());

    resetMapVisitStore();
    renderMap(
      { "GET /floor": () => ({ body: floorSnapshot([floorTask({ status: "todo" })]) }) },
      "/tasks/map?empty=1",
    );
    await waitFor(() =>
      expect(screen.getAllByText("No agent is working right now.").length).toBeGreaterThan(0),
    );
  });
});
