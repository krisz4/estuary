import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

export type MiniNavSection = {
  id: string;
  label: string;
  count?: number;
};

/**
 * The sticky scroll-spy bar for the Map landing page: appears once the hero
 * has scrolled past (observed via `heroSentinelId`, an empty marker at the
 * hero's bottom edge), and highlights whichever section is currently most in
 * view. Each label is a real `<a href="#...">` — the hash is shareable and
 * keyboard/back-button behaviour comes for free.
 */
export const MiniNav = ({
  sections,
  heroSentinelId,
}: {
  sections: readonly MiniNavSection[];
  heroSentinelId: string;
}) => {
  const [visible, setVisible] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);

  useEffect(() => {
    const sentinel = document.getElementById(heroSentinelId);
    if (sentinel === null) return;
    // "Scrolled past", not merely "not intersecting": on a hero taller than
    // the viewport (tablet/phone, since the needs-you row now flows below
    // the map instead of sitting in a fixed-height row), the sentinel starts
    // out **below** the fold — not yet reached — which is `isIntersecting:
    // false` too, indistinguishable from "scrolled past" by that flag alone.
    // `top < 0` disambiguates: negative means the sentinel's top edge is
    // *above* the viewport (we scrolled past it), positive means it's still
    // below (not reached yet).
    const isPast = (): boolean => sentinel.getBoundingClientRect().top < 0;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry === undefined) return;
        setVisible(!entry.isIntersecting && entry.boundingClientRect.top < 0);
      },
      // `rootMargin`'s top is shrunk by the sticky app header's height
      // (`3.5rem` — `AppHeader`'s `h-14`): without it, "intersecting" is
      // computed against the *full* viewport, so the sentinel can report
      // "still intersecting" while it is actually hidden behind the header.
      { threshold: 0, rootMargin: "-56px 0px 0px 0px" },
    );
    observer.observe(sentinel);

    // Belt and suspenders: a plain `scroll` listener, rAF-throttled,
    // double-checking the same geometry directly. A large instantaneous
    // jump — `scrollIntoView()`, clicking a same-page hash link, or a
    // testing tool driving the page programmatically rather than with real
    // wheel/touch input — does not reliably produce a fresh
    // `IntersectionObserver` callback in every engine/mode (observed in
    // headless Chromium; real wheel-driven scrolling fires it every time).
    // Without this, the nav could stay hidden forever after exactly the
    // "jump to a section" interaction it exists to support.
    let raf = 0;
    const onScroll = () => {
      if (raf !== 0) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setVisible(isPast());
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [heroSentinelId]);

  useEffect(() => {
    const elements = sections
      .map((section) => document.getElementById(section.id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    const ratios = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) ratios.set(entry.target.id, entry.intersectionRatio);
        let best: { id: string; ratio: number } | null = null;
        for (const [id, ratio] of ratios) {
          if (best === null || ratio > best.ratio) best = { id, ratio };
        }
        if (best !== null && best.ratio > 0 && best.id !== activeRef.current) {
          activeRef.current = best.id;
          setActiveId(best.id);
        }
      },
      // Same header+nav offset as the sentinel above, so a section counts as
      // "in view" only once it's actually visible under the sticky bars, not
      // merely present somewhere in the raw viewport.
      { threshold: [0, 0.25, 0.5, 0.75, 1], rootMargin: "-100px 0px -40% 0px" },
    );
    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, [sections]);

  if (!visible) return null;

  return (
    <nav
      aria-label="Map sections"
      // `fixed`, not `sticky`: it must overlay the content just under the app
      // header with **zero** layout shift when it appears/disappears — a
      // sticky element still reserves its own height in normal flow, which
      // was rendering as a blank band above the hero on every load.
      className="fixed inset-x-0 top-14 z-30 flex items-center gap-1 overflow-x-auto border-b border-border bg-background/95 px-4 py-2 text-sm backdrop-blur md:px-6"
    >
      <a
        href="#hero"
        className="shrink-0 rounded-md px-2 py-1 font-semibold text-foreground hover:bg-map-panel-2"
      >
        Map
      </a>
      {sections.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          aria-current={activeId === section.id ? "location" : undefined}
          className={cn(
            "shrink-0 rounded-md px-2 py-1 whitespace-nowrap transition-colors hover:bg-map-panel-2",
            activeId === section.id ? "bg-map-panel-2 font-semibold text-foreground" : "text-muted-foreground",
          )}
        >
          {section.label}
          {section.count === undefined ? null : (
            <span className="ml-1 font-mono text-xs tabular-nums">({section.count})</span>
          )}
        </a>
      ))}
    </nav>
  );
};
