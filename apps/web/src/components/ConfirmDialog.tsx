import { type ReactNode } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  type ButtonVariant,
} from "@/components/ui";

/**
 * "Are you sure?" — the only gate in front of an irreversible action.
 *
 * Deleting a task is a hard delete that cascades to its comments
 * (`docs/features/Tasks.md` § Rules); there is no undo to offer afterwards,
 * so the confirmation is the whole safety mechanism.
 *
 * Two deliberate choices:
 *
 * - **Cancel takes focus, not Confirm.** Radix focuses the first tabbable
 *   element in the content by default, which for a destructive dialog would put
 *   a `Return` keypress one keystroke away from an irreversible delete.
 *   **`Cancel` being first in the DOM is what does the work** — that is what
 *   Radix's default lands on, and what the tab order follows. `DialogFooter`
 *   reverses the *visual* order below `sm` so Confirm still sits nearest the
 *   thumb, which is exactly why the markup order must not be "tidied" to match.
 *   `autoFocus` is a redundant second guard for the day that order changes: it
 *   is measurably not load-bearing today (drop it and every test still passes)
 *   and it cannot be tested in isolation, because React applies it by calling
 *   `.focus()` rather than by emitting an attribute. `ConfirmDialog.test.tsx`
 *   pins the DOM order directly instead.
 * - **The dialog stays open while the mutation is in flight** and shows the
 *   spinner on its own button. Closing on click and toasting later hides a
 *   failure behind a screen the user has already left.
 */
export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Say what will happen, including anything that goes with it. */
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: ButtonVariant;
  isPending?: boolean;
  onConfirm: () => void;
};

export const ConfirmDialog = ({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmVariant = "destructive",
  isPending = false,
  onConfirm,
}: ConfirmDialogProps) => (
  <Dialog
    open={open}
    onOpenChange={(next) => {
      // Escape and the overlay must not cancel a delete that is already running
      // — the request is not cancellable, so dismissing the dialog would leave
      // the user unsure whether it happened.
      if (isPending && !next) return;
      onOpenChange(next);
    }}
  >
    <DialogContent hideCloseButton>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>

      <DialogFooter>
        <Button
          variant="outline"
          autoFocus
          disabled={isPending}
          onClick={() => onOpenChange(false)}
        >
          {cancelLabel}
        </Button>
        <Button variant={confirmVariant} isLoading={isPending} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);
