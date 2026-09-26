import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

export type LogbookMiniNavSection = {
  id: string;
  label: string;
};

/**
 * The Logbook's own sticky scroll-spy bar — same look and behaviour as the
 * Map's `pages/tasks-map/sections/MiniNav`, kept as a local copy rather than
 * imported: that component hardcodes a "Map" home link to `#hero`, which
 * would read wrong here, and it belongs to `pages/tasks-map/`, which is
 * off limits while another agent is actively working in it.
 *
 * Appears once the top area (range control, briefing sentence, KPI tiles)
 * has scrolled past (observed via `topSentinelId`, an empty marker at its
 * bottom edge), and highlights whichever section is currently most in view.
 * Each label is a real `<a href="#...">` — the hash is shareable and
 * keyboard/back-button behaviour comes for free.
 */
export const LogbookMiniNav = ({
  sections,
  topSentinelId,
}: {
  sections: readonly LogbookMiniNavSection[];
  topSentinelId: string;
}) => {
  const [visible, setVisible] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);

  useEffect(() => {
    const sentinel = document.getElementById(topSentinelId);
    if (sentinel === null) return;
    // "Scrolled past", not merely "not intersecting" — see the Map's
    // `MiniNav` for why `top < 0` is the right disambiguator here too.
    const isPast = (): boolean => sentinel.getBoundingClientRect().top < 0;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry === undefined) return;
        setVisible(!entry.isIntersecting && entry.boundingClientRect.top < 0);
      },
      { threshold: 0, rootMargin: "-56px 0px 0px 0px" },
    );
    observer.observe(sentinel);

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
  }, [topSentinelId]);

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
      { threshold: [0, 0.25, 0.5, 0.75, 1], rootMargin: "-100px 0px -40% 0px" },
    );
    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, [sections]);

  if (!visible) return null;

  return (
    <nav
      aria-label="Logbook sections"
      className="fixed inset-x-0 top-14 z-30 flex items-center gap-1 overflow-x-auto border-b border-border bg-background/95 px-4 py-2 text-sm backdrop-blur md:px-6"
    >
      <a href="#logbook-top" className="shrink-0 rounded-md px-2 py-1 font-semibold text-foreground hover:bg-map-panel-2">
        Logbook
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
        </a>
      ))}
    </nav>
  );
};
