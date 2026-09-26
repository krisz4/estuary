import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppLayout } from "@/components/layout/AppLayout";
import { type TaskFacets } from "@helpdesk/contracts";
import {
  makeStats,
  mockApi,
  renderRoute,
  type MockRequest,
  type RouteHandler,
} from "@/test/harness";
import { useProjectScopeStore } from "@/stores/projectScope";
import { useSessionStore } from "@/stores/session";
import { useTaskViewStore } from "@/stores/taskView";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

/**
 * The shell: the inbox link and its badge, the "You" control, and the 401
 * banner. Rendered through `AppLayout` so the session dialog — mounted once,
 * there — is the real one.
 */

const renderShell = (initialEntry = "/tasks") =>
  renderRoute({
    routes: [
      {
        element: <AppLayout />,
        children: [
          { path: "/tasks", element: <p>Tasks page</p> },
          { path: "/tasks/map", element: <p>Map page</p> },
          { path: "/tasks/:taskId", element: <p>Task page</p> },
          { path: "/inbox", element: <p>Inbox page</p> },
        ],
      },
    ],
    initialEntries: [initialEntry],
  });

const makeFacets = (overrides: Partial<TaskFacets> = {}): TaskFacets => ({
  assignees: [],
  projects: [],
  labels: [],
  creators: [],
  ...overrides,
});

/** The header reads facets for the project switcher; no projects hides it. */
const shellApi = (handlers: Record<string, RouteHandler>) =>
  mockApi({ "GET /tasks/facets": () => ({ body: makeFacets() }), ...handlers });

describe("AppHeader — inbox", () => {
  it("badges the inbox link with the number of tasks waiting on a human", async () => {
    shellApi({ "GET /tasks/stats": () => ({ body: makeStats({ needsAttention: 3 }) }) });

    renderShell();

    const link = await screen.findByRole("link", { name: "Inbox, 3 waiting on you" });
    expect(link).toHaveAttribute("href", "/inbox");
    expect(link).toHaveTextContent("3");
  });

  it("shows no badge when nothing is waiting", async () => {
    const { requests } = shellApi({ "GET /tasks/stats": () => ({ body: makeStats() }) });

    renderShell();

    await waitFor(() =>
      expect(requests.some((request) => request.url.pathname.endsWith("/tasks/stats"))).toBe(true),
    );
    expect(screen.getByRole("link", { name: "Inbox" })).not.toHaveTextContent(/\d/);
  });

  it("keeps working when the stats request fails", async () => {
    shellApi({
      "GET /tasks/stats": () => ({
        status: 500,
        body: { error: { code: "INTERNAL_ERROR", message: "x", requestId: "r" } },
      }),
    });

    renderShell();

    expect(await screen.findByRole("link", { name: "Inbox" })).toBeInTheDocument();
  });
});

describe("AppHeader — You", () => {
  it("opens the session dialog and saves a display name", async () => {
    const user = userEvent.setup();
    shellApi({ "GET /tasks/stats": () => ({ body: makeStats() }) });

    renderShell();

    // Two buttons by design (icon-only below `sm`, labelled above); both open it.
    const [iconButton] = screen.getAllByRole("button", { name: /^You: anonymous/ });
    await user.click(iconButton!);

    const dialog = await screen.findByRole("dialog", { name: "You" });
    await user.type(within(dialog).getByLabelText("Your name"), "Krisz Tian");
    expect(
      within(dialog).getByText("Your changes are recorded as human:krisz-tian."),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useSessionStore.getState().displayName).toBe("Krisz Tian");
    expect(screen.getAllByRole("button", { name: /^You: krisz-tian/ }).length).toBeGreaterThan(0);
  });

  it("does not save a dismissed draft", async () => {
    const user = userEvent.setup();
    shellApi({ "GET /tasks/stats": () => ({ body: makeStats() }) });

    renderShell();

    await user.click(screen.getAllByRole("button", { name: /^You:/ })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "You" });
    await user.type(within(dialog).getByLabelText("Your name"), "Half");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useSessionStore.getState().displayName).toBe("");
  });
});

describe("the 401 prompt", () => {
  it("points at the session dialog after an UNAUTHORIZED, and clears once a token is saved", async () => {
    const user = userEvent.setup();
    let authorized = false;
    shellApi({
      "GET /tasks/stats": ({ url: _url }) =>
        authorized
          ? { body: makeStats() }
          : {
              status: 401,
              body: { error: { code: "UNAUTHORIZED", message: "x", requestId: "r" } },
            },
    });

    renderShell();

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("This server needs an API token.");

    await user.click(within(banner).getByRole("button", { name: "Set API token" }));
    const dialog = await screen.findByRole("dialog", { name: "You" });
    await user.type(within(dialog).getByLabelText("API token"), "s3cret");

    authorized = true;
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByText(/needs an API token/)).not.toBeInTheDocument());
    expect(useSessionStore.getState().apiToken).toBe("s3cret");
  });
});

