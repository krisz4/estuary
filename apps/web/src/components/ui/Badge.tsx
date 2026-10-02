import { type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type BadgeTone =
  "neutral" | "primary" | "success" | "warning" | "info" | "destructive" | "attention";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-neutral-subtle text-neutral-subtle-foreground",
  primary: "bg-primary-subtle text-primary-subtle-foreground",
  success: "bg-success-subtle text-success-subtle-foreground",
  warning: "bg-warning-subtle text-warning-subtle-foreground",
  info: "bg-info-subtle text-info-subtle-foreground",
  destructive: "bg-destructive-subtle text-destructive-subtle-foreground",
  // "Waits on you" — the needs-user-* statuses. Reserved; see index.css.
  attention: "bg-attention-subtle text-attention-subtle-foreground",
};

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
  /**
   * A small filled circle before the label. Purely decorative reinforcement —
   * it is `aria-hidden` and never the only carrier of meaning.
   */
  dot?: boolean;
  children: ReactNode;
};

/**
 * Status and priority pill.
 *
 * **The label is always rendered.** Colour never carries meaning alone
 * (design guidelines § Tokens), so there is no icon-only or colour-only variant
 * of this component to reach for — a `Badge` with no children does not type-check.
 */
export const Badge = ({
  className,
  tone = "neutral",
  dot = false,
  children,
  ...props
}: BadgeProps) => (
  <span
    className={cn(
      "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5",
      "text-xs font-medium whitespace-nowrap",
      TONES[tone],
      className,
    )}
    {...props}
  >
    {dot ? <span className="size-1.5 rounded-full bg-current" aria-hidden="true" /> : null}
    {children}
  </span>
);
