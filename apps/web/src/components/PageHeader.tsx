import { ArrowLeft } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { type ReactNode } from "react";
import { cn } from "@/lib/cn";

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
 * were rendered under, and falls back to a bare `/tickets` when there is none.
 *
 * The state is validated rather than trusted: `location.state` survives a
 * reload in the browser's history entry and is fully user-writable through
 * `history.pushState`, so a non-string `from` must not reach a `to` prop.
 */

/** `location.state.from`, when it is a search string this app could have written. */
export const backToListPath = (state: unknown): string => {
  if (typeof state !== "object" || state === null) return "/tickets";
  const from = (state as { from?: unknown }).from;
  if (typeof from !== "string" || from === "") return "/tickets";
  return `/tickets${from.startsWith("?") ? from : `?${from}`}`;
};

/**
 * The `state` a link *out of* the current screen should carry, so the filtered
 * list survives the round trip.
 *
 * The list rows attach `{ from: search }` themselves; this is for the links that
 * are **not** rendered by the list — chiefly "New ticket" in `AppHeader`, which
 * is on screen everywhere and therefore has no `search` prop to be handed.
 * Without it, `backToListPath` on the create page has nothing to read and
 * cancelling out of a new ticket drops every filter the user set.
 *
 * On the list itself the current `search` *is* the state. Anywhere else the page
 * is already carrying a validated `from` (it arrived from the list), and
 * forwarding it keeps the chain intact — detail → new ticket → cancel still
 * lands on the filtered list.
 */
export const listReturnState = (location: {
  pathname: string;
  search: string;
  state: unknown;
}): { from: string } | undefined => {
  if (location.pathname === "/tickets") {
    return location.search === "" ? undefined : { from: location.search };
  }

  const path = backToListPath(location.state);
  return path === "/tickets" ? undefined : { from: path.slice("/tickets".length) };
};

export type PageHeaderProps = {
  /** Small muted line above the title — `HD-000042`, or a section name. */
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
  const location = useLocation();

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {showBackLink ? (
        <Link
          to={backToListPath(location.state)}
          className="inline-flex w-fit items-center gap-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to tickets
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