describe("AppHeader — project scope", () => {
  const projectFacets = () => ({ body: makeFacets({ projects: ["helpdesk", "web-app"] }) });

  it("hides the switcher while no task has a project", async () => {
    shellApi({ "GET /tasks/stats": () => ({ body: makeStats() }) });

    renderShell();

    await screen.findByRole("link", { name: "Inbox" });
    expect(screen.queryByRole("combobox", { name: "Current project" })).not.toBeInTheDocument();
  });

  it("scopes the inbox link and its badge to the project in the URL", async () => {
    const { requests } = shellApi({
      "GET /tasks/facets": projectFacets,
      "GET /tasks/stats": ({ url }) => ({
        body: makeStats({ needsAttention: url.searchParams.get("project") === "web-app" ? 2 : 9 }),
      }),
    });

    renderShell("/tasks?project=web-app&status=todo");

    const link = await screen.findByRole("link", { name: "Inbox, 2 waiting on you" });
    expect(link).toHaveAttribute("href", "/inbox?project=web-app");
    expect(screen.getByRole("link", { name: "Estuary" })).toHaveAttribute(
      "href",
      "/tasks?project=web-app",
    );
    expect(await screen.findByRole("combobox", { name: "Current project" })).toHaveTextContent(
      "web-app",
    );
    expect(
      requests.some((request) => request.url.searchParams.getAll("project").includes("web-app")),
    ).toBe(true);
  });

  it("keeps the remembered scope on screens without a project filter", async () => {
    useProjectScopeStore.setState({ project: "helpdesk" });
    shellApi({
      "GET /tasks/facets": projectFacets,
      "GET /tasks/stats": () => ({ body: makeStats() }),
    });

    renderShell("/tasks/42");

    expect(await screen.findByRole("link", { name: "Inbox" })).toHaveAttribute(
      "href",
      "/inbox?project=helpdesk",
    );
    expect(await screen.findByRole("combobox", { name: "Current project" })).toHaveTextContent(
      "helpdesk",
    );
  });

  it("links 'Tasks' to the remembered view in the current scope, and marks it current on task screens", async () => {
    useProjectScopeStore.setState({ project: "helpdesk" });
    useTaskViewStore.setState({ view: "map" });
    shellApi({
      "GET /tasks/facets": projectFacets,
      "GET /tasks/stats": () => ({ body: makeStats() }),
    });

    renderShell("/tasks/42");

    const tasks = await screen.findByRole("link", { name: "Tasks" });
    expect(tasks).toHaveAttribute("href", "/tasks/map?project=helpdesk");
    expect(tasks).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Inbox" })).not.toHaveAttribute("aria-current");
  });

  it("swaps the project param in place, keeping other filters and dropping the page", async () => {
    const user = userEvent.setup();
    const { router, requests } = renderShellWithApi("/tasks?project=helpdesk&status=todo&page=3");

    await user.click(await screen.findByRole("combobox", { name: "Current project" }));
    await user.click(await screen.findByRole("option", { name: "web-app" }));

    await waitFor(() => expect(router.state.location.search).toBe("?status=todo&project=web-app"));
    expect(router.state.location.pathname).toBe("/tasks");

    await user.click(screen.getByRole("combobox", { name: "Current project" }));
    await user.click(await screen.findByRole("option", { name: "All projects" }));
    await waitFor(() => expect(router.state.location.search).toBe("?status=todo"));
    // The badge follows: its unscoped request is the last one this test causes.
    await waitFor(() => expect(statsRequestsFor(requests, null)).toBeGreaterThan(0));
  });

  it("goes to the remembered view from a screen with no filter to swap", async () => {
    const user = userEvent.setup();
    const { router, requests } = renderShellWithApi("/tasks/42");

    await user.click(await screen.findByRole("combobox", { name: "Current project" }));
    await user.click(await screen.findByRole("option", { name: "web-app" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/tasks"));
    expect(router.state.location.search).toBe("?project=web-app");
    await waitFor(() => expect(statsRequestsFor(requests, "web-app")).toBeGreaterThan(0));
  });

  const renderShellWithApi = (entry: string) => {
    const { requests } = shellApi({
      "GET /tasks/facets": projectFacets,
      "GET /tasks/stats": () => ({ body: makeStats() }),
    });
    return { ...renderShell(entry), requests };
  };

  /** Stats requests scoped to `project` (`null`: unscoped). */
  const statsRequestsFor = (requests: MockRequest[], project: string | null) =>
    requests.filter(
      (request) =>
        request.url.pathname.endsWith("/tasks/stats") &&
        request.url.searchParams.get("project") === project,
    ).length;
});
