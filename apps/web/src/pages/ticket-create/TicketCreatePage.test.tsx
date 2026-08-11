import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Outlet, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppHeader } from "@/components/layout/AppHeader";
import { TicketCreatePage } from "@/pages/ticket-create/TicketCreatePage";
import { makeQueryClient, makeTicket, renderRoute, stubFetch } from "@/test/harness";

/** Renders the current URL, so a navigation assertion can name it exactly. */
const LocationProbe = () => {
  const { pathname, search } = useLocation();
  return <span data-testid="location">{`${pathname}${search}`}</span>;
};

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const routes = [
  { path: "/tickets/new", element: <TicketCreatePage /> },
  { path: "/tickets/:ticketId", element: <div>Detail page</div> },
  { path: "/tickets", element: <div>Tickets list</div> },
];

const renderCreate = (queryClient = makeQueryClient()) =>
  renderRoute({ routes, initialEntries: ["/tickets/new"], queryClient });

const fillValid = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByLabelText(/^title/i), "Projector shows no signal");
  await user.type(
    screen.getByLabelText(/^description/i),
    "Swapped the cable and rebooted, still nothing at all.",
  );
  await user.type(screen.getByLabelText(/requester name/i), "Dana Reyes");
  await user.type(screen.getByLabelText(/requester email/i), "Dana.Reyes@Example.COM");
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("TicketCreatePage", () => {
  it("POSTs the contract shape and lands on the new ticket", async () => {
    const user = userEvent.setup();
    const { requests } = stubFetch({
      "POST /tickets": () => ({
        status: 201,
        body: makeTicket({ id: 64, reference: "HD-000064" }),
      }),
    });

    renderCreate();
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Create ticket" }));

    await waitFor(() => expect(screen.getByText("Detail page")).toBeInTheDocument());

    const post = requests.find((r) => r.method === "POST");
    expect(post?.body).toEqual({
      title: "Projector shows no signal",
      description: "Swapped the cable and rebooted, still nothing at all.",
      priority: "medium",
      category: null,
      requesterName: "Dana Reyes",
      requesterEmail: "dana.reyes@example.com",
      assignee: null,
    });
    expect(toast.success).toHaveBeenCalledWith("Ticket HD-000064 created");
  });

  it("invalidates the whole tickets tree so the list picks the new row up", async () => {
    const user = userEvent.setup();
    stubFetch({ "POST /tickets": () => ({ status: 201, body: makeTicket({ id: 64 }) }) });

    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    renderCreate(queryClient);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Create ticket" }));

    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["tickets"] });
    });
  });

  it("keeps every typed value when the server rejects the payload", async () => {
    const user = userEvent.setup();
    stubFetch({
      "POST /tickets": () => ({
        status: 422,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid",
            details: { requesterEmail: ["Enter a valid email address"] },
            requestId: "r1",
          },
        },
      }),
    });

    renderCreate();
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Create ticket" }));

    expect(await screen.findByText("Enter a valid email address")).toBeInTheDocument();
    expect(screen.getByLabelText(/^title/i)).toHaveValue("Projector shows no signal");
    // A 422 is already on screen; a toast on top of it would be noise.
    expect(toast.error).not.toHaveBeenCalled();
  });

  /**
   * The documented promise is that focus moves to the invalid field. `setError`
   * cannot keep it: `shouldFocus` calls `.focus()` on a **registered input
   * ref**, and `category` is a Radix Select driven by `setValue` with no ref at
   * all — so this exact payload used to consume the flag on `category`, focus
   * nothing, and leave `requesterEmail` past `isFirst`. Focus landed nowhere.
   *
   * Asserting the messages render cannot see this; only `document.activeElement`
   * can.
   */
  it("focuses the topmost invalid control after a 422, including a select", async () => {
    const user = userEvent.setup();
    stubFetch({
      "POST /tickets": () => ({
        status: 422,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid",
            details: {
              // Server order is deliberately the reverse of form order.
              requesterEmail: ["Enter a valid email address"],
              category: ["Not a known category"],
            },
            requestId: "r1",
          },
        },
      }),
    });

    renderCreate();
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Create ticket" }));

    expect(await screen.findByText("Not a known category")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("combobox", { name: /^category/i })).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });

  /**
   * A `details` key this form does not render — `_`, or a field added API-side —
   * goes to the summary, so there is no invalid control to focus. Focus must
   * still move somewhere the message is readable.
   */
  it("focuses the error summary when the rejection names no rendered field", async () => {
    const user = userEvent.setup();
    stubFetch({
      "POST /tickets": () => ({
        status: 422,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid",
            details: { _: ['Unrecognized key: "id"'] },
            requestId: "r1",
          },
        },
      }),
    });

    renderCreate();
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Create ticket" }));

    const summary = await screen.findByText('Unrecognized key: "id"');
    await waitFor(() => {
      expect(document.activeElement).toHaveAttribute("aria-live", "assertive");
    });
    expect(document.activeElement?.contains(summary)).toBe(true);
  });

  it("toasts for a failure that has no field to land on", async () => {
    const user = userEvent.setup();
    stubFetch({
      "POST /tickets": () => ({
        status: 500,
        body: { error: { code: "INTERNAL_ERROR", message: "boom", requestId: "r1" } },
      }),
    });

    renderCreate();
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Create ticket" }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Something went wrong on the server", {
        description: "This is not your fault. Try again in a moment.",
      });
    });
    expect(screen.getByLabelText(/^title/i)).toHaveValue("Projector shows no signal");
    // Nothing was marked invalid and the summary is empty, so the focus pass
    // must leave the user where they were rather than on an empty region.
    expect(screen.getByRole("button", { name: "Create ticket" })).toHaveFocus();
  });

  it("leaves immediately when Cancel is pressed on an untouched form", async () => {
    const user = userEvent.setup();
    stubFetch({});

    renderCreate();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.getByText("Tickets list")).toBeInTheDocument());
  });

  /**
   * `backToListPath(location.state)` is only reachable if something attaches
   * that state, and the header — not the list page — is how most users get
   * here. With no `state` on those links the create page always cancelled to a
   * bare `/tickets`, dropping every filter, while the code that would have
   * restored them sat there looking correct.
   */
  it("cancels back to the filtered list it was opened from", async () => {
    const user = userEvent.setup();
    stubFetch({});

    renderRoute({
      routes: [
        {
          element: (
            <div>
              <AppHeader />
              <LocationProbe />
              <Outlet />
            </div>
          ),
          children: [
            { path: "/tickets", element: <div>Tickets list</div> },
            { path: "/tickets/new", element: <TicketCreatePage /> },
          ],
        },
      ],
      initialEntries: ["/tickets?status=open&page=2"],
    });

    // Two "New ticket" links exist by design (icon-only below `sm`, labelled
    // above); both must carry the state, so assert on both and use the first.
    const newTicketLinks = screen.getAllByRole("link", { name: "New ticket" });
    expect(newTicketLinks).toHaveLength(2);

    await user.click(newTicketLinks[0]!);
    await screen.findByRole("button", { name: "Create ticket" });

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.getByText("Tickets list")).toBeInTheDocument());
    expect(screen.getByTestId("location")).toHaveTextContent("/tickets?status=open&page=2");
  });

  it("confirms before discarding a dirty form", async () => {
    const user = userEvent.setup();
    stubFetch({});

    renderCreate();
    await user.type(screen.getByLabelText(/^title/i), "Half a thought");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("Discard this ticket?");
    expect(screen.queryByText("Tickets list")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByLabelText(/^title/i)).toHaveValue("Half a thought");
  });
});
