import { type HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/**
 * A loading placeholder.
 *
 * Sized by the caller to match the real content's shape — the guidelines
 * explicitly rule out a centred spinner, because a spinner collapses the page
 * to nothing and then snaps it back to full height, which reads worse than a
 * slow load.
 *
 * `aria-hidden` because the shapes carry no information; the container that
 * renders them owns the `aria-busy` that assistive technology actually needs.
 */
export const Skeleton = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("animate-pulse rounded-md bg-muted", className)}
    aria-hidden="true"
    {...props}
  />
);
