import { Inbox, ListChecks, Plus } from "lucide-react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useTaskStatsQuery } from "@/api/tasks";
import { listReturnState } from "@/components/PageHeader";
import { Container } from "@/components/layout/Container";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { SessionControl } from "@/features/session/SessionControl";

/**
 * The only chrome in the app.
 *
 * No sidebar and no nav drawer: the app is two places — all tasks (list or
 * board) and the inbox of things waiting on a human — plus forms. A navigation
 * shell would be scaffolding around that.
 *
 * Sticky, so "New task" and the inbox badge stay reachable while scrolling a
 * long list. The hairline border is unconditional rather than appearing on
 * scroll — a scroll-listener that toggles a border costs a listener and a
 * re-render on every frame for an effect nobody has asked about.
 *
 * Both "New task" links carry `listReturnState`. The header is not rendered by
 * the list page, so it reads the current location itself — and it is the *only*
 * way most users reach `/tasks/new`, which means it is also the only thing
 * that can tell the create page which filtered list to cancel back to.
 */
export const AppHeader = () => {
  const location = useLocation();
  const createState = listReturnState(location);

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <Container className="flex h-14 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1 sm:gap-3">
          <Link
            to="/tasks"
            className="flex items-center gap-2 rounded-md font-semibold text-foreground"
          >
            <ListChecks className="size-5 text-primary" aria-hidden="true" />
            <span>Tasks</span>
          </Link>

          <nav aria-label="Main">
            <InboxLink />
          </nav>
        </div>

        <div className="flex items-center gap-1 sm:gap-2">
          <ThemeToggle />
          <SessionControl />

          {/*
          Two buttons rather than one with a responsive label: an icon-only
          button needs an `aria-label` and a labelled one must not have a
          redundant one, so a single element would carry an accessible name that
          is right at one breakpoint and doubled at the other.
        */}
          <Button asChild size="icon" className="sm:hidden">
            <Link to="/tasks/new" state={createState} aria-label="New task">
              <Plus aria-hidden="true" />
            </Link>
          </Button>
          <Button asChild className="hidden sm:inline-flex">
            <Link to="/tasks/new" state={createState}>
              <Plus aria-hidden="true" />
              New task
            </Link>
          </Button>
        </div>
      </Container>
    </header>
  );
};

/**
 * "Inbox", with the number of tasks waiting on a human.
 *
 * The count is `stats.needsAttention`, which polls — an agent asking a question
 * lights the badge up on whatever screen the user is on. A failed or pending
 * stats request shows no badge rather than an error: the link still works, and
 * the inbox page has its own error state.
 *
 * The number is in the accessible name as words ("Inbox, 3 waiting on you"),
 * and the visible pill is `aria-hidden`, so it is read once.
 */
const InboxLink = () => {
  const { data: stats } = useTaskStatsQuery();
  const count = stats?.needsAttention ?? 0;

  return (
    <NavLink
      to="/inbox"
      aria-label={count === 0 ? "Inbox" : `Inbox, ${count} waiting on you`}
      className={({ isActive }) =>
        cn(
          "inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors",
          isActive ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
        )
      }
    >
      <Inbox className="size-4" aria-hidden="true" />
      <span className="hidden sm:inline">Inbox</span>
      {count === 0 ? null : (
        <span
          aria-hidden="true"
          className="rounded-full bg-primary px-1.5 text-xs leading-5 font-medium text-primary-foreground tabular-nums"
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </NavLink>
  );
};
