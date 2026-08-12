import { Columns3, List } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { cn } from "@/lib/cn";

/**
 * List ⇄ Board, as two links rather than a toggle button.
 *
 * They are two URLs, so they are two `<a>`s: middle-click, ⌘-click, and "copy
 * link address" all keep working, and the browser — not a click handler —
 * decides what a click does. A `<button onClick={navigate}>` would look
 * identical and lose all three.
 *
 * **The search string rides along.** Both screens read the same filters out of
 * the URL through `useTicketListParams`, so switching view has to preserve them
 * or every filter a user set is silently dropped by the act of looking at the
 * same data a different way. The two keys the board does not use — `page` and
 * `status` — are deliberately *kept* rather than stripped: they are still valid
 * on the list, and dropping them here would mean switching to the board and back
 * loses the page you were on.
 *
 * `aria-current="page"` marks the active view. It is the attribute a screen
 * reader announces for "you are here"; a class name is not.
 */

const LINK_CLASS =
  "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition-colors";

export type ViewSwitchProps = {
  className?: string;
};

export const ViewSwitch = ({ className }: ViewSwitchProps) => {
  const { pathname, search } = useLocation();
  const isBoard = pathname === "/tickets/board";

  return (
    <nav
      aria-label="Ticket view"
      className={cn("inline-flex rounded-lg border border-border bg-card p-0.5", className)}
    >
      <Link
        to={{ pathname: "/tickets", search }}
        aria-current={isBoard ? undefined : "page"}
        className={cn(
          LINK_CLASS,
          isBoard ? "text-muted-foreground hover:text-foreground" : "bg-muted text-foreground",
        )}
      >
        <List className="size-4" aria-hidden="true" />
        List
      </Link>

      <Link
        to={{ pathname: "/tickets/board", search }}
        aria-current={isBoard ? "page" : undefined}
        className={cn(
          LINK_CLASS,
          isBoard ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Columns3 className="size-4" aria-hidden="true" />
        Board
      </Link>
    </nav>
  );
};
