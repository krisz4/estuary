import { ArrowLeft } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { taskViewFromPathname, taskViewPath, useTaskView, type TaskView } from "@/stores/taskView";

/**
 * Back link + eyebrow + title + actions, shared by detail, create, and edit.
 *
 * ## Why the back link reads router state
 *
 * A user arrives here from a filtered, sorted, paged list. `navigate(-1)` would
 * be correct only when the previous history entry *is* that list — it is not
 * after a create (which lands on detail with `replace`), after an edit, or when
 * the URL was pasted. So the list link is reconstructed from
 * `location.state.from`, which the list rows attach as the search string they
 * were rendered under, and falls back to a bare `/tasks` when there is none.
 *
 * The state is validated rather than trusted: `location.state` survives a
 * reload in the browser's history entry and is fully user-writable through
 * `history.pushState`, so a non-string `from` must not reach a `to` prop.
 *
 * ## Why the *pathname* comes from a store instead
 *
 * `state.from` carries the search string across the hop, and only that — so
 * "back to tasks" from a task opened on the map used to land on the list,
 * with the filters intact and the view silently swapped out from under the
 * user. The two screens are two routes, and which one the user is working in is
 * a per-user preference rather than a property of the task, so it lives in
 * `stores/taskView` (which explains the choice at length) and the two halves
 * are combined here: **view decides the path, `state.from` decides the query**.
 */

/**
 * The list URL to return to: the remembered view's route, plus the search
 * string from `location.state.from` when it is one this app could have written.
 */
export const backToListPath = (state: unknown, view: TaskView = "list"): string =>
  `${taskViewPath(view)}${returnSearch(state)}`;

/** `location.state.from` normalised to `"?a=b"`, or `""` when there is none. */
const returnSearch = (state: unknown): string => {
  if (typeof state !== "object" || state === null) return "";
  const from = (state as { from?: unknown }).from;
  if (typeof from !== "string" || from === "") return "";
  return from.startsWith("?") ? from : `?${from}`;
};

/**
 * `backToListPath` bound to the current location and the remembered view.
 *
 * A hook rather than an argument every caller assembles, because forgetting the
 * view is invisible: the link still works, it just quietly returns map users
 * to the list — which is the bug this replaced.
 */
export const useBackToListPath = (): string => {
  const location = useLocation();
  const view = useTaskView();
  return backToListPath(location.state, view);
};

/**
 * The `state` a link *out of* the current screen should carry, so the filtered
 * list survives the round trip.
 *
 * The list rows attach `{ from: search }` themselves; this is for the links that
 * are **not** rendered by the list — chiefly "New task" in `AppHeader`, which
 * is on screen everywhere and therefore has no `search` prop to be handed.
 * Without it, `backToListPath` on the create page has nothing to read and
 * cancelling out of a new task drops every filter the user set.
 *
 * On either view screen the current `search` *is* the state — the map is
 * included, because it renders the same filter bar and the same "New task"
 * header. Anywhere else the page is already carrying a validated `from` (it
 * arrived from a view), and forwarding it keeps the chain intact — detail → new
 * task → cancel still lands on the filtered list.
 *
 * Only the search string travels here. The *view* does not need carrying: it is
 * in the store, which every screen can read directly.
 */
export const listReturnState = (location: {
  pathname: string;
  search: string;
  state: unknown;
}): { from: string } | undefined => {
  if (taskViewFromPathname(location.pathname) !== undefined) {
    return location.search === "" ? undefined : { from: location.search };
  }

  const from = returnSearch(location.state);
  return from === "" ? undefined : { from };
};

export type PageHeaderProps = {
  /** Small muted line above the title — `TASK-000042`, or a section name. */
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Buttons on the right. Wraps below the title at narrow widths. */
  actions?: ReactNode;
  /** Set false on screens that are not reached from the list (the 404). */
  showBackLink?: boolean;
  className?: string;
};

export const PageHeader = ({
  eyebrow,
  title,
  description,
  actions,
  showBackLink = true,
  className,
}: PageHeaderProps) => {
  const backPath = useBackToListPath();

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {showBackLink ? (
        <Link
          to={backPath}
          className="inline-flex w-fit items-center gap-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to tasks
        </Link>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          {eyebrow === undefined ? null : (
            <p className="font-mono text-xs tracking-wide text-muted-foreground">{eyebrow}</p>
          )}
          <h1 className="text-2xl font-semibold break-words text-foreground">{title}</h1>
          {description === undefined ? null : (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>

        {actions === undefined ? null : (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        )}
      </div>
    </div>
  );
};
