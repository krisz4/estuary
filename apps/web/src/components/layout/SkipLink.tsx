/**
 * "Skip to content", first in tab order and visible only on focus.
 *
 * `sr-only` plus `focus:not-sr-only` rather than an off-screen `left: -9999px`
 * trick: the link must be genuinely focusable and genuinely visible once
 * focused, and a `display: none` variant of this pattern is skipped by the tab
 * order entirely — which is the single most common way a skip link ships broken.
 *
 * The target is `#main`, which `AppLayout` puts on a `<main tabIndex={-1}>` so
 * the jump actually moves focus rather than only the scroll position.
 */
export const SkipLink = () => (
  <a
    href="#main"
    className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
  >
    Skip to content
  </a>
);
