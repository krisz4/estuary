import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/api/queryKeys";
import { TicketDetailPage } from "@/pages/ticket-detail/TicketDetailPage";
import { makeComment, makeQueryClient, makeTicket, renderRoute, mockApi } from "@/test/harness";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));

const routes = [
  { path: "/tickets/:ticketId", element: <TicketDetailPage /> },
  { path: "/tickets", element: <div>Tickets list</div> },
];

const renderDetail = (options: { queryClient?: ReturnType<typeof makeQueryClient> } = {}) =>
  renderRoute({ routes, initialEntries: ["/tickets/42"], ...options });

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TicketDetailPage — states", () => {
  it("renders the ticket, its comments, and the reference", async () => {
    mockApi({
      "GET /tickets/42": () => ({
        body: makeTicket({ comments: [makeComment({ body: "Lamp swapped." })], commentCount: 1 }),
      }),
    });

    renderDetail();

    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
      "Projector shows no signal",
    );
    expect(screen.getByText("HD-000042")).toBeInTheDocument();
    expect(screen.getByText("Lamp swapped.")).toBeInTheDocument();
  });

  it("shows the resource not-found state for a 404, not a toast", async () => {
    mockApi({
      "GET /tickets/42": () => ({
        status: 404,
        body: {
          error: { code: "TICKET_NOT_FOUND", message: "not found", requestId: "r1" },
        },
      }),
    });

    renderDetail();

    expect(await screen.findByText("This ticket doesn't exist")).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("shows a retryable error panel for a 500", async () => {
    mockApi({
      "GET /tickets/42": () => ({
        status: 500,
        body: { error: { code: "INTERNAL_ERROR", message: "boom", requestId: "r9" } },
      }),
    });

    renderDetail();

    expect(await screen.findByText("Something went wrong on the server")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByText("Request ID: r9")).toBeInTheDocument();
  });

  it("rejects a non-numeric id without issuing a request", async () => {
    const { requests } = mockApi({});
    renderRoute({ routes, initialEntries: ["/tickets/0x2a"] });

    expect(
      await screen.findByText("That address does not contain a valid ticket number."),
    ).toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });
});

describe("TicketDetailPage — description escaping", () => {
  it("renders markup in the description as a text node", async () => {
    mockApi({
      "GET /tickets/42": () => ({
        body: makeTicket({ description: "before <img src=x onerror=alert(1)> after" }),
      }),
    });

    const { container } = renderDetail();

    const paragraph = await screen.findByText(/before <img src=x onerror=alert\(1\)> after/);
    // The assertion that matters is structural: one text node, and no element
    // parsed out of the string anywhere in the tree.
    expect(paragraph.childNodes).toHaveLength(1);
    expect(paragraph.childNodes[0]?.nodeType).toBe(Node.TEXT_NODE);
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("TicketDetailPage — status change", () => {
  it("PATCHes the new status and invalidates the whole tickets tree", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      "GET /tickets/42": () => ({ body: makeTicket() }),
      "PATCH /tickets/42": () => ({ body: makeTicket({ status: "in_progress" }) }),
    });

    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    renderDetail({ queryClient });
    await screen.findByRole("heading", { level: 1 });

    await user.click(screen.getByRole("combobox", { name: /status/i }));
    await user.click(await screen.findByRole("option", { name: "In progress" }));

    await waitFor(() => {
      expect(requests.some((r) => r.method === "PATCH")).toBe(true);
    });
    expect(requests.find((r) => r.method === "PATCH")?.body).toEqual({ status: "in_progress" });

    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["tickets"] });
    });
    expect(queryKeys.tickets.all).toEqual(["tickets"]);
  });

  it("shows the 409's allowed targets inline and rolls the value back", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /tickets/42": () => ({ body: makeTicket({ status: "closed" }) }),
      "PATCH /tickets/42": () => ({
        status: 409,
        body: {
          error: {
            code: "INVALID_STATUS_TRANSITION",
            message: "no",
            details: { from: "closed", to: "resolved", allowed: ["open", "in_progress"] },
            requestId: "r1",
          },
        },
      }),
    });

    renderDetail();
    await screen.findByRole("heading", { level: 1 });

    await user.click(screen.getByRole("combobox", { name: /status/i }));
    await user.click(await screen.findByRole("option", { name: "Resolved" }));

    expect(
      await screen.findByText(
        "Not allowed from here. You can move it to Open or In progress instead.",
      ),
    ).toBeInTheDocument();
    // Rolled back to the stored value rather than left showing the rejected one.
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: /status/i })).toHaveTextContent("Closed");
    });
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("TicketDetailPage — delete", () => {
  it("confirms first, then deletes, toasts, and leaves for the list", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({
      "GET /tickets/42": () => ({
        body: makeTicket({ comments: [makeComment()], commentCount: 1 }),
      }),
      "DELETE /tickets/42": () => ({ status: 204 }),
    });

    renderDetail();
    await screen.findByRole("heading", { level: 1 });

    await user.click(screen.getByRole("button", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleDescription(/This also deletes its 1 comment\./);
    // Nothing has been sent yet — the confirm is a real gate, not decoration.
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Delete ticket" }));

    await waitFor(() => expect(screen.getByText("Tickets list")).toBeInTheDocument());
    expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
    expect(toast.success).toHaveBeenCalledWith("HD-000042 deleted");

    // No GET for the deleted ticket AFTER the DELETE. A `tickets.all`
    // invalidation here refetches the row that was just removed — this page is
    // still mounted when the mutation's own onSuccess runs — and that request
    // is a guaranteed 404. (Confirmed against a production build before it was
    // fixed: DELETE /tickets/65 was followed by GET /tickets/65.)
    const afterDelete = requests.slice(requests.findIndex((r) => r.method === "DELETE") + 1);
    expect(afterDelete.filter((r) => r.method === "GET")).toEqual([]);
  });

  it("sends nothing when the confirm is cancelled", async () => {
    const user = userEvent.setup();
    const { requests } = mockApi({ "GET /tickets/42": () => ({ body: makeTicket() }) });

    renderDetail();
    await screen.findByRole("heading", { level: 1 });

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);
  });
});
