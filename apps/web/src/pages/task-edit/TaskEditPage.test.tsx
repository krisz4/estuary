import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/api/queryKeys";
import { diffTaskPatch, TaskEditPage, toFormValues } from "@/pages/task-edit/TaskEditPage";
import {
  makeQueryClient,
  makeTask,
  renderRoute,
  mockApi as mockHandlers,
  type RouteHandler,
} from "@/test/harness";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

/** The page asks for facets (project suggestions) alongside the task. */
const mockApi = (handlers: Record<string, RouteHandler>) =>
  mockHandlers({
    "GET /tasks/facets": () => ({ body: { assignees: [], projects: [], creators: [] } }),
    ...handlers,
  });

const routes = [
  { path: "/tasks/:taskId/edit", element: <TaskEditPage /> },
  { path: "/tasks/:taskId", element: <div>Detail page</div> },
  { path: "/tasks", element: <div>Tasks list</div> },
];

const renderEdit = (queryClient = makeQueryClient()) =>
  renderRoute({ routes, initialEntries: ["/tasks/42/edit"], queryClient });

const TITLE = "Add rate limiting to the export endpoint";

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

/* ------------------------------------------------------------------ *
 * The diff, as a unit
 * ------------------------------------------------------------------ */

describe("diffTaskPatch", () => {
  const task = makeTask({
    assignee: "Marcus Feld",
    links: [{ label: "PR", url: "https://example.com/pr/1" }],
  });

  it("is empty when nothing moved", () => {
    // Comparing the schema's *output* for the untouched task, which is what
    // the form hands in — not the raw control values.
    expect(
      diffTaskPatch(
        {
          title: task.title,
          description: task.description,
          priority: task.priority,
          project: task.project,
          assignee: task.assignee,
          acceptanceCriteria: task.acceptanceCriteria,
          // A fresh array with the same contents — what the resolver produces.
          links: [{ label: "PR", url: "https://example.com/pr/1" }],
          parentId: task.parentId,
        },
        task,
      ),
    ).toEqual({});
  });

  it("carries only the changed keys", () => {
    expect(diffTaskPatch({ title: "New title", priority: task.priority }, task)).toEqual({
      title: "New title",
    });
  });

  it("compares links by value, and sends the whole list when one changed", () => {
    const links = [
      { label: "PR", url: "https://example.com/pr/1" },
      { label: "Branch", url: "https://example.com/tree/x" },
    ];
    expect(diffTaskPatch({ links }, task)).toEqual({ links });
  });

  it("sends null — not an empty string — for a cleared optional", () => {
    expect(diffTaskPatch({ assignee: null, project: null }, task)).toEqual({
      assignee: null,
      project: null,
    });
  });

  it("does not treat null === null as a change", () => {
    const unassigned = makeTask({ assignee: null });
    expect(diffTaskPatch({ assignee: null }, unassigned)).toEqual({});
  });
});

describe("toFormValues", () => {
  it("maps nulls to the empty strings the controls hold, and has no status", () => {
    const values = toFormValues(
      makeTask({ assignee: null, project: null, acceptanceCriteria: null, parentId: 7 }),
    );
    expect(values).toMatchObject({
      assignee: "",
      project: "",
      acceptanceCriteria: "",
      parentId: "7",
    });
    expect(values).not.toHaveProperty("status");
  });
});

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

