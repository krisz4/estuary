import { Plus, TicketCheck } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { listReturnState } from "@/components/PageHeader";
import { Container } from "@/components/layout/Container";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { Button } from "@/components/ui";

/**
 * The only chrome in the app.
 *
 * No sidebar and no nav drawer: there are four screens and one of them is a
 * form (`docs/pages/App_Shell.md`). A navigation shell here would be scaffolding
 * around nothing.
 *
 * Sticky, so "New ticket" stays reachable while scrolling a 63-row list. The
 * hairline border is unconditional rather than appearing on scroll — a
 * scroll-listener that toggles a border costs a listener and a re-render on
 * every frame for an effect nobody has asked about.
 *
 * Both "New ticket" links carry `listReturnState`. The header is not rendered by
 * the list page, so it reads the current location itself — and it is the *only*
 * way most users reach `/tickets/new`, which means it is also the only thing
 * that can tell the create page which filtered list to cancel back to.
 */
export const AppHeader = () => {
  const location = useLocation();
  const createState = listReturnState(location);

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <Container className="flex h-14 items-center justify-between gap-2">
        <Link
          to="/tickets"
          className="flex items-center gap-2 rounded-md font-semibold text-foreground"
        >
          <TicketCheck className="size-5 text-primary" aria-hidden="true" />
          <span>Helpdesk</span>
        </Link>

        <div className="flex items-center gap-1 sm:gap-2">
          <ThemeToggle />

          {/*
          Two buttons rather than one with a responsive label: an icon-only
          button needs an `aria-label` and a labelled one must not have a
          redundant one, so a single element would carry an accessible name that
          is right at one breakpoint and doubled at the other.
        */}
          <Button asChild size="icon" className="sm:hidden">
            <Link to="/tickets/new" state={createState} aria-label="New ticket">
              <Plus aria-hidden="true" />
            </Link>
          </Button>
          <Button asChild className="hidden sm:inline-flex">
            <Link to="/tickets/new" state={createState}>
              <Plus aria-hidden="true" />
              New ticket
            </Link>
          </Button>
        </div>
      </Container>
    </header>
  );
};
