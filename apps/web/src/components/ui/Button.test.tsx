import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui";

/**
 * A thin smoke test over the primitive every other component builds on. Its
 * second job is to exercise the jsdom + Testing Library wiring itself, so
 * stage 13 starts from a harness that is known to work rather than discovering
 * a missing `setupFiles` entry halfway through writing MSW handlers.
 */
describe("Button", () => {
  it("defaults to type=button so it cannot submit a form by accident", () => {
    render(<Button>Filter</Button>);
    expect(screen.getByRole("button", { name: "Filter" })).toHaveAttribute("type", "button");
  });

  it("still allows an explicit submit", () => {
    render(<Button type="submit">Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("type", "submit");
  });

  it("is disabled and aria-busy while loading, and does not fire onClick", async () => {
    const onClick = vi.fn();
    render(
      <Button isLoading onClick={onClick}>
        Save
      </Button>,
    );

    const button = screen.getByRole("button", { name: /save/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");

    await userEvent.click(button, { pointerEventsCheck: 0 });
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders as its child with asChild, so a link is an <a> and not a nested button", () => {
    // Nesting an <a> inside a <button> is invalid HTML and breaks middle-click
    // and "open in new tab" — which the design guidelines call out for row links.
    render(
      <Button asChild>
        <a href="/tickets/new">New ticket</a>
      </Button>,
    );

    const link = screen.getByRole("link", { name: "New ticket" });
    expect(link.tagName).toBe("A");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("lets a caller's className win over the variant's own utilities", () => {
    // This is what `cn()`'s twMerge pass buys: without it both classes are
    // emitted and stylesheet order decides, which makes the className prop
    // unreliable.
    render(<Button className="px-8">Wide</Button>);
    const button = screen.getByRole("button", { name: "Wide" });
    expect(button.className).toContain("px-8");
    expect(button.className).not.toContain("px-4");
  });
});
