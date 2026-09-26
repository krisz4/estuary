import { History, Inbox, Plus, Waves } from "lucide-react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useTaskStatsQuery } from "@/api/tasks";
import { listReturnState } from "@/components/PageHeader";
import { EstuaryMark } from "@/components/layout/EstuaryMark";
import { ProjectSwitcher } from "@/components/layout/ProjectSwitcher";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { SessionControl } from "@/features/session/SessionControl";
import { projectScopeSearch, useProjectScope } from "@/stores/projectScope";
import { taskViewPath, useTaskView } from "@/stores/taskView";

/**
 * The only chrome in the app.
 *
 * No sidebar and no nav drawer: the app is two places — all tasks (list or
 * map) and the inbox of things waiting on a human — plus forms. A navigation
 * shell would be scaffolding around that.
 *
 * `ProjectSwitcher` scopes both places to one project, and both links carry
 * that scope (`useProjectScope`), so a task opened from `web-app`'s inbox
 * leads back to `web-app`'s inbox rather than to every project's.
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
  const { project } = useProjectScope();

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-card/90 shadow-raised backdrop-blur-xl supports-[backdrop-filter]:bg-card/75">
      {/*
        Full-bleed to the landing page's width (`max-w-[1760px]`, same gutters
        as `TasksMapPage`), not the 1152px `Container`: the map is the first
        thing most people see, and a header narrower than it floats off-centre
        above it. Narrower pages sit centred inside this, as in most dashboards.

        One row from `lg`; below that the project picker and the nav drop to a
        second row via `order`, not a second copy of the markup — two copies
        would mean two "Inbox" links for a screen reader and for every test.
      */}
      <div className="mx-auto flex max-w-[1760px] flex-wrap items-center gap-x-2 gap-y-2 px-4 py-2.5 md:px-6 lg:h-16 lg:flex-nowrap lg:gap-x-3 lg:py-0">
        <Link
          to={`/tasks${projectScopeSearch(project)}`}
          aria-label="Estuary"
          className="group flex shrink-0 items-center gap-2.5 rounded-lg pr-1"
        >
          <EstuaryMark className="size-9 drop-shadow-sm transition-transform duration-300 group-hover:-rotate-3 group-hover:scale-105" />
          <span className="text-xl font-bold tracking-tight text-foreground">Estuary</span>
        </Link>

        <div className="order-3 flex w-full min-w-0 items-center gap-2 lg:order-none lg:w-auto lg:gap-3">
          <span aria-hidden="true" className="hidden h-6 w-px rotate-12 bg-border lg:block" />
          <ProjectSwitcher />
          <nav
            aria-label="Main"
            className="flex min-w-0 flex-1 items-center gap-0.5 rounded-full bg-background/70 p-1 ring-1 ring-border ring-inset lg:flex-none"
          >
            <TasksLink project={project} />
            <InboxLink project={project} />
            <LogbookLink project={project} />
          </nav>
        </div>

        <div className="order-2 ml-auto flex items-center gap-1 lg:order-none sm:gap-1.5">
          <ThemeToggle />
          <SessionControl />

          {/*
          Two buttons rather than one with a responsive label: an icon-only
          button needs an `aria-label` and a labelled one must not have a
          redundant one, so a single element would carry an accessible name that
          is right at one breakpoint and doubled at the other.
        */}
          <Button asChild size="icon" className="rounded-full shadow-md shadow-primary/25 sm:hidden">
            <Link to="/tasks/new" state={createState} aria-label="New task">
              <Plus aria-hidden="true" />
            </Link>
          </Button>
          <Button
            asChild
            className="ml-1 hidden rounded-full px-4 shadow-md shadow-primary/25 sm:inline-flex"
          >
            <Link to="/tasks/new" state={createState}>
              <Plus aria-hidden="true" />
              New task
            </Link>
          </Button>
        </div>
      </div>

      {/*
        The brand's colours as a hairline: land → water → the amber of "waits
        on you". Decorative, so it sits outside the flow and the tree.
      */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -bottom-px h-px bg-gradient-to-r from-transparent via-[#6fa3ad] to-[#f2a33a]/70 opacity-70"
      />
    </header>
  );
};

/**
 * On the narrowest phones the three segments are icons only — with the project
 * picker beside them there is no room for labels. `sr-only`, not `hidden`, so
 * the link keeps "Tasks" / "Logbook" as its accessible name.
 */
const NAV_LABEL = "sr-only min-[420px]:not-sr-only";

/** One segment of the header's pill nav. Active reads as a raised chip. */
const navItemClassName = (isActive: boolean) =>
  cn(
    "inline-flex min-w-0 flex-auto items-center justify-center gap-1.5 rounded-full px-2.5 py-1.5 sm:px-3 text-sm font-medium transition-all lg:flex-none",
    isActive
      ? "bg-popover text-foreground shadow-raised ring-1 ring-border"
      : "text-muted-foreground hover:bg-muted hover:text-foreground",
  );

/**
 * "Tasks" — back to whichever task view (map or list) the user last used, in
 * the current scope. Active on every `/tasks…` screen except the create form,
 * which has the "New task" button as its own marker.
 */
const TasksLink = ({ project }: { project: string | null }) => {
  const view = useTaskView();
  const { pathname } = useLocation();
  const isActive = pathname.startsWith("/tasks") && pathname !== "/tasks/new";

  return (
    <Link
      to={`${taskViewPath(view)}${projectScopeSearch(project)}`}
      aria-current={isActive ? "page" : undefined}
      className={navItemClassName(isActive)}
    >
      <Waves className="size-4 shrink-0" aria-hidden="true" />
      <span className={NAV_LABEL}>Tasks</span>
    </Link>
  );
};

/**
 * "Inbox", with the number of tasks waiting on a human — in the scoped project,
 * when there is one, so the badge and the page it opens always agree.
 *
 * The count is `stats.needsAttention`, which polls — an agent asking a question
 * lights the badge up on whatever screen the user is on. A failed or pending
 * stats request shows no badge rather than an error: the link still works, and
 * the inbox page has its own error state.
 *
 * The number is in the accessible name as words ("Inbox, 3 waiting on you"),
 * and the visible pill is `aria-hidden`, so it is read once.
 */
const InboxLink = ({ project }: { project: string | null }) => {
  const { data: stats } = useTaskStatsQuery(project === null ? [] : [project]);
  const count = stats?.needsAttention ?? 0;

  return (
    <NavLink
      to={`/inbox${projectScopeSearch(project)}`}
      aria-label={count === 0 ? "Inbox" : `Inbox, ${count} waiting on you`}
      className={({ isActive }) => navItemClassName(isActive)}
    >
      <Inbox className="size-4 shrink-0" aria-hidden="true" />
      <span className={NAV_LABEL}>Inbox</span>
      {count === 0 ? null : (
        <span
          aria-hidden="true"
          className="min-w-5 rounded-full bg-attention px-1.5 text-center text-xs leading-5 font-semibold text-attention-foreground tabular-nums shadow-sm shadow-attention/40"
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </NavLink>
  );
};

/**
 * "Logbook" — the history companion to the floor (`docs/pages/Logbook.md`),
 * scoped the same way the Inbox link is: it carries the current project so a
 * task opened from `web-app`'s Logbook leads back to `web-app`'s.
 */
const LogbookLink = ({ project }: { project: string | null }) => (
  <NavLink
    to={`/logbook${projectScopeSearch(project)}`}
    className={({ isActive }) => navItemClassName(isActive)}
  >
    <History className="size-4 shrink-0" aria-hidden="true" />
    <span className={NAV_LABEL}>Logbook</span>
  </NavLink>
);
