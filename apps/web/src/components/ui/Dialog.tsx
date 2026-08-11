import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { forwardRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Radix Dialog, restyled.
 *
 * Radix gives the four behaviors the design guidelines require and that a
 * hand-rolled modal always gets at least one of wrong: focus trapped inside,
 * `Escape` closes, focus returns to the trigger on close, and the rest of the
 * page marked `aria-hidden` while it is open.
 *
 * Which control is focused on open is the caller's decision, not this file's —
 * the guidelines say the *safe* action takes focus, which for a delete confirm
 * is "Cancel". Pass `autoFocus` on that button, or `onOpenAutoFocus` on the
 * content.
 */

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export const DialogContent = forwardRef<
  HTMLDivElement,
  RadixDialog.DialogContentProps & { children: ReactNode; hideCloseButton?: boolean }
>(function DialogContent({ className, children, hideCloseButton = false, ...props }, ref) {
  return (
    <RadixDialog.Portal>
      {/*
        `animate-overlay-in` / `animate-sheet-in` / `animate-dialog-in` are
        defined in index.css. They are NOT `tailwindcss-animate`'s `animate-in`
        + `fade-in-0`, which is what this used to say — that plugin is not a
        dependency, and Tailwind v4 drops unknown utilities silently, so those
        classes emitted no CSS and the overlay never faded.
      */}
      <RadixDialog.Overlay
        className={cn("fixed inset-0 z-50 bg-overlay", "data-[state=open]:animate-overlay-in")}
      />
      <RadixDialog.Content
        ref={ref}
        className={cn(
          "fixed z-50 flex flex-col gap-4 border border-border bg-card p-4 text-card-foreground shadow-xl",
          // Bottom sheet on a phone, centred card from `sm`. A centred 400px
          // card at 360px leaves ~10px of gutter and puts the actions under the
          // keyboard; anchoring to the bottom edge keeps them by the thumb.
          "inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-xl",
          "sm:inset-x-auto sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:w-full sm:max-w-md",
          "sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg sm:p-6",
          // Two entrances, because there are two layouts: a sheet rising from
          // the bottom edge below `sm`, a centred panel scaling in above it.
          "data-[state=open]:animate-sheet-in sm:data-[state=open]:animate-dialog-in",
          className,
        )}
        {...props}
      >
        {children}
        {hideCloseButton ? null : (
          <RadixDialog.Close
            className={cn(
              "absolute top-3 right-3 rounded-md p-1 text-muted-foreground",
              "transition-colors hover:bg-muted hover:text-foreground",
            )}
            aria-label="Close"
          >
            <X className="size-4" aria-hidden="true" />
          </RadixDialog.Close>
        )}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
});

export const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col gap-1 pr-8", className)} {...props} />
);

/**
 * Required by Radix — it wires `aria-labelledby` from this. Omitting it logs a
 * console error rather than failing, so the dialog ships unlabelled.
 */
export const DialogTitle = forwardRef<HTMLHeadingElement, RadixDialog.DialogTitleProps>(
  function DialogTitle({ className, ...props }, ref) {
    return (
      <RadixDialog.Title
        ref={ref}
        className={cn("text-base font-semibold text-foreground", className)}
        {...props}
      />
    );
  },
);

export const DialogDescription = forwardRef<
  HTMLParagraphElement,
  RadixDialog.DialogDescriptionProps
>(function DialogDescription({ className, ...props }, ref) {
  return (
    <RadixDialog.Description
      ref={ref}
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
});

/**
 * Action row. Reversed on mobile so the confirming action sits at the bottom,
 * nearest the thumb, while keeping the DOM order Cancel-then-Confirm that tab
 * order and the "safe action first" rule want.
 */
export const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
    {...props}
  />
);
