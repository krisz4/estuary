import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { backToListPath, listReturnState, PageHeader } from "@/components/PageHeader";
import { useTicketViewStore } from "@/stores/ticketView";
import { renderRoute } from "@/test/harness";

/**
 * `location.state` survives a reload inside the browser's history entry and is
 * writable by anyone through `history.pushState`. The back link therefore
 * validates it rather than interpolating it.
 */
describe("backToListPath", () => {
  it("keeps a search string the list would have written", () => {
    expect(backToListPath({ from: "?page=3&status=open" })).toBe("/tickets?page=3&status=open");
  });

  it("adds the missing question mark", () => {
    expect(backToListPath({ from: "page=3" })).toBe("/tickets?page=3");
  });

  it.each([
    ["no state", null],
    ["a string state", "?page=3"],
    ["a non-string from", { from: 5 }],
    ["an empty from", { from: "" }],
    ["a missing from", {}],
  ])("falls back to the bare list for %s", (_label, state) => {
    expect(backToListPath(state)).toBe("/tickets");
  });

  /*
    The view decides the *path*, `state.from` decides the query. The board is a
    second list route, and a ticket opened from it has to come back to it.
  */
  it("returns to the board's route when the board is the remembered view", () => {
    expect(backToListPath({ from: "?priority=urgent" }, "board")).toBe(
      "/tickets/board?priority=urgent",
    );
    expect(backToListPath(null, "board")).toBe("/tickets/board");
  });
});

describe("listReturnState", () => {
  it.each(["/tickets", "/tickets/board"])("carries the current search from %s", (pathname) => {
    expect(listReturnState({ pathname, search: "?q=vpn", state: null })).toEqual({
      from: "?q=vpn",
    });
  });

  it.each(["/tickets", "/tickets/board"])("carries nothing from an unfiltered %s", (pathname) => {
    expect(listReturnState({ pathname, search: "", state: null })).toBeUndefined();
  });

  it("forwards a validated `from` from any other screen", () => {
    expect(
      listReturnState({ pathname: "/tickets/42", search: "", state: { from: "page=3" } }),
    ).toEqual({ from: "?page=3" });
  });

  it("forwards nothing when there is no usable `from`", () => {
    expect(
      listReturnState({ pathname: "/tickets/42", search: "?ignored=1", state: { from: 5 } }),
    ).toBeUndefined();
  });
});

describe("PageHeader", () => {
  it("renders the back link against the carried search string", () => {
    renderRoute({
      routes: [{ path: "/tickets/42", element: <PageHeader eyebrow="HD-000042" title="Hi" /> }],
      initialEntries: [{ pathname: "/tickets/42", state: { from: "?status=open" } }],
    });

    expect(screen.getByRole("link", { name: /back to tickets/i })).toHaveAttribute(
      "href",
      "/tickets?status=open",
    );
  });

  it("points the back link at the board when that is the remembered view", () => {
    useTicketViewStore.getState().setView("board");

    renderRoute({
      routes: [{ path: "/tickets/42", element: <PageHeader eyebrow="HD-000042" title="Hi" /> }],
      initialEntries: [{ pathname: "/tickets/42", state: { from: "?status=open" } }],
    });

    expect(screen.getByRole("link", { name: /back to tickets/i })).toHaveAttribute(
      "href",
      "/tickets/board?status=open",
    );
  });

  it("omits the back link when asked to", () => {
    renderRoute({
      routes: [{ path: "/x", element: <PageHeader title="Hi" showBackLink={false} /> }],
      initialEntries: ["/x"],
    });

    expect(screen.queryByRole("link", { name: /back to tickets/i })).not.toBeInTheDocument();
  });
});
