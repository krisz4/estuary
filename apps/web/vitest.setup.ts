import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect } from "vitest";
import { harnessFaults, server } from "./src/test/server";
import { resetProjectScopeStore } from "./src/stores/projectScope";
import { resetTaskViewStore } from "./src/stores/taskView";
import { resetSessionStore } from "./src/stores/session";
import { resetLogbookVisitStore } from "./src/stores/logbookVisit";
import { resetMapVisitStore } from "./src/stores/mapVisit";

/**
 * Vitest runs with `globals: false`, so React Testing Library's automatic
 * cleanup (which hooks a global `afterEach`) never registers. Wiring it here
 * explicitly keeps rendered trees from leaking between test files.
 */
afterEach(() => {
  cleanup();
  // After `cleanup()`, not with the stores below: the header's inbox badge reads
  // this store, and after-hooks run in reverse, so a reset there would re-render
  // a still-mounted header into a fresh stats request after MSW's handlers
  // were already reset — an unhandled request charged to the next test.
  resetProjectScopeStore();
  // Also after `cleanup()`, and in this same hook rather than the one below:
  // `useLastVisit`'s unmount effect writes "now" to this store, and after-hooks
  // run in reverse — so a reset registered in a *later* `afterEach` would fire
  // *before* this one's `cleanup()` unmounts the Logbook, leaving the write to
  // land after the reset and leak "now" into the next test as a stale visit.
  resetLogbookVisitStore();
  // Same reasoning, same fix, separate store — see `stores/mapVisit.ts`.
  resetMapVisitStore();
});

/**
 * The task-view store is a module singleton backed by `localStorage`, and
 * neither outlives `cleanup()` — so a test that renders the board would leave
 * `view: "board"` behind and change what the *next* test's back link points at.
 * Reset it here rather than per file: the leak is silent and would be found by
 * whichever unrelated test happened to run next.
 */
afterEach(() => {
  resetTaskViewStore();
  // Same leak, same fix: a display name set by one test would otherwise be the
  // `X-Actor` of every request in the next.
  resetSessionStore();
});

/**
 * MSW's lifecycle, once per test file (`isolate: true` re-runs this file for
 * each one).
 *
 * `onUnhandledRequest: "error"` is the point of doing this here rather than
 * inside the harness: a request nobody declared a handler for now fails the
 * test that issued it, instead of falling through to whatever the environment
 * would have done with it.
 */
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();

  // Read and cleared before asserting, so one faulty test does not cascade into
  // every test after it.
  const faults = harnessFaults.splice(0, harnessFaults.length);
  expect(faults, "mockApi could not dispatch a request — see above").toEqual([]);
});

afterAll(() => {
  server.close();
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
 * jsdom has no `matchMedia` at all, and the task list decides between the
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

/**
 * jsdom implements no `ResizeObserver` at all (unlike a real browser), and the
 * Map (`/tasks/map`) measures its own canvas pane with one on every mount —
 * so without a stub, mounting that page under test throws
 * `ResizeObserver is not defined` from inside a passive effect, which the
 * nearest error boundary (or React Router's own default one, for a route
 * rendered without `AppLayout`) swallows into a blank "Unexpected Application
 * Error!" page instead of the component tree the test wrote assertions against.
 *
 * A no-op stub, not a working implementation: nothing under test asserts on an
 * actual resize firing through this path (that would need real layout, which
 * jsdom does not do either), only on the component surviving `observe()`
 * existing and returning `contentRect`-shaped entries never comes up because
 * `observe()` here never calls back at all — callers fall through to their own
 * `Math.max(fallback, 0)` guards, the same as an observer that legitimately
 * has not fired yet.
 */
if (typeof window !== "undefined" && typeof window.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe(): void {
      /* never fires in jsdom — callers already handle "no size yet" */
    }
    unobserve(): void {
      /* nothing to stop observing */
    }
    disconnect(): void {
      /* nothing to disconnect */
    }
  }
  window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

/**
 * Same gap, same fix, for `IntersectionObserver`: the Map landing page's
 * `MiniNav` uses one to detect "the hero scrolled past" and to scroll-spy the
 * active section. A no-op stub — nothing under test asserts on it actually
 * firing (jsdom does no real layout to intersect against); component tests
 * assert the nav's default (hidden until the hero scrolls out) rather than a
 * simulated scroll.
 */
if (typeof window !== "undefined" && typeof window.IntersectionObserver === "undefined") {
  class IntersectionObserverStub {
    readonly root = null;
    readonly rootMargin = "";
    readonly thresholds: readonly number[] = [];
    observe(): void {
      /* never fires in jsdom */
    }
    unobserve(): void {
      /* nothing to stop observing */
    }
    disconnect(): void {
      /* nothing to disconnect */
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  window.IntersectionObserver = IntersectionObserverStub as unknown as typeof IntersectionObserver;
}
