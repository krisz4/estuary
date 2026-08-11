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
 * Deleting a ticket is a hard delete that cascades to its comments
 * (`docs/features/Tickets.md` § Rules); there is no undo to offer afterwards,
 * so the confirmation is the whole safety mechanism.
 *
 * Two deliberate choices:
 *
 * - **Cancel takes focus, not Confirm.** Radix focuses the first tabbable
 *   element in the content by default, which for a destructive dialog would put
 *   a `Return` keypress one keystroke away from an irreversible delete. `Cancel`
 *   is first in the DOM and carries `autoFocus`, so both the tab order and the
 *   initial focus land on the safe action. `DialogFooter` reverses the *visual*
 *   order below `sm` so Confirm still sits nearest the thumb.
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
