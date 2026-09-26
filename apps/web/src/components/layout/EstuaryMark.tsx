import { useId } from "react";
import { cn } from "@/lib/cn";

/**
 * The Estuary logo: three tributaries (projects) converge into one river that
 * opens to the sea. An amber bead waits upstream and a green one has reached
 * the mouth — the map's "waits on you" and "done" colours.
 *
 * Fixed colours rather than theme tokens, like any logo: the tile carries its
 * own contrast, so it reads the same on the light and dark header. The same
 * drawing is `public/favicon.svg`; change both together.
 *
 * `useId` for the clip path, because an inline SVG's ids are document-global
 * and the mark may render more than once.
 */
export const EstuaryMark = ({ className }: { className?: string }) => {
  const clipId = `estuary-mark-${useId()}`;

  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={cn("shrink-0", className)}
    >
      <defs>
        <clipPath id={clipId}>
          <rect width="32" height="32" rx="8" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <rect width="32" height="32" fill="#1f5c6b" />
        <g strokeWidth="2.6" strokeLinecap="round">
          <path d="M-1 24.5C8 24.5 12 16 20 16" stroke="#6fa3ad" />
          <path d="M-1 16H20" stroke="#a9ccd2" />
          <path d="M-1 7.5C8 7.5 12 16 20 16" stroke="#fff" />
        </g>
        <path
          d="M17 14.5C20.5 14.5 22.6 13.6 24.4 11.8 26.2 10 28.4 8.6 33 8V24C28.4 23.4 26.2 22 24.4 20.2 22.6 18.4 20.5 17.5 17 17.5Z"
          fill="#fff"
        />
        <circle cx="8.4" cy="10.7" r="2.7" fill="#f2a33a" stroke="#1f5c6b" strokeWidth="1.5" />
        <circle cx="26.6" cy="16" r="2.3" fill="#2d8f78" />
      </g>
    </svg>
  );
};
