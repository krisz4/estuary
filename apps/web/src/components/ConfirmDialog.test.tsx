import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui";
import { renderInProviders } from "@/test/harness";

const Host = ({ isPending = false, onConfirm = vi.fn() }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Delete</Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete HD-000042?"
        description="This also deletes its 3 comments. This can't be undone."
        confirmLabel="Delete ticket"
        isPending={isPending}
        onConfirm={onConfirm}
      />
    </>
  );
};

describe("ConfirmDialog", () => {
  it("focuses Cancel, not the destructive action", async () => {
    const user = userEvent.setup();
    renderInProviders(<Host />);

    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    });
  });

  it("is labelled by its heading and carries the description", async () => {
    const user = userEvent.setup();
    renderInProviders(<Host />);
    await user.click(screen.getByRole("button", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("Delete HD-000042?");
    expect(dialog).toHaveAccessibleDescription(
      "This also deletes its 3 comments. This can't be undone.",
    );
  });

  it("closes on Escape when idle", async () => {
    const user = userEvent.setup();
    renderInProviders(<Host />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  /**
   * The DELETE is already in flight and is not cancellable. Dismissing the
   * dialog would leave the user unsure whether it happened.
   */
  it("refuses to close while the confirmed action is pending", async () => {
    const user = userEvent.setup();
    renderInProviders(<Host isPending />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("calls onConfirm exactly once per click", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderInProviders(<Host onConfirm={onConfirm} />);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(await screen.findByRole("button", { name: "Delete ticket" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
