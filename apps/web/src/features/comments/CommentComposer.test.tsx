import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/api/queryKeys";
import { CommentComposer } from "@/features/comments/CommentComposer";
import { makeComment, makeQueryClient, renderInProviders, mockApi } from "@/test/harness";
import { useSessionStore } from "@/stores/session";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const fill = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByLabelText(/^comment/i), "Swapped the lamp module.");
};

describe("CommentComposer", () => {
  it("clears the body on success", async () => {
    const user = userEvent.setup();
    mockApi({ "POST /comments": () => ({ status: 201, body: makeComment() }) });

    renderInProviders(<CommentComposer taskId={42} />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: /add comment/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/^comment/i)).toHaveValue("");
    });
  });

  /*
    The author is the session's actor, sent as `X-Actor` by `http.ts` — never a
    field in the body, which the contract's `.strict()` would reject.
  */
  it("posts as the session's name, with no author field in the body", async () => {
    const user = userEvent.setup();
    useSessionStore.getState().save({ displayName: "Priya Nair", apiToken: "" });
    const { requests } = mockApi({
      "POST /comments": () => ({ status: 201, body: makeComment() }),
    });

    renderInProviders(<CommentComposer taskId={42} />);
    expect(screen.getByText(/posting as/i)).toHaveTextContent("Posting as Human priya-nair");

    await fill(user);
    await user.click(screen.getByRole("button", { name: /add comment/i }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.body).toEqual({ body: "Swapped the lamp module.", kind: "note" });
  });

  it("says who you are posting as, and offers to change it", async () => {
    const user = userEvent.setup();
    mockApi({});

    renderInProviders(<CommentComposer taskId={42} />);
    expect(screen.getByText(/posting as/i)).toHaveTextContent("Posting as Human Anonymous");

    await user.click(screen.getByRole("button", { name: "Change" }));
    expect(useSessionStore.getState().isDialogOpen).toBe(true);
  });

  it("sends the kind that was picked", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      "POST /comments": () => ({ status: 201, body: makeComment() }),
    });

    renderInProviders(<CommentComposer taskId={42} />);
    await fill(user);
    await user.click(screen.getByRole("combobox", { name: "Kind" }));
    await user.click(await screen.findByRole("option", { name: "QA feedback" }));
    await user.click(screen.getByRole("button", { name: /add comment/i }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.body).toEqual({ body: "Swapped the lamp module.", kind: "qa_feedback" });
  });

  /**
   * The rule this component exists to enforce. Written as its own test rather
   * than as a second assertion on the success case, because those two are the
   * pair that a `reset()` in the wrong place makes indistinguishable.
   */
  it("keeps the typed body when the submit fails", async () => {
    const user = userEvent.setup();
    mockApi({
      "POST /comments": () => ({
        status: 500,
        body: { error: { code: "INTERNAL_ERROR", message: "boom", requestId: "r1" } },
      }),
    });

    renderInProviders(<CommentComposer taskId={42} />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: /add comment/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/^comment/i)).toHaveValue("Swapped the lamp module.");
    });
  });

  it("maps a server VALIDATION_ERROR onto the field it names", async () => {
    const user = userEvent.setup();
    mockApi({
      "POST /comments": () => ({
        status: 422,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid",
            details: { body: ["Comment must be at most 2000 characters"] },
            requestId: "r1",
          },
        },
      }),
    });

    renderInProviders(<CommentComposer taskId={42} />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: /add comment/i }));

    const message = await screen.findByText("Comment must be at most 2000 characters");
    expect(message).toBeInTheDocument();
    // Linked to the control, not merely on screen beside it.
    expect(screen.getByLabelText(/^comment/i)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/^comment/i)).toHaveAccessibleDescription(
      "Comment must be at most 2000 characters",
    );
  });

  /**
   * The `_` case from the stage-8 constraint. `setError("_", …)` is dropped
   * silently by react-hook-form, so without `splitValidationErrors` this is a
   * rejected submit with nothing on screen at all.
   */
  it("puts a detail key that is not a field into the summary instead of losing it", async () => {
    const user = userEvent.setup();
    mockApi({
      "POST /comments": () => ({
        status: 422,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid",
            details: { _: ['Unrecognized key: "nickname"'], taskId: ["Not allowed here"] },
            requestId: "r1",
          },
        },
      }),
    });

    renderInProviders(<CommentComposer taskId={42} />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: /add comment/i }));

    expect(await screen.findByText('Unrecognized key: "nickname"')).toBeInTheDocument();
    expect(screen.getByText("Not allowed here")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("There are 2 problems");
  });

  it("invalidates the task detail and its timeline — and nothing wider — on success", async () => {
    const user = userEvent.setup();
    mockApi({ "POST /comments": () => ({ status: 201, body: makeComment() }) });

    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    renderInProviders(<CommentComposer taskId={42} />, { queryClient });
    await fill(user);
    await user.click(screen.getByRole("button", { name: /add comment/i }));

    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.tasks.detail(42) });
    });
    // Compared against a literal, not against `queryKeys.tasks.detail(42)`
    // again — a key built by the same call the code makes cannot disagree with
    // it, so that assertion could not fail if the hierarchy itself were wrong.
    expect(invalidate.mock.calls[0]?.[0]).toEqual({ queryKey: ["tasks", "detail", 42] });
    expect(invalidate.mock.calls[1]?.[0]).toEqual({ queryKey: ["events", { taskId: 42 }] });
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("disables submit until the body has content", async () => {
    const user = userEvent.setup();
    mockApi({});

    renderInProviders(<CommentComposer taskId={42} />);
    expect(screen.getByRole("button", { name: /add comment/i })).toBeDisabled();

    await user.type(screen.getByLabelText(/^comment/i), "x");
    expect(screen.getByRole("button", { name: /add comment/i })).toBeEnabled();
  });
});
