import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * Vitest runs with `globals: false`, so React Testing Library's automatic
 * cleanup (which hooks a global `afterEach`) never registers. Wiring it here
 * explicitly keeps rendered trees from leaking between test files.
 */
afterEach(() => {
  cleanup();
});

/**
 * jsdom implements neither the Pointer Capture API nor `scrollIntoView`, and
 * Radix's Select reaches for both on the very first pointer event — so without
 * these every Select test dies with `target.hasPointerCapture is not a function`
 * before it can assert anything.
 *
 * Stubs rather than implementations: nothing under test depends on capture
 * semantics, only on the methods existing. Stage 13's tests need this too.
 */
if (typeof Element !== "undefined") {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
}

/**
 * jsdom has no `matchMedia` at all, and the ticket list decides between the
 * table and the card list with one (`MD_BREAKPOINT_QUERY`).
 *
 * This is a real implementation of `(min-width: Npx)` against `window.innerWidth`
 * rather than a constant, because a stub that always answered `false` would make
 * every responsive test agree with itself: the cards would render at 1280px and
 * the assertion "cards at 360px" would pass for the wrong reason. Any other query
 * — `prefers-color-scheme`, which `theme.ts` reads — resolves to `false`, which
 * is jsdom's own default answer anyway.
 *
 * Change the width with `setViewportWidth()` below; it fires the `resize` that
 * wakes the `useSyncExternalStore` subscription in `useMediaQuery`.
 */
const MIN_WIDTH_QUERY = /\(\s*min-width:\s*(\d+)px\s*\)/;

const queryMatches = (query: string): boolean => {
  const match = MIN_WIDTH_QUERY.exec(query);
  return match?.[1] === undefined ? false : window.innerWidth >= Number(match[1]);
};

/**
 * One registry and one `resize` handler for the whole file.
 *
 * `useMediaQuery`'s `getSnapshot` calls `matchMedia(query)` on **every render**,
 * so a handler registered per call leaks one listener per render — each bound to
 * a MediaQueryList nobody holds, and each invoked by every later
 * `setViewportWidth()`. The cost grows with the render count across a test file,
 * which is the wrong direction with stage 13 about to add many more component
 * tests against this stub.
 *
 * Entries are added on `addEventListener` and removed on `removeEventListener`,
 * so a MediaQueryList nothing subscribed to costs nothing at all.
 */
type MediaEntry = { query: string; listener: (event: MediaQueryListEvent) => void };

const liveMediaEntries = new Set<MediaEntry>();
let resizeHandlerBound = false;

const bindResizeHandler = (): void => {
  if (resizeHandlerBound) return;
  resizeHandlerBound = true;
  window.addEventListener("resize", () => {
    for (const entry of liveMediaEntries) {
      entry.listener({
        matches: queryMatches(entry.query),
        media: entry.query,
      } as MediaQueryListEvent);
    }
  });
};

if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList => {
    const entries = new Map<(event: MediaQueryListEvent) => void, MediaEntry>();

    const add = (listener: (event: MediaQueryListEvent) => void) => {
      if (entries.has(listener)) return;
      const entry: MediaEntry = { query, listener };
      entries.set(listener, entry);
      liveMediaEntries.add(entry);
      bindResizeHandler();
    };

    const remove = (listener: (event: MediaQueryListEvent) => void) => {
      const entry = entries.get(listener);
      if (entry === undefined) return;
      entries.delete(listener);
      liveMediaEntries.delete(entry);
    };

    return {
      media: query,
      get matches() {
        return queryMatches(query);
      },
      onchange: null,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        add(listener),
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        remove(listener),
      addListener: (listener: (event: MediaQueryListEvent) => void) => add(listener),
      removeListener: (listener: (event: MediaQueryListEvent) => void) => remove(listener),
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  };
}

/** Live media-query subscriptions — the leak guard asserts on this. */
export const liveMediaQueryListenerCount = (): number => liveMediaEntries.size;

/** Resizes the jsdom window and notifies every live media-query listener. */
export const setViewportWidth = (width: number): void => {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
  window.dispatchEvent(new Event("resize"));
};
