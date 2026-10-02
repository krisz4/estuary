import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CleanupDoneButton } from "@/features/tasks/CleanupDoneButton";
import { makeStats, mockApi, renderInProviders } from "@/test/harness";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

afterEach(() => {
  vi.clearAllMocks();
});

const statsWithDone = (done: number) => () => ({
  body: makeStats({ byStatus: { ...makeStats().byStatus, done } }),
});

describe("CleanupDoneButton", () => {
  it("confirms with the done count for the project, then posts the scoped cleanup", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      "GET /tasks/stats": statsWithDone(3),
      "POST /tasks/cleanup": () => ({ body: { deleted: 3, taskIds: [1, 2, 3], dryRun: false } }),
    });

    renderInProviders(<CleanupDoneButton project={["estuary"]} />);

    const trigger = await screen.findByRole("button", { name: /clean up done/i });
    await waitFor(() => expect(trigger).toBeEnabled());
    await user.click(trigger);

    expect(
      await screen.findByText(/permanently delete 3 done tasks in estuary/i),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete 3 tasks" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Deleted 3 done tasks"));
    const post = requests.find((r) => r.method === "POST");
    expect(post?.body).toEqual({ project: ["estuary"] });
    const statsRequest = requests.find((r) => r.url.pathname.endsWith("/tasks/stats"));
    expect(statsRequest?.url.searchParams.getAll("project")).toEqual(["estuary"]);
  });

  it("sends no project filter when the list is unscoped", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      "GET /tasks/stats": statsWithDone(1),
      "POST /tasks/cleanup": () => ({ body: { deleted: 1, taskIds: [9], dryRun: false } }),
    });

    renderInProviders(<CleanupDoneButton project={[]} />);

    const trigger = await screen.findByRole("button", { name: /clean up done/i });
    await waitFor(() => expect(trigger).toBeEnabled());
    await user.click(trigger);
    expect(await screen.findByText(/in all projects/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete 1 task" }));

    await waitFor(() => expect(requests.some((r) => r.method === "POST")).toBe(true));
    expect(requests.find((r) => r.method === "POST")?.body).toEqual({});
  });

  it("is disabled when there is nothing done", async () => {
    mockApi({ "GET /tasks/stats": statsWithDone(0) });

    renderInProviders(<CleanupDoneButton project={[]} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /clean up done/i })).toBeDisabled(),
    );
  });

  it("toasts the error and deletes nothing visible when the server refuses", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /tasks/stats": statsWithDone(2),
      "POST /tasks/cleanup": () => ({
        status: 403,
        body: {
          error: {
            code: "ACTOR_NOT_PERMITTED",
            message: "Only a human can clean up done tasks",
            requestId: "req-1",
          },
        },
      }),
    });

    renderInProviders(<CleanupDoneButton project={[]} />);

    const trigger = await screen.findByRole("button", { name: /clean up done/i });
    await waitFor(() => expect(trigger).toBeEnabled());
    await user.click(trigger);
    await user.click(await screen.findByRole("button", { name: "Delete 2 tasks" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });
});
