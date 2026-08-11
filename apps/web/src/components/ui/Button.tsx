import { Slot } from "@radix-ui/react-slot";
import { Loader2 } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "destructive";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary/90",
  secondary: "bg-neutral text-neutral-foreground hover:bg-neutral/80",
  outline: "border border-input bg-card text-foreground hover:bg-muted",
  ghost: "text-foreground hover:bg-muted",
  destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 px-3 text-xs",
  md: "h-9 gap-2 px-4 text-sm",
  lg: "h-11 gap-2 px-6 text-sm",
  // Square. Every icon-only button needs an `aria-label`; see the guard below.
  icon: "size-9 p-0",
};

const BASE = cn(
  "inline-flex shrink-0 items-center justify-center rounded-md font-medium",
  "whitespace-nowrap transition-colors",
  // The focus ring is defined once in the base layer; this only keeps the
  // default outline from being clipped by the rounded corner.
  "focus-visible:outline-offset-2",
  "disabled:pointer-events-none disabled:opacity-50",
  "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * Render as the single child element instead of a `<button>`, keeping the
   * styling. This is how a link gets button styling without nesting an `<a>`
   * inside a `<button>` — which is invalid HTML and breaks middle-click.
   */
  asChild?: boolean;
  /** Shows a spinner and disables the button. Label text stays, so width is stable. */
  isLoading?: boolean;
  children?: ReactNode;
};

/**
 * The button.
 *
 * `type="button"` is the default rather than the platform's `"submit"`. Inside a
 * form, an unlabelled `<button>` submits it — so a "Add filter" or "Cancel"
 * button in a form silently posts it. Submit buttons opt in explicitly.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant = "primary",
    size = "md",
    asChild = false,
    isLoading = false,
    disabled,
    children,
    type,
    ...props
  },
  ref,
) {
  const Component = asChild ? Slot : "button";

  if (import.meta.env.DEV && size === "icon" && props["aria-label"] === undefined && !asChild) {
    // Not a throw: a missing label should not blank the screen. But it is a real
    // accessibility defect and the design guidelines name it explicitly.
    console.warn('<Button size="icon"> needs an aria-label — it has no visible text.');
  }

  return (
    <Component
      ref={ref}
      className={cn(BASE, VARIANTS[variant], SIZES[size], className)}
      disabled={asChild ? undefined : disabled || isLoading}
      aria-busy={isLoading || undefined}
      {...(asChild ? {} : { type: type ?? "button" })}
      {...props}
    >
      {/*
        With `asChild`, `children` must stay a *single* element — Slot merges its
        props onto exactly one child and throws ("Slot failed to slot onto its
        children") the moment a spinner is prepended beside it. So the spinner is
        only added in the plain-button case, which is also the only case it makes
        sense in: `asChild` renders a link, and a link has no pending state.
      */}
      {asChild ? (
        children
      ) : (
        <>
          {isLoading ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          {children}
        </>
      )}
    </Component>
  );
});
