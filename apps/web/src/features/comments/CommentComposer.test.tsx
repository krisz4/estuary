import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/api/queryKeys";
import { CommentComposer } from "@/features/comments/CommentComposer";
import { makeComment, makeQueryClient, renderInProviders, stubFetch } from "@/test/harness";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const fill = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByLabelText(/your name/i), "Priya Nair");
  await user.type(screen.getByLabelText(/^comment/i), "Swapped the lamp module.");
};

describe("CommentComposer", () => {
  it("clears the body on success and keeps the author name", async () => {
    const user = userEvent.setup();
    stubFetch({ "POST /comments": () => ({ status: 201, body: makeComment() }) });

    renderInProviders(<CommentComposer ticketId={42} />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: /add comment/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/^comment/i)).toHaveValue("");
    });
    expect(screen.getByLabelText(/your name/i)).toHaveValue("Priya Nair");
  });

  /**
   * The rule this component exists to enforce. Written as its own test rather
   * than as a second assertion on the success case, because those two are the
   * pair that a `reset()` in the wrong place makes indistinguishable.
   */
  it("keeps the typed body when the submit fails", async () => {
    const user = userEvent.setup();
    stubFetch({
      "POST /comments": () => ({
        status: 500,
        body: { error: { code: "INTERNAL_ERROR", message: "boom", requestId: "r1" } },
      }),
    });

    renderInProviders(<CommentComposer ticketId={42} />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: /add comment/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/^comment/i)).toHaveValue("Swapped the lamp module.");
    });
    expect(screen.getByLabelText(/your name/i)).toHaveValue("Priya Nair");
  });

  it("maps a server VALIDATION_ERROR onto the field it names", async () => {
    const user = userEvent.setup();
    stubFetch({
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

    renderInProviders(<CommentComposer ticketId={42} />);
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
    stubFetch({
      "POST /comments": () => ({
        status: 422,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid",
            details: { _: ['Unrecognized key: "nickname"'], ticketId: ["Not allowed here"] },
            requestId: "r1",
          },
        },
      }),
    });

    renderInProviders(<CommentComposer ticketId={42} />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: /add comment/i }));

    expect(await screen.findByText('Unrecognized key: "nickname"')).toBeInTheDocument();
    expect(screen.getByText("Not allowed here")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("There are 2 problems");
  });

  it("invalidates the ticket detail key — and only that key — on success", async () => {
    const user = userEvent.setup();
    stubFetch({ "POST /comments": () => ({ status: 201, body: makeComment() }) });

    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    renderInProviders(<CommentComposer ticketId={42} />, { queryClient });
    await fill(user);
    await user.click(screen.getByRole("button", { name: /add comment/i }));

    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.tickets.detail(42) });
    });
    // Compared against a literal, not against `queryKeys.tickets.detail(42)`
    // again — a key built by the same call the code makes cannot disagree with
    // it, so that assertion could not fail if the hierarchy itself were wrong.
    expect(invalidate.mock.calls[0]?.[0]).toEqual({ queryKey: ["tickets", "detail", 42] });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("disables submit until the body has content", async () => {
    const user = userEvent.setup();
    stubFetch({});

    renderInProviders(<CommentComposer ticketId={42} />);
    expect(screen.getByRole("button", { name: /add comment/i })).toBeDisabled();

    await user.type(screen.getByLabelText(/^comment/i), "x");
    expect(screen.getByRole("button", { name: /add comment/i })).toBeEnabled();
  });
});
