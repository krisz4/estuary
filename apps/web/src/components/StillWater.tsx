import { cn } from "@/lib/cn";

/**
 * A bead resting on still water — the empty-state art for "nothing waits on
 * you". Ripples, a couple of reeds, one floating bead. Theme-aware through
 * the Map's water tokens; the bead's `bob` is ambient and stops under
 * `prefers-reduced-motion` like every other animation.
 */
export const StillWater = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 140 56"
    fill="none"
    aria-hidden="true"
    className={cn("h-14 w-36", className)}
  >
    <ellipse cx="70" cy="38" rx="62" ry="9" className="fill-map-water/35" />
    <ellipse cx="70" cy="38" rx="46" ry="6.5" className="stroke-map-water-edge/35" />
    <ellipse cx="70" cy="38" rx="30" ry="4.2" className="stroke-map-water-edge/55" />
    <ellipse cx="70" cy="38" rx="15" ry="2.2" className="stroke-map-water-edge/80" />
    <g className="stroke-map-ink-3" strokeLinecap="round">
      <path d="M20 40 C19 30 17 22 14 14" />
      <path d="M25 41 C25 32 26 25 29 18" />
      <path d="M29 41 C30 35 33 30 37 27" />
      <path d="M116 40 C117 33 119 27 123 22" />
    </g>
    <g className="origin-center animate-bob">
      <circle cx="70" cy="33" r="6" className="fill-card stroke-map-water-edge" strokeWidth="1.5" />
      <circle cx="68" cy="31" r="1.6" className="fill-map-water-edge/60" />
    </g>
  </svg>
);
