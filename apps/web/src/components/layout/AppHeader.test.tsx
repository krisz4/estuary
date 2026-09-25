import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppLayout } from "@/components/layout/AppLayout";
import { makeStats, mockApi, renderRoute } from "@/test/harness";
import { useSessionStore } from "@/stores/session";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

/**
 * The shell: the inbox link and its badge, the "You" control, and the 401
 * banner. Rendered through `AppLayout` so the session dialog — mounted once,
 * there — is the real one.
 */

const renderShell = () =>
  renderRoute({
    routes: [
      {
        element: <AppLayout />,
        children: [
          { path: "/tasks", element: <p>Tasks page</p> },
          { path: "/inbox", element: <p>Inbox page</p> },
        ],
      },
    ],
    initialEntries: ["/tasks"],
  });

describe("AppHeader — inbox", () => {
  it("badges the inbox link with the number of tasks waiting on a human", async () => {
    mockApi({ "GET /tasks/stats": () => ({ body: makeStats({ needsAttention: 3 }) }) });

    renderShell();

    const link = await screen.findByRole("link", { name: "Inbox, 3 waiting on you" });
    expect(link).toHaveAttribute("href", "/inbox");
    expect(link).toHaveTextContent("3");
  });

  it("shows no badge when nothing is waiting", async () => {
    const { requests } = mockApi({ "GET /tasks/stats": () => ({ body: makeStats() }) });

    renderShell();

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(screen.getByRole("link", { name: "Inbox" })).not.toHaveTextContent(/\d/);
  });

  it("keeps working when the stats request fails", async () => {
    mockApi({
      "GET /tasks/stats": () => ({
        status: 500,
        body: { error: { code: "INTERNAL_ERROR", message: "x", requestId: "r" } },
      }),
    });

    renderShell();

    expect(await screen.findByRole("link", { name: "Inbox" })).toBeInTheDocument();
  });
});

describe("AppHeader — You", () => {
  it("opens the session dialog and saves a display name", async () => {
    const user = userEvent.setup();
    mockApi({ "GET /tasks/stats": () => ({ body: makeStats() }) });

    renderShell();

    // Two buttons by design (icon-only below `sm`, labelled above); both open it.
    const [iconButton] = screen.getAllByRole("button", { name: /^You: anonymous/ });
    await user.click(iconButton!);

    const dialog = await screen.findByRole("dialog", { name: "You" });
    await user.type(within(dialog).getByLabelText("Your name"), "Krisz Tian");
    expect(
      within(dialog).getByText("Your changes are recorded as human:krisz-tian."),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useSessionStore.getState().displayName).toBe("Krisz Tian");
    expect(screen.getAllByRole("button", { name: /^You: krisz-tian/ }).length).toBeGreaterThan(0);
  });

  it("does not save a dismissed draft", async () => {
    const user = userEvent.setup();
    mockApi({ "GET /tasks/stats": () => ({ body: makeStats() }) });

    renderShell();

    await user.click(screen.getAllByRole("button", { name: /^You:/ })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "You" });
    await user.type(within(dialog).getByLabelText("Your name"), "Half");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useSessionStore.getState().displayName).toBe("");
  });
});

describe("the 401 prompt", () => {
  it("points at the session dialog after an UNAUTHORIZED, and clears once a token is saved", async () => {
    const user = userEvent.setup();
    let authorized = false;
    mockApi({
      "GET /tasks/stats": ({ url: _url }) =>
        authorized
          ? { body: makeStats() }
          : {
              status: 401,
              body: { error: { code: "UNAUTHORIZED", message: "x", requestId: "r" } },
            },
    });

    renderShell();

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("This server needs an API token.");

    await user.click(within(banner).getByRole("button", { name: "Set API token" }));
    const dialog = await screen.findByRole("dialog", { name: "You" });
    await user.type(within(dialog).getByLabelText("API token"), "s3cret");

    authorized = true;
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByText(/needs an API token/)).not.toBeInTheDocument());
    expect(useSessionStore.getState().apiToken).toBe("s3cret");
  });
});
