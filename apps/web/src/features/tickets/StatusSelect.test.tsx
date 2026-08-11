import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "@/api/http";
import { StatusSelect } from "@/features/tickets/StatusSelect";
import { renderInProviders } from "@/test/harness";

afterEach(() => {
  vi.clearAllMocks();
});

const transitionError = (allowed: unknown) =>
  new ApiClientError({
    code: "INVALID_STATUS_TRANSITION",
    message: "Cannot move from closed to resolved",
    details: { from: "closed", to: "resolved", allowed },
    status: 409,
  });

describe("StatusSelect", () => {
  it("renders the server's allowed targets, not a local transition table", () => {
    renderInProviders(
      <StatusSelect
        value="closed"
        onChange={vi.fn()}
        error={transitionError(["open", "in_progress"])}
      />,
    );

    expect(
      screen.getByText("Not allowed from here. You can move it to Open or In progress instead."),
    ).toBeInTheDocument();
  });

  /**
   * The list is server data. If the API ever adds a status the client does not
   * know, the label must be the raw value rather than `undefined`.
   */
  it("renders an unknown allowed value as itself", () => {
    renderInProviders(
      <StatusSelect value="closed" onChange={vi.fn()} error={transitionError(["escalated"])} />,
    );

    expect(screen.getByText(/You can move it to escalated instead\./)).toBeInTheDocument();
  });

  it("falls back to mapped copy when the error is not a transition failure", () => {
    renderInProviders(
      <StatusSelect
        value="open"
        onChange={vi.fn()}
        error={new ApiClientError({ code: "NETWORK_ERROR", message: "x", status: 0 })}
      />,
    );

    expect(
      screen.getByText("Check your connection, or the API may not be running."),
    ).toBeInTheDocument();
  });

  it("renders no message at all when there is no error", () => {
    renderInProviders(<StatusSelect value="open" onChange={vi.fn()} error={null} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("disables the control while a change is in flight", () => {
    renderInProviders(<StatusSelect value="open" onChange={vi.fn()} isPending />);
    expect(screen.getByRole("combobox")).toBeDisabled();
  });
});