describe("TaskEditPage", () => {
  it("prefills from the loaded task", async () => {
    mockApi({ "GET /tasks/42": () => ({ body: makeTask({ assignee: "Marcus Feld" }) }) });
    renderEdit();

    await waitFor(() => expect(screen.getByLabelText(/^title/i)).toHaveValue(TITLE));
    expect(screen.getByLabelText(/assignee/i)).toHaveValue("Marcus Feld");
    expect(screen.getByLabelText(/^project/i)).toHaveValue("estuary");
    expect(screen.getByLabelText(/^acceptance criteria/i)).toHaveValue(
      "Requests over 10/min get a 429.",
    );
  });

  /*
    Status moves by transition, from the detail page — never through this form.
  */
  it("has no status control", async () => {
    mockApi({ "GET /tasks/42": () => ({ body: makeTask() }) });
    renderEdit();

    await screen.findByDisplayValue(TITLE);
    expect(screen.queryByRole("combobox", { name: /status/i })).not.toBeInTheDocument();
  });

  it("PATCHes only the fields that changed, with the version it loaded", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      "GET /tasks/42": () => ({ body: makeTask({ version: 3 }) }),
      "PATCH /tasks/42": () => ({ body: makeTask({ title: "Rate-limit exports" }) }),
    });

    renderEdit();
    await screen.findByDisplayValue(TITLE);

    await user.clear(screen.getByLabelText(/^title/i));
    await user.type(screen.getByLabelText(/^title/i), "Rate-limit exports");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(requests.some((r) => r.method === "PATCH")).toBe(true));
    expect(requests.find((r) => r.method === "PATCH")?.body).toEqual({
      title: "Rate-limit exports",
      expectedVersion: 3,
    });
    expect(toast.success).toHaveBeenCalledWith("Changes saved");
  });

  /**
   * The diff exists to stop a save from clobbering a field the user never
   * touched. It can only do that if it compares against the task the form was
   * **initialised from** — react-hook-form reads `defaultValues` once, so a
   * refetch (or a poll) that lands after mount moves only one side of the
   * comparison.
   *
   * And `expectedVersion` must be the *loaded* version for the same reason: the
   * live one has already moved past the agent's write the server should catch.
   */
  it("diffs and versions against what it loaded, not what a poll brought in", async () => {
    const user = userEvent.setup();
    const queryClient = makeQueryClient();
    const { requests } = mockApi({
      "GET /tasks/42": () => ({ body: makeTask({ assignee: null, version: 3 }) }),
      "PATCH /tasks/42": () => ({ body: makeTask({ title: "Rate-limit exports" }) }),
    });

    renderEdit(queryClient);
    await screen.findByDisplayValue(TITLE);
    expect(screen.getByLabelText(/assignee/i)).toHaveValue("");

    // An agent assigns it. This is what a poll returning a changed row does to
    // the cache; writing it directly makes the race deterministic.
    act(() => {
      queryClient.setQueryData(
        queryKeys.tasks.detail(42),
        makeTask({ assignee: "claude-code", version: 4 }),
      );
    });

    // The form still shows what it mounted with — that is the whole problem.
    expect(screen.getByLabelText(/assignee/i)).toHaveValue("");

    await user.clear(screen.getByLabelText(/^title/i));
    await user.type(screen.getByLabelText(/^title/i), "Rate-limit exports");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(requests.some((r) => r.method === "PATCH")).toBe(true));
    expect(requests.find((r) => r.method === "PATCH")?.body).toEqual({
      title: "Rate-limit exports",
      expectedVersion: 3,
    });
  });

  it("clears an assignee to null rather than an empty string", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      "GET /tasks/42": () => ({ body: makeTask({ assignee: "Marcus Feld" }) }),
      "PATCH /tasks/42": () => ({ body: makeTask({ assignee: null }) }),
    });

    renderEdit();
    await waitFor(() => expect(screen.getByLabelText(/assignee/i)).toHaveValue("Marcus Feld"));

    await user.clear(screen.getByLabelText(/assignee/i));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(requests.some((r) => r.method === "PATCH")).toBe(true));
    expect(requests.find((r) => r.method === "PATCH")?.body).toEqual({
      assignee: null,
      expectedVersion: 3,
    });
  });

  it("short-circuits an unchanged save without calling the API", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({ "GET /tasks/42": () => ({ body: makeTask() }) });

    renderEdit();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(toast.info).toHaveBeenCalledWith("No changes to save"));
    expect(requests.some((r) => r.method === "PATCH")).toBe(false);
  });

  describe("on VERSION_CONFLICT", () => {
    const conflict = () => ({
      status: 409,
      body: {
        error: {
          code: "VERSION_CONFLICT",
          message: "stale",
          details: { expected: 3, current: 4 },
          requestId: "r1",
        },
      },
    });

    it("says so, keeps every typed value, and does not toast", async () => {
      const user = userEvent.setup();
      mockApi({
        "GET /tasks/42": () => ({ body: makeTask() }),
        "PATCH /tasks/42": conflict,
      });

      renderEdit();
      await screen.findByDisplayValue(TITLE);

      await user.type(screen.getByLabelText(/assignee/i), "Marcus");
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      expect(
        await screen.findByText(
          /Someone — possibly an agent — changed this task; reload to see their changes/,
        ),
      ).toBeInTheDocument();
      expect(screen.getByLabelText(/assignee/i)).toHaveValue("Marcus");
      expect(toast.error).not.toHaveBeenCalled();
    });

    it("reloads the task into the form when asked, at the new version", async () => {
      const user = userEvent.setup();
      let version = 3;
      const { requests } = mockApi({
        "GET /tasks/42": () => ({
          body: makeTask({ version, assignee: version > 3 ? "claude-code" : null }),
        }),
        "PATCH /tasks/42": ({ body }) =>
          (body as { expectedVersion: number }).expectedVersion === 4
            ? { body: makeTask({ version: 5 }) }
            : conflict(),
      });

      renderEdit();
      await screen.findByDisplayValue(TITLE);

      await user.type(screen.getByLabelText(/^description/i), " Soon.");
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      await screen.findByRole("button", { name: "Reload task" });

      // The agent's write the conflict was about.
      version = 4;
      await user.click(screen.getByRole("button", { name: "Reload task" }));

      await waitFor(() => expect(screen.getByLabelText(/assignee/i)).toHaveValue("claude-code"));
      expect(screen.queryByRole("button", { name: "Reload task" })).not.toBeInTheDocument();

      await user.type(screen.getByLabelText(/^description/i), " Soon.");
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(screen.getByText("Detail page")).toBeInTheDocument());
      const patches = requests.filter((r) => r.method === "PATCH");
      expect(patches.at(-1)?.body).toMatchObject({ expectedVersion: 4 });
    });
  });

  /**
   * Cancel must **replace**, not push. Pushing leaves the form in the stack, so
   * from `/tasks/42` → Edit → Cancel the history reads
   * `[list, detail, edit, detail]` and one Back press drops the user back inside
   * the form they just abandoned — with a second press needed to reach the
   * detail page they were already looking at.
   *
   * Only the router can see this: both spellings put the detail page on screen,
   * so no assertion about the rendered output can tell them apart.
   */
  it("replaces the form's history entry on Cancel, so Back does not reopen it", async () => {
    const user = userEvent.setup();
    mockApi({ "GET /tasks/42": () => ({ body: makeTask() }) });

    const { router } = renderRoute({
      routes,
      initialEntries: ["/tasks", "/tasks/42", "/tasks/42/edit"],
    });
    await screen.findByDisplayValue(TITLE);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByText("Detail page")).toBeInTheDocument());

    await act(async () => {
      await router.navigate(-1);
    });

    expect(router.state.location.pathname).toBe("/tasks/42");
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  });

  it("shows the not-found state for a task deleted elsewhere", async () => {
    mockApi({
      "GET /tasks/42": () => ({
        status: 404,
        body: { error: { code: "TASK_NOT_FOUND", message: "gone", requestId: "r1" } },
      }),
    });

    renderEdit();
    expect(await screen.findByText("This task doesn't exist")).toBeInTheDocument();
  });
});
