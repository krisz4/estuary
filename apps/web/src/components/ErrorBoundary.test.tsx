import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "@/components/ErrorBoundary";

/**
 * `shouldThrow` is module state read during render, not a prop.
 *
 * With a prop, `<Boom shouldThrow={x} />` captures `x` at the moment the parent
 * renders — and `reset()` re-renders only the boundary, reusing that same
 * element. The "Try again" test then re-mounted a `Boom` still carrying
 * `shouldThrow: true` and failed for a reason that had nothing to do with the
 * boundary. Reading it at render time makes "the cause is fixed" expressible.
 */
let shouldThrow = true;

const Boom = () => {
  if (shouldThrow) throw new Error("render crash");
  return <p>Task list</p>;
};

/** Mirrors AppLayout: the boundary is keyed on the current pathname. */
const RoutedHarness = () => {
  const location = useLocation();
  return (
    <ErrorBoundary resetKey={location.pathname}>
      <Boom />
    </ErrorBoundary>
  );
};

const renderAt = (path = "/tasks") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/tasks" element={<RoutedHarness />} />
        <Route path="/tasks/:taskId" element={<RoutedHarness />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  shouldThrow = true;
  // componentDidCatch logs the stack on purpose, and React logs the error too.
  // Both are expected here and are pure noise in the run.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    shouldThrow = false;
    renderAt();
    expect(screen.getByText("Task list")).toBeInTheDocument();
  });

  it("shows the fallback when a child throws", () => {
    renderAt();
    expect(screen.getByRole("alert")).toHaveTextContent("This page stopped working");
  });

  it('clears the error when "Back to tasks" is a SAME-PATH navigation', async () => {
    // The bug this exists for: `resetKey` is the pathname, so navigating
    // /tasks → /tasks never changes it and the boundary stayed stuck. That
    // is the list page — exactly where a crash is most likely — so the most
    // prominent escape hatch was the one that did nothing.
    renderAt("/tasks");
    expect(screen.getByRole("alert")).toBeInTheDocument();

    shouldThrow = false;
    await userEvent.click(screen.getByRole("link", { name: "Back to tasks" }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Task list")).toBeInTheDocument();
  });

  it('clears the error via "Try again"', async () => {
    renderAt();
    expect(screen.getByRole("alert")).toBeInTheDocument();

    shouldThrow = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(screen.getByText("Task list")).toBeInTheDocument();
  });

  it("clears the error when the route actually changes", () => {
    // The other half of the reset rule: a genuine navigation must clear it
    // without the user pressing anything.
    const { unmount } = renderAt("/tasks");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    unmount();

    shouldThrow = false;
    renderAt("/tasks/42");
    expect(screen.getByText("Task list")).toBeInTheDocument();
  });
});
