import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { backToListPath, PageHeader } from "@/components/PageHeader";
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

  it("omits the back link when asked to", () => {
    renderRoute({
      routes: [{ path: "/x", element: <PageHeader title="Hi" showBackLink={false} /> }],
      initialEntries: ["/x"],
    });

    expect(screen.queryByRole("link", { name: /back to tickets/i })).not.toBeInTheDocument();
  });
});
