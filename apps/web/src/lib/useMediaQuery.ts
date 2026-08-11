import { useCallback, useSyncExternalStore } from "react";

/**
 * Subscribes to a CSS media query.
 *
 * `useSyncExternalStore` rather than `useState` + `useEffect`: the effect
 * version renders once with the wrong answer and then corrects itself, which
 * for a toast outlet means a toast that appears at the bottom and jumps to the
 * top. This reads the current value during render and re-renders only when the
 * query actually flips.
 *
 * Use it only where the layout decision cannot be expressed in CSS. Everything
 * that *can* be a Tailwind breakpoint should be — a JS media query does not
 * apply until React has hydrated, and it is one more thing to keep in step with
 * the breakpoint table.
 */
export const useMediaQuery = (query: string): boolean => {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
};

/** Tailwind's `sm` breakpoint, as a query. Below this the layout is single-column. */
export const SM_BREAKPOINT_QUERY = "(min-width: 640px)";

/**
 * Tailwind's `md` breakpoint — the one the design guidelines call "the important
 * one", where the ticket list flips between two genuinely different components.
 *
 * This is the exception the note above allows for. `hidden md:block` on the
 * table plus `md:hidden` on the cards would put **both** trees in the DOM at
 * every width: two sets of links to every ticket, two rendered lists to keep in
 * step, and a "which one is showing?" question that can only be answered by
 * reading CSS. Rendering exactly one keeps the DOM the honest answer.
 */
export const MD_BREAKPOINT_QUERY = "(min-width: 768px)";
