import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MiniNav } from "@/pages/tasks-map/sections/MiniNav";

/**
 * jsdom's `IntersectionObserver` is a no-op stub (`vitest.setup.ts`) — it
 * never fires a callback, so these tests can only assert the nav's default,
 * pre-scroll state (hidden) and its static structure, not a live scroll-spy
 * transition. That's still worth locking down: a regression that makes the
 * nav render *before* the hero scrolls out would be a visible page-load bug.
 */
describe("MiniNav", () => {
  it("renders nothing until the hero sentinel exists and has scrolled out of view", () => {
    render(
      <div>
        <div id="hero-end" />
        <MiniNav heroSentinelId="hero-end" sections={[{ id: "needs-you", label: "Needs you" }]} />
      </div>,
    );
    expect(screen.queryByRole("navigation", { name: "Map sections" })).not.toBeInTheDocument();
  });

  it("stays hidden when there is no matching sentinel in the document at all", () => {
    render(
      <MiniNav
        heroSentinelId="does-not-exist"
        sections={[{ id: "needs-you", label: "Needs you" }]}
      />,
    );
    expect(screen.queryByRole("navigation", { name: "Map sections" })).not.toBeInTheDocument();
  });
});

/**
 * A real browser's `IntersectionObserver` fires its callback once observation
 * starts and again on every scroll; jsdom's stub (`vitest.setup.ts`) never
 * calls back at all. These tests install a fake that invokes the callback
 * synchronously and lets the test drive it, so the nav's actual rendered
 * output — labels, counts, `aria-current` — gets covered, not just its
 * default hidden state.
 */
describe("MiniNav, with a driveable IntersectionObserver", () => {
  type Callback = (
    entries: (Pick<IntersectionObserverEntry, "isIntersecting" | "intersectionRatio" | "target"> & {
      boundingClientRect?: Partial<DOMRectReadOnly>;
    })[],
  ) => void;
  const observers: { target: Element; callback: Callback }[] = [];

  const install = () => {
    class FakeIntersectionObserver {
      private readonly callback: Callback;
      constructor(callback: Callback) {
        this.callback = callback;
      }
      observe(target: Element) {
        observers.push({ target, callback: this.callback });
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  };

  afterEach(() => {
    observers.length = 0;
    vi.unstubAllGlobals();
  });

  it("appears once the hero sentinel reports not-intersecting, with each section's count", () => {
    install();
    render(
      <div>
        <div id="hero-end" />
        <div id="needs-you" />
        <div id="all" />
        <MiniNav
          heroSentinelId="hero-end"
          sections={[
            { id: "needs-you", label: "Needs you", count: 12 },
            { id: "all", label: "All tasks", count: 46 },
          ]}
        />
      </div>,
    );

    const sentinelObserver = observers.find((o) => o.target.id === "hero-end");
    // `boundingClientRect.top < 0` is what "scrolled past" means here (see
    // `MiniNav.tsx`) — the sentinel's top edge has moved above the viewport,
    // as opposed to a hero taller than the viewport where it starts below
    // the fold (`top > 0`) and is `isIntersecting: false` for the opposite
    // reason.
    act(() =>
      sentinelObserver?.callback([
        {
          isIntersecting: false,
          intersectionRatio: 0,
          target: sentinelObserver.target,
          boundingClientRect: { top: -10 },
        },
      ]),
    );

    expect(screen.getByRole("navigation", { name: "Map sections" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Needs you.*12/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /All tasks.*46/ })).toBeInTheDocument();
  });

  it("stays hidden when the sentinel is merely below the fold (a hero taller than the viewport), not yet scrolled past", () => {
    install();
    render(
      <div>
        <div id="hero-end" />
        <MiniNav heroSentinelId="hero-end" sections={[{ id: "needs-you", label: "Needs you" }]} />
      </div>,
    );

    const sentinelObserver = observers.find((o) => o.target.id === "hero-end");
    // Not intersecting because it hasn't been reached yet (positive `top`,
    // i.e. still below the viewport) — this used to be indistinguishable
    // from "scrolled past" and made the nav appear at the top of the page on
    // load, on a hero tall enough that the sentinel starts off-screen.
    act(() =>
      sentinelObserver?.callback([
        {
          isIntersecting: false,
          intersectionRatio: 0,
          target: sentinelObserver.target,
          boundingClientRect: { top: 1200 },
        },
      ]),
    );

    expect(screen.queryByRole("navigation", { name: "Map sections" })).not.toBeInTheDocument();
  });

  it("also updates on a plain `scroll` event, independent of the IntersectionObserver callback", async () => {
    // The fallback this locks down: a real, observed race where an abrupt
    // jump (`scrollIntoView`, a hash-link click, or a testing tool driving
    // the page programmatically) did not reliably produce a fresh
    // `IntersectionObserver` callback in every engine, leaving the nav
    // hidden forever after exactly the "jump to a section" interaction it
    // exists to support. A plain `scroll` listener re-checks the sentinel's
    // geometry directly, with no dependency on the observer firing at all.
    install();
    render(
      <div>
        <div id="hero-end" />
        <MiniNav heroSentinelId="hero-end" sections={[{ id: "needs-you", label: "Needs you" }]} />
      </div>,
    );

    const sentinel = document.getElementById("hero-end")!;
    vi.spyOn(sentinel, "getBoundingClientRect").mockReturnValue({ top: -50 } as DOMRect);

    expect(screen.queryByRole("navigation", { name: "Map sections" })).not.toBeInTheDocument();
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(screen.getByRole("navigation", { name: "Map sections" })).toBeInTheDocument();
  });

  it("marks the section with the highest intersection ratio as aria-current", () => {
    install();
    render(
      <div>
        <div id="hero-end" />
        <div id="needs-you" />
        <div id="all" />
        <MiniNav
          heroSentinelId="hero-end"
          sections={[
            { id: "needs-you", label: "Needs you" },
            { id: "all", label: "All tasks" },
          ]}
        />
      </div>,
    );

    const sentinelObserver = observers.find((o) => o.target.id === "hero-end");
    act(() =>
      sentinelObserver?.callback([
        {
          isIntersecting: false,
          intersectionRatio: 0,
          target: sentinelObserver.target,
          boundingClientRect: { top: -10 },
        },
      ]),
    );

    const needsYou = document.getElementById("needs-you")!;
    const all = document.getElementById("all")!;
    const sectionObserver = observers.find((o) => o.target === needsYou);
    act(() =>
      sectionObserver?.callback([
        { isIntersecting: true, intersectionRatio: 0.8, target: needsYou },
        { isIntersecting: true, intersectionRatio: 0.1, target: all },
      ]),
    );

    expect(screen.getByRole("link", { name: /Needs you/ })).toHaveAttribute(
      "aria-current",
      "location",
    );
    expect(screen.getByRole("link", { name: /All tasks/ })).not.toHaveAttribute("aria-current");
  });
});
