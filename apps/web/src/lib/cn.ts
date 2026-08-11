import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Conditional class names, with later Tailwind utilities winning over earlier
 * conflicting ones.
 *
 * `clsx` alone is not enough: `clsx("px-4", "px-6")` emits both, and which one
 * applies then depends on their order in the generated stylesheet rather than
 * in the call. That is what makes a `className` prop on a primitive
 * unreliable — `<Button className="px-6">` would sometimes not override the
 * variant's own padding. `twMerge` resolves the conflict by group, so the last
 * one written wins.
 */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
