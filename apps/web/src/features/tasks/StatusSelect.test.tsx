import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "@/api/http";
import { StatusSelect } from "@/features/tasks/StatusSelect";
import { renderInProviders } from "@/test/harness";

afterEach(() => {
  vi.clearAllMocks();
});

describe("StatusSelect", () => {
  it("offers all ten statuses", async () => {
    const user = userEvent.setup();
    renderInProviders(<StatusSelect value="todo" onChange={vi.fn()} />);

    await user.click(screen.getByRole("combobox", { name: "Status" }));

    expect(await screen.findAllByRole("option")).toHaveLength(10);
  });

  it("reports the pick and leaves posting it to the page", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderInProviders(<StatusSelect value="todo" onChange={onChange} />);

    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await user.click(await screen.findByRole("option", { name: "Blocked" }));

    expect(onChange).toHaveBeenCalledWith("blocked");
  });

  it("names who holds the claim when a move is refused for it", () => {
    renderInProviders(
      <StatusSelect
        value="in_progress"
        onChange={vi.fn()}
        error={
          new ApiClientError({
            code: "TASK_ALREADY_CLAIMED",
            message: "claimed",
            details: { claimedBy: "agent:claude-code", expiresAt: "2026-09-25T12:00:00.000Z" },
            status: 409,
          })
        }
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/^agent:claude-code holds the claim\./);
  });

  it("falls back to mapped copy for any other failure", () => {
    renderInProviders(
      <StatusSelect
        value="todo"
        onChange={vi.fn()}
        error={new ApiClientError({ code: "NETWORK_ERROR", message: "x", status: 0 })}
      />,
    );

    expect(
      screen.getByText("Check your connection, or the API may not be running."),
    ).toBeInTheDocument();
  });

  it("renders no message at all when there is no error", () => {
    renderInProviders(<StatusSelect value="todo" onChange={vi.fn()} error={null} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("disables the control while a change is in flight", () => {
    renderInProviders(<StatusSelect value="todo" onChange={vi.fn()} isPending />);
    expect(screen.getByRole("combobox")).toBeDisabled();
  });
});
