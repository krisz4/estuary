import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/api/queryKeys";
import { diffTicketPatch, TicketEditPage, toFormValues } from "@/pages/ticket-edit/TicketEditPage";
import { makeQueryClient, makeTicket, renderRoute, stubFetch } from "@/test/harness";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const routes = [
  { path: "/tickets/:ticketId/edit", element: <TicketEditPage /> },
  { path: "/tickets/:ticketId", element: <div>Detail page</div> },
  { path: "/tickets", element: <div>Tickets list</div> },
];

const renderEdit = (queryClient = makeQueryClient()) =>
  renderRoute({ routes, initialEntries: ["/tickets/42/edit"], queryClient });

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

/* ------------------------------------------------------------------ *
 * The diff, as a unit
 * ------------------------------------------------------------------ */

describe("diffTicketPatch", () => {
  const ticket = makeTicket({ assignee: "Marcus Feld", category: "hardware" });

  it("is empty when nothing moved", () => {
    // Comparing the schema's *output* for the untouched ticket, which is what
    // the form hands in — not the raw control values.
    expect(
      diffTicketPatch(
        {
          title: ticket.title,
          description: ticket.description,
          status: ticket.status,
          priority: ticket.priority,
          category: ticket.category,
          requesterName: ticket.requesterName,
          requesterEmail: ticket.requesterEmail,
          assignee: ticket.assignee,
        },
        ticket,
      ),
    ).toEqual({});
  });

  it("carries only the changed keys", () => {
    expect(diffTicketPatch({ title: "New title", priority: ticket.priority }, ticket)).toEqual({
      title: "New title",
    });
  });

  it("sends null — not an empty string — for a cleared optional", () => {
    expect(diffTicketPatch({ assignee: null, category: null }, ticket)).toEqual({
      assignee: null,
      category: null,
    });
  });

  it("does not treat null === null as a change", () => {
    const unassigned = makeTicket({ assignee: null });
    expect(diffTicketPatch({ assignee: null }, unassigned)).toEqual({});
  });
});

describe("toFormValues", () => {
  it("maps a null optional to the empty string the controls hold", () => {
    expect(toFormValues(makeTicket({ assignee: null, category: null }))).toMatchObject({
      assignee: "",
      category: "",
    });
  });
});

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

