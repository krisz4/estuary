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
