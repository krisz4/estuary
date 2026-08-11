import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { NotFoundPage } from "@/pages/not-found/NotFoundPage";
import { renderRoute } from "@/test/harness";

const render404 = (path: string) =>
  renderRoute({
    routes: [
      { path: "*", element: <NotFoundPage /> },
      { path: "/tickets", element: <div>Tickets list</div> },
    ],
    initialEntries: [path],
  });

describe("NotFoundPage", () => {
  it("announces as words, not a bare number", () => {
    render404("/nope");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Page not found");
  });

  /**
   * The attempted path is the most user-controlled input the app has — it comes
   * straight from the address bar.
   */
  it("renders the attempted path as an escaped text node", () => {
    const { container } = render404("/nope/<img src=x onerror=alert(1)>");

    const code = container.querySelector("code")!;
    expect(code.childNodes).toHaveLength(1);
    expect(code.childNodes[0]?.nodeType).toBe(Node.TEXT_NODE);
    expect(code.textContent).toContain("onerror=alert(1)");
    expect(container.querySelector("img")).toBeNull();
  });

  it("focuses the primary action so a keyboard user can leave in one keystroke", async () => {
    render404("/nope");
    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Back to tickets" })).toHaveFocus();
    });
  });

  /* ---------------------------------------------------------------- *
   * "Go back"
   *
   * The usual way to reach a 404 is a pasted or mistyped URL, which makes it
   * the *first* entry of the session. `navigate(-1)` there either does nothing
   * or leaves the app — the one thing a 404 must not do.
   * ---------------------------------------------------------------- */

  it("omits Go back when the 404 is the first entry (a pasted URL)", () => {
    render404("/nope");
    expect(screen.queryByRole("button", { name: "Go back" })).not.toBeInTheDocument();
  });

  it("offers Go back when an in-app screen is behind it, and returns there", async () => {
    const user = userEvent.setup();

    renderRoute({
      routes: [
        { path: "*", element: <NotFoundPage /> },
        {
          path: "/tickets",
          element: (
            <div>
              Tickets list<Link to="/nope">Broken link</Link>
            </div>
          ),
        },
      ],
      initialEntries: ["/tickets"],
    });

    // Navigate *within* the app, so the 404 is a pushed entry rather than the
    // session's first.
    await user.click(screen.getByRole("link", { name: "Broken link" }));
    await screen.findByRole("heading", { level: 1, name: "Page not found" });

    await user.click(screen.getByRole("button", { name: "Go back" }));
    await waitFor(() => expect(screen.getByText("Tickets list")).toBeInTheDocument());
  });
});
