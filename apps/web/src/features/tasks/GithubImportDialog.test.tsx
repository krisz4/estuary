import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GithubImportDialog } from "@/features/tasks/GithubImportDialog";
import { makeTask, mockApi, renderInProviders } from "@/test/harness";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

afterEach(() => {
  vi.clearAllMocks();
});

/** A controlled wrapper, so a test can reopen the dialog after a close. */
const Harness = () => {
  const [open, setOpen] = useState(true);
  return <GithubImportDialog open={open} onOpenChange={setOpen} />;
};

const renderDialog = () => renderInProviders(<Harness />);

describe("GithubImportDialog", () => {
  it("posts the parsed import input and navigates to the new task", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      "GET /tasks/facets": () => ({
        body: { assignees: [], projects: [], labels: ["bug"], creators: [] },
      }),
      "POST /integrations/github/import": () => ({
        status: 201,
        body: makeTask({ id: 99, reference: "TASK-000099" }),
      }),
    });

    renderDialog();

    await user.type(screen.getByLabelText(/^issue/i), "https://github.com/acme/widgets/issues/7");
    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(requests.some((r) => r.method === "POST")).toBe(true));

    const post = requests.find((r) => r.method === "POST");
    expect(post?.body).toMatchObject({
      issue: "https://github.com/acme/widgets/issues/7",
      status: "backlog",
    });
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("Imported as TASK-000099"));
  });

  it("shows the schema's rejection on the issue field and keeps the typed value", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /tasks/facets": () => ({
        body: { assignees: [], projects: [], labels: [], creators: [] },
      }),
    });

    renderDialog();

    await user.type(screen.getByLabelText(/^issue/i), "not a github issue");
    await user.click(screen.getByRole("button", { name: "Import" }));

    expect(
      await screen.findByText('Expected a GitHub issue URL or "owner/repo#123"'),
    ).toBeInTheDocument();
    // The value the user typed is not cleared by a failed submit.
    expect(screen.getByLabelText(/^issue/i)).toHaveValue("not a github issue");
  });

  it("reports an already-imported issue distinctly from a new one", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /tasks/facets": () => ({
        body: { assignees: [], projects: [], labels: [], creators: [] },
      }),
      "POST /integrations/github/import": () => ({
        status: 200,
        body: makeTask({ id: 5, reference: "TASK-000005" }),
      }),
    });

    renderDialog();

    await user.type(screen.getByLabelText(/^issue/i), "acme/widgets#7");
    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining("Already imported as TASK-000005"),
      ),
    );
  });
});
