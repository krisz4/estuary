import { Outlet, ScrollRestoration, useLocation } from "react-router-dom";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AppHeader } from "@/components/layout/AppHeader";
import { Container } from "@/components/layout/Container";
import { SkipLink } from "@/components/layout/SkipLink";

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
    <div className="flex min-h-full flex-col bg-background">
      <SkipLink />
      <AppHeader />

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
          Helpdesk — internal IT support ticketing.
        </Container>
      </footer>

      {/*
        Paging through a list otherwise lands you halfway down the next page,
        because the scroll position survives the route change.
      */}
      <ScrollRestoration />
    </div>
  );
};
