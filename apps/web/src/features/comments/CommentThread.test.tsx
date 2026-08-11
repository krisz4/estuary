import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/api/queryKeys";
import { CommentThread } from "@/features/comments/CommentThread";
import { makeComment, makeQueryClient, renderInProviders, mockApi } from "@/test/harness";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

const comments = [
  makeComment({ id: 1, authorName: "Priya Nair", body: "First." }),
  makeComment({ id: 2, authorName: "Marcus Feld", body: "Second." }),
];

describe("CommentThread", () => {
  it("keeps the server's order rather than re-sorting", () => {
    mockApi({});
    renderInProviders(<CommentThread ticketId={42} comments={comments} />);

    const items = within(screen.getByRole("list", { name: "Comment thread" })).getAllByRole(
      "listitem",
    );
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("First."),
      expect.stringContaining("Second."),
    ]);
  });

  it("renders markup in a body as text", () => {
    mockApi({});
    const { container } = renderInProviders(
      <CommentThread ticketId={42} comments={[makeComment({ body: "<b>bold</b>" })]} />,
    );

    expect(screen.getByText("<b>bold</b>")).toBeInTheDocument();
    expect(container.querySelector("b")).toBeNull();
  });

  it("shows the empty line when there is nothing yet", () => {
    mockApi({});
    renderInProviders(<CommentThread ticketId={42} comments={[]} />);
    expect(screen.getByText("No comments yet.")).toBeInTheDocument();
  });

  it("labels each delete button with its author", () => {
    mockApi({});
    renderInProviders(<CommentThread ticketId={42} comments={comments} />);

    expect(
      screen.getByRole("button", { name: "Delete comment by Priya Nair" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete comment by Marcus Feld" }),
    ).toBeInTheDocument();
  });

  it("confirms, deletes, and invalidates only the detail key", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      "DELETE /comments/1": () => ({ status: 204 }),
    });

    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    renderInProviders(<CommentThread ticketId={42} comments={comments} />, { queryClient });

    await user.click(screen.getByRole("button", { name: "Delete comment by Priya Nair" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleDescription(/The comment by Priya Nair will be removed\./);
    expect(requests).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Delete comment" }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.url.pathname).toMatch(/\/tickets\/42\/comments\/1$/);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["tickets", "detail", 42] });
    expect(queryKeys.tickets.detail(42)).toEqual(["tickets", "detail", 42]);
    expect(toast.success).toHaveBeenCalledWith("Comment deleted");
  });

  /**
   * A failed delete leaves the thread on screen known to be wrong, and for the
   * likeliest failure it is *guaranteed* wrong: `COMMENT_NOT_FOUND` means the
   * comment was already removed in another tab. Toasting and stopping there
   * leaves the stale row sitting in the list, and every retry reproduces the
   * same 404 — the user has no way to make the screen agree with the server
   * short of a manual reload.
   */
  it("refetches the thread when the delete fails, so a stale row cannot persist", async () => {
    const user = userEvent.setup();
    mockApi({
      "DELETE /comments/1": () => ({
        status: 404,
        body: {
          error: { code: "COMMENT_NOT_FOUND", message: "gone", requestId: "r1" },
        },
      }),
    });

    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    renderInProviders(<CommentThread ticketId={42} comments={comments} />, { queryClient });

    await user.click(screen.getByRole("button", { name: "Delete comment by Priya Nair" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete comment" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.tickets.detail(42) });
    expect(queryKeys.tickets.detail(42)).toEqual(["tickets", "detail", 42]);
    // The dialog still closes — the action is over, it just did not succeed.
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
