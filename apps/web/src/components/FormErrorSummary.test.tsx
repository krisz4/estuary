import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FormErrorSummary } from "@/components/FormErrorSummary";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FormErrorSummary", () => {
  it("stays mounted with nothing to say, so the live region pre-exists its content", () => {
    const { container } = render(<FormErrorSummary messages={[]} />);

    // A region that appears at the same moment its content does is frequently
    // not announced — assistive technology has to be observing the node before
    // it changes.
    const region = container.querySelector('[aria-live="assertive"]');
    expect(region).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("counts the problems in the heading, singular and plural", () => {
    const { rerender } = render(<FormErrorSummary messages={["Only one"]} />);
    expect(screen.getByText("There is a problem")).toBeInTheDocument();

    rerender(<FormErrorSummary messages={["One", "Two"]} />);
    expect(screen.getByText("There are 2 problems")).toBeInTheDocument();
  });

  /**
   * `splitValidationErrors` flattens every unrecognised `details` key into one
   * flat array of messages, discarding which key produced each. Two fields
   * rejected identically therefore arrive as two *equal strings* — and
   * `updateTicketInputSchema` produces exactly that for a payload carrying both
   * server-owned timestamps, since it rejects each with the same text.
   *
   * Keyed by message, React sees one key twice: a development warning, and a
   * reconciliation that is free to drop or reuse the wrong node. Keyed by index
   * — safe here, because the list is rebuilt from scratch on every submit and is
   * never reordered or filtered — both render.
   */
  it("renders duplicate messages without a duplicate-key warning", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <FormErrorSummary messages={["Not accepted from a client", "Not accepted from a client"]} />,
    );

    const items = within(screen.getByRole("alert")).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.textContent)).toEqual([
      "Not accepted from a client",
      "Not accepted from a client",
    ]);

    const warnings = consoleError.mock.calls.filter((call) => String(call[0]).includes("same key"));
    expect(warnings, `React warned: ${JSON.stringify(warnings)}`).toEqual([]);
  });
});