describe("TicketEditPage", () => {
  it("prefills from the loaded ticket", async () => {
    stubFetch({ "GET /tickets/42": () => ({ body: makeTicket() }) });
    renderEdit();

    await waitFor(() =>
      expect(screen.getByLabelText(/^title/i)).toHaveValue("Projector shows no signal"),
    );
    expect(screen.getByLabelText(/assignee/i)).toHaveValue("Marcus Feld");
  });

  it("PATCHes only the fields that changed", async () => {
    const user = userEvent.setup();
    const { requests } = stubFetch({
      "GET /tickets/42": () => ({ body: makeTicket() }),
      "PATCH /tickets/42": () => ({ body: makeTicket({ title: "Projector is dead" }) }),
    });

    renderEdit();
    await screen.findByDisplayValue("Projector shows no signal");

    await user.clear(screen.getByLabelText(/^title/i));
    await user.type(screen.getByLabelText(/^title/i), "Projector is dead");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(requests.some((r) => r.method === "PATCH")).toBe(true));
    expect(requests.find((r) => r.method === "PATCH")?.body).toEqual({
      title: "Projector is dead",
    });
    expect(toast.success).toHaveBeenCalledWith("Changes saved");
  });

  /**
   * The diff exists to stop a save from clobbering a field the user never
   * touched. It can only do that if it compares against the ticket the form was
   * **initialised from** — react-hook-form reads `defaultValues` once, so a
   * refetch that lands after mount moves only one side of the comparison.
   *
   * Here the form mounts with `assignee: null` (so the control holds `""`) and
   * somebody else assigns the ticket while the user is typing a title. Diffing
   * against live query data sees `"" → null` against `"Marcus Feld"` and PATCHes
   * `assignee: null`, silently undoing their edit.
   */
  it("does not PATCH a field the user never touched after a concurrent change lands", async () => {
    const user = userEvent.setup();
    const queryClient = makeQueryClient();
    const { requests } = stubFetch({
      "GET /tickets/42": () => ({ body: makeTicket({ assignee: null }) }),
      "PATCH /tickets/42": () => ({ body: makeTicket({ title: "Projector is dead" }) }),
    });

    renderEdit(queryClient);
    await screen.findByDisplayValue("Projector shows no signal");
    expect(screen.getByLabelText(/assignee/i)).toHaveValue("");

    // Somebody else assigns it. This is what a refetch returning a changed row
    // does to the cache; writing it directly makes the race deterministic.
    act(() => {
      queryClient.setQueryData(
        queryKeys.tickets.detail(42),
        makeTicket({ assignee: "Marcus Feld" }),
      );
    });

    // The form still shows what it mounted with — that is the whole problem.
    expect(screen.getByLabelText(/assignee/i)).toHaveValue("");

    await user.clear(screen.getByLabelText(/^title/i));
    await user.type(screen.getByLabelText(/^title/i), "Projector is dead");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(requests.some((r) => r.method === "PATCH")).toBe(true));
    const patch = requests.find((r) => r.method === "PATCH")?.body as Record<string, unknown>;
    expect(patch).toEqual({ title: "Projector is dead" });
    expect(Object.keys(patch)).not.toContain("assignee");
  });

  it("clears an assignee to null rather than an empty string", async () => {
    const user = userEvent.setup();
    const { requests } = stubFetch({
      "GET /tickets/42": () => ({ body: makeTicket() }),
      "PATCH /tickets/42": () => ({ body: makeTicket({ assignee: null }) }),
    });

    renderEdit();
    await waitFor(() => expect(screen.getByLabelText(/assignee/i)).toHaveValue("Marcus Feld"));

    await user.clear(screen.getByLabelText(/assignee/i));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(requests.some((r) => r.method === "PATCH")).toBe(true));
    expect(requests.find((r) => r.method === "PATCH")?.body).toEqual({ assignee: null });
  });

  it("short-circuits an unchanged save without calling the API", async () => {
    const user = userEvent.setup();
    const { requests } = stubFetch({ "GET /tickets/42": () => ({ body: makeTicket() }) });

    renderEdit();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(toast.info).toHaveBeenCalledWith("No changes to save"));
    expect(requests.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("puts a 409 on the status field and keeps the other edits", async () => {
    const user = userEvent.setup();
    stubFetch({
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

    renderEdit();
    await screen.findByDisplayValue("Projector shows no signal");

    await user.type(screen.getByLabelText(/assignee/i), " Jr");
    await user.click(screen.getByRole("combobox", { name: /^status/i }));
    await user.click(await screen.findByRole("option", { name: "Resolved" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText(
        "Not allowed from here. You can move it to Open or In progress instead.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/assignee/i)).toHaveValue("Marcus Feld Jr");
    expect(toast.error).not.toHaveBeenCalled();
  });

  /**
   * The selects are driven by `setValue` and never `register()`ed, so nothing
   * re-runs validation for them unless `setValue` is asked to. Without
   * `shouldValidate`, the 409 message stayed under a status the user had
   * already corrected until the next submit.
   */
  it("clears the 409 message when the user picks a different status", async () => {
    const user = userEvent.setup();
    stubFetch({
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

    renderEdit();
    await screen.findByDisplayValue("Projector shows no signal");

    await user.click(screen.getByRole("combobox", { name: /^status/i }));
    await user.click(await screen.findByRole("option", { name: "Resolved" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const message = await screen.findByText(
      "Not allowed from here. You can move it to Open or In progress instead.",
    );
    expect(message).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: /^status/i }));
    await user.click(await screen.findByRole("option", { name: "Open" }));

    await waitFor(() =>
      expect(
        screen.queryByText(
          "Not allowed from here. You can move it to Open or In progress instead.",
        ),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("combobox", { name: /^status/i })).not.toHaveAttribute("aria-invalid");
  });

  /**
   * `setError`'s `shouldFocus` is a no-op for the selects — they have no
   * registered input ref — so a 409 on `status` used to move focus nowhere at
   * all. The form focuses the first rendered `aria-invalid` instead, which the
   * Radix trigger (a `button`) satisfies.
   */
  it("moves focus to the status control after a 409", async () => {
    const user = userEvent.setup();
    stubFetch({
      "GET /tickets/42": () => ({ body: makeTicket({ status: "closed" }) }),
      "PATCH /tickets/42": () => ({
        status: 409,
        body: {
          error: {
            code: "INVALID_STATUS_TRANSITION",
            message: "no",
            details: { from: "closed", to: "resolved", allowed: ["open"] },
            requestId: "r1",
          },
        },
      }),
    });

    renderEdit();
    await screen.findByDisplayValue("Projector shows no signal");

    await user.click(screen.getByRole("combobox", { name: /^status/i }));
    await user.click(await screen.findByRole("option", { name: "Resolved" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(screen.getByRole("combobox", { name: /^status/i })).toHaveFocus());
  });

  it("shows the not-found state for a ticket deleted elsewhere", async () => {
    stubFetch({
      "GET /tickets/42": () => ({
        status: 404,
        body: { error: { code: "TICKET_NOT_FOUND", message: "gone", requestId: "r1" } },
      }),
    });

    renderEdit();
    expect(await screen.findByText("This ticket doesn't exist")).toBeInTheDocument();
  });
});
