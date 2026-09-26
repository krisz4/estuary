import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * A small, dependency-free popover: a trigger button plus a panel anchored
 * below it. Built for the floor's compact Dispatch bar — "Priority ▾",
 * "Labels ▾", "More ▾" — where pulling in a second overlay primitive next to
 * Radix's `Dialog`/`Select` for one filter panel would be one more mechanism
 * doing the same job.
 *
 * Accessible baseline: the trigger carries `aria-expanded` and
 * `aria-controls`; the panel is `role="group"` (it is a set of filter
 * controls, not a menu of commands) labelled by the trigger; `Escape` and an
 * outside click both close it, and closing returns focus to the trigger.
 *
 * **Known limitation**: this does not trap focus inside the panel the way a
 * modal dialog does. That is deliberate — a focus trap here would make Tab
 * unable to reach the rest of the Dispatch bar, and every control inside is
 * still independently reachable by Tab either way. It is not a substitute for
 * `Dialog` where a true modal is needed (the floor's task drawer, "More"
 * filters sheet on mobile still use `Dialog`).
 */
export type PopoverProps = {
  label: string;
  /** Shown as a small pill on the trigger when > 0 — "Priority (2)". */
  badgeCount?: number;
  children: (args: { close: () => void }) => ReactNode;
  panelClassName?: string;
  className?: string;
};

export const Popover = ({ label, badgeCount = 0, children, panelClassName, className }: PopoverProps) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hasOpenedRef = useRef(false);
  const panelId = useId();

  // `close` is handed to `children` as a render-prop, so it must not read a
  // ref itself (that would be a ref access during render). Instead it only
  // flips state; the effect below returns focus to the trigger once `open`
  // actually transitions back to false.
  const close = () => setOpen(false);

  useEffect(() => {
    if (open) {
      hasOpenedRef.current = true;
      return;
    }
    if (hasOpenedRef.current) {
      triggerRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={cn("relative inline-block", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm",
          "text-foreground transition-colors hover:bg-muted",
          badgeCount > 0 && "border-primary/50 bg-primary-subtle text-primary-subtle-foreground",
        )}
      >
        {label}
        {badgeCount > 0 ? (
          <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground">{badgeCount}</span>
        ) : null}
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </button>

      {open ? (
        <div
          id={panelId}
          role="group"
          aria-label={label}
          className={cn(
            "absolute top-full left-0 z-40 mt-1 w-72 rounded-lg border border-border bg-popover p-3",
            "text-popover-foreground shadow-xl",
            panelClassName,
          )}
        >
          {children({ close })}
        </div>
      ) : null}
    </div>
  );
};
