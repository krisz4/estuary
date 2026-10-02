import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { backToListPath, listReturnState, PageHeader } from "@/components/PageHeader";
import { useTaskViewStore } from "@/stores/taskView";
import { renderRoute } from "@/test/harness";

/**
 * `location.state` survives a reload inside the browser's history entry and is
 * writable by anyone through `history.pushState`. The back link therefore
 * validates it rather than interpolating it.
 */
describe("backToListPath", () => {
  it("keeps a search string the list would have written", () => {
    expect(backToListPath({ from: "?page=3&status=open" })).toBe("/tasks?page=3&status=open");
  });

  it("adds the missing question mark", () => {
    expect(backToListPath({ from: "page=3" })).toBe("/tasks?page=3");
  });

  it.each([
    ["no state", null],
    ["a string state", "?page=3"],
    ["a non-string from", { from: 5 }],
    ["an empty from", { from: "" }],
    ["a missing from", {}],
  ])("falls back to the bare list for %s", (_label, state) => {
    expect(backToListPath(state)).toBe("/tasks");
  });

  /*
    The view decides the *path*, `state.from` decides the query. The map is a
    second list route, and a task opened from it has to come back to it.
  */
  it("returns to the map's route when the map is the remembered view", () => {
    expect(backToListPath({ from: "?priority=urgent" }, "map")).toBe("/tasks/map?priority=urgent");
    expect(backToListPath(null, "map")).toBe("/tasks/map");
  });
});

describe("listReturnState", () => {
  it.each(["/tasks", "/tasks/map"])("carries the current search from %s", (pathname) => {
    expect(listReturnState({ pathname, search: "?q=vpn", state: null })).toEqual({
      from: "?q=vpn",
    });
  });

  it.each(["/tasks", "/tasks/map"])("carries nothing from an unfiltered %s", (pathname) => {
    expect(listReturnState({ pathname, search: "", state: null })).toBeUndefined();
  });

  it("forwards a validated `from` from any other screen", () => {
    expect(
      listReturnState({ pathname: "/tasks/42", search: "", state: { from: "page=3" } }),
    ).toEqual({ from: "?page=3" });
  });

  it("forwards nothing when there is no usable `from`", () => {
    expect(
      listReturnState({ pathname: "/tasks/42", search: "?ignored=1", state: { from: 5 } }),
    ).toBeUndefined();
  });
});

describe("PageHeader", () => {
  it("renders the back link against the carried search string", () => {
    renderRoute({
      routes: [{ path: "/tasks/42", element: <PageHeader eyebrow="TASK-000042" title="Hi" /> }],
      initialEntries: [{ pathname: "/tasks/42", state: { from: "?status=open" } }],
    });

    expect(screen.getByRole("link", { name: /back to tasks/i })).toHaveAttribute(
      "href",
      "/tasks?status=open",
    );
  });

  it("points the back link at the map when that is the remembered view", () => {
    useTaskViewStore.getState().setView("map");

    renderRoute({
      routes: [{ path: "/tasks/42", element: <PageHeader eyebrow="TASK-000042" title="Hi" /> }],
      initialEntries: [{ pathname: "/tasks/42", state: { from: "?status=open" } }],
    });

    expect(screen.getByRole("link", { name: /back to tasks/i })).toHaveAttribute(
      "href",
      "/tasks/map?status=open",
    );
  });

  it("omits the back link when asked to", () => {
    renderRoute({
      routes: [{ path: "/x", element: <PageHeader title="Hi" showBackLink={false} /> }],
      initialEntries: ["/x"],
    });

    expect(screen.queryByRole("link", { name: /back to tasks/i })).not.toBeInTheDocument();
  });
});
