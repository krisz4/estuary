import { screen, waitFor, within } from "@testing-library/react";
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
        title="Delete TASK-000042?"
        description="This also deletes its 3 comments. This can't be undone."
        confirmLabel="Delete task"
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

  /**
   * The test above passes with **either** mechanism present, and the component
   * ships both: Cancel carries `autoFocus`, *and* Cancel is first in the DOM so
   * Radix's own "focus the first tabbable" lands there anyway. Measured: remove
   * `autoFocus` and it still passes; move Confirm first in the DOM but keep
   * `autoFocus` and it still passes; do both and it fails. One test for two
   * independent guards means either can be deleted as "redundant" in silence —
   * the stage-10 "two fixes can mask each other" shape.
   *
   * So DOM order gets its own assertion. `DialogFooter` deliberately reverses
   * the *visual* order below `sm` (Confirm nearest the thumb), which is exactly
   * the kind of change that invites reordering the markup to match.
   *
   * `autoFocus` gets none, and that is a limitation rather than an oversight:
   * React applies it by calling `.focus()` on mount rather than by emitting an
   * `autofocus` attribute, so it leaves no trace in the DOM and its *effect* is
   * indistinguishable from Radix's. It is a redundant second guard, and the
   * comment on the component says so.
   */
  it("keeps Cancel ahead of Confirm in the DOM, independently of what has focus", async () => {
    const user = userEvent.setup();
    renderInProviders(<Host />);
    await user.click(screen.getByRole("button", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const confirm = within(dialog).getByRole("button", { name: "Delete task" });

    expect(cancel.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is labelled by its heading and carries the description", async () => {
    const user = userEvent.setup();
    renderInProviders(<Host />);
    await user.click(screen.getByRole("button", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("Delete TASK-000042?");
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
    await user.click(await screen.findByRole("button", { name: "Delete task" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
