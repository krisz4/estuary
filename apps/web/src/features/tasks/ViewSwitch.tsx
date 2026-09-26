import { List, Map as MapIcon } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { cn } from "@/lib/cn";
import { taskViewFromPathname, taskViewPath } from "@/stores/taskView";

/**
 * List ⇄ Map, as two links rather than a toggle button.
 *
 * They are two URLs, so they are two `<a>`s: middle-click, ⌘-click, and
 * "copy link address" all keep working, and the browser — not a click handler
 * — decides what a click does. A `<button onClick={navigate}>` would look
 * identical and lose all three.
 *
 * **The search string rides along.** Both screens read the same filters
 * out of the URL through `useTaskListParams()` (the Map also reads its own
 * `group` / `links` / `match` / `shipped` / `fold` / `at` on top), so switching
 * view has to preserve them or every filter a user set is silently dropped by
 * the act of looking at the same data a different way.
 *
 * `aria-current="page"` marks the active view. It is the attribute a screen
 * reader announces for "you are here"; a class name is not.
 *
 * **No link writes the remembered view.** That happens when the target page
 * mounts (`useRememberTaskView`), so arriving by pasted URL, bookmark or back
 * button records the same thing a click does. See `stores/taskView.ts`.
 */

const LINK_CLASS =
  "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition-colors";

export type ViewSwitchProps = {
  className?: string;
};

export const ViewSwitch = ({ className }: ViewSwitchProps) => {
  const { pathname, search } = useLocation();
  const view = taskViewFromPathname(pathname) ?? "list";

  const tab = (target: "list" | "map", label: string, Icon: typeof List) => (
    <Link
      to={{ pathname: taskViewPath(target), search }}
      aria-current={view === target ? "page" : undefined}
      className={cn(
        LINK_CLASS,
        view === target
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
      {label}
    </Link>
  );

  return (
    <nav
      aria-label="Task view"
      className={cn("inline-flex rounded-lg border border-border bg-card p-0.5", className)}
    >
      {tab("list", "List", List)}
      {tab("map", "Map", MapIcon)}
    </nav>
  );
};
