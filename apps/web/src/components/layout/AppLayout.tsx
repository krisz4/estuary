import { Outlet, ScrollRestoration, useLocation } from "react-router-dom";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AppHeader } from "@/components/layout/AppHeader";
import { Container } from "@/components/layout/Container";
import { SkipLink } from "@/components/layout/SkipLink";
import { SessionDialog } from "@/features/session/SessionDialog";
import { UnauthorizedBanner } from "@/features/session/UnauthorizedBanner";

/**
 * The frame every route renders inside: skip link → header → main → footer.
 *
 * Real landmarks, not styled divs — `<header>`, `<main>`, `<footer>` are what a
 * screen reader's landmark navigation lists, and they cost nothing.
 *
 * `<main tabIndex={-1}>` is what makes the skip link work: without it the
 * browser moves the scroll position to `#main` but leaves focus where it was, so
 * the next Tab goes back into the header the user just skipped.
 */
export const AppLayout = () => {
  const location = useLocation();

  return (
    /*
      `min-h-dvh`, not `min-h-full`: a percentage minimum resolves against a
      parent that has no height of its own, so `min-h-full` was silently doing
      nothing — on any page shorter than the window the footer floated up under
      the content instead of sitting at the bottom. `dvh` rather than `vh` so a
      mobile browser's collapsing address bar does not leave the shell one
      toolbar taller than the window.
    */
    <div className="flex min-h-dvh flex-col bg-background">
      <SkipLink />
      <AppHeader />
      <UnauthorizedBanner />

      <main id="main" tabIndex={-1} className="flex-1 py-6 focus:outline-none md:py-8">
        <Container>
          {/*
            Keyed on the pathname so a crash is cleared by navigating away.
            Inside <main>, below the header, so the user keeps the nav.
          */}
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </Container>
      </main>

      <footer className="border-t border-border py-6">
        <Container className="text-xs text-muted-foreground">
          Tasks — one board for the work humans and AI agents share.
        </Container>
      </footer>

      {/*
        Paging through a list otherwise lands you halfway down the next page,
        because the scroll position survives the route change.
      */}
      <ScrollRestoration />

      {/* One instance for the whole app; opened through the session store. */}
      <SessionDialog />
    </div>
  );
};
