import { type ElementType, type HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type ContainerProps = HTMLAttributes<HTMLDivElement> & {
  as?: ElementType;
};

/**
 * The one centred wrapper: `max-w-6xl`, `px-4` on mobile and `px-6` from `md`
 * (design guidelines § Type and spacing).
 *
 * Forms cap narrower than this — `max-w-2xl` — but they do it inside their own
 * page rather than by shrinking the container, so the page header stays aligned
 * with the list page's.
 */
export const Container = ({ className, as: Component = "div", ...props }: ContainerProps) => (
  <Component className={cn("mx-auto w-full max-w-6xl px-4 md:px-6", className)} {...props} />
);
