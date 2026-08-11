import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/api/queryKeys";
import { CommentThread } from "@/features/comments/CommentThread";
import { makeComment, makeQueryClient, renderInProviders, stubFetch } from "@/test/harness";

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
    stubFetch({});
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
    stubFetch({});
    const { container } = renderInProviders(
      <CommentThread ticketId={42} comments={[makeComment({ body: "<b>bold</b>" })]} />,
    );

    expect(screen.getByText("<b>bold</b>")).toBeInTheDocument();
    expect(container.querySelector("b")).toBeNull();
  });

  it("shows the empty line when there is nothing yet", () => {
    stubFetch({});
    renderInProviders(<CommentThread ticketId={42} comments={[]} />);
    expect(screen.getByText("No comments yet.")).toBeInTheDocument();
  });

  it("labels each delete button with its author", () => {
    stubFetch({});
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
    const { requests } = stubFetch({
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
});
