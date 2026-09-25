import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui";
import { useDocumentTitle } from "@/lib/useDocumentTitle";

/**
 * `*` — unmatched routes. Spec: `docs/pages/Not_Found.md`.
 *
 * Renders inside `AppLayout`, so the header and skip link stay available: a 404
 * that loses the chrome leaves the user with no way out but the back button.
 *
 * **Only for unmatched routes.** A matched route whose resource is missing —
 * `/tasks/999999` — renders `NotFoundState` on the detail page instead,
 * because "this task was deleted" is more useful than a generic 404 and the
 * route itself is legitimate.
 */
/**
 * Is there an entry behind this one that `navigate(-1)` can reach?
 *
 * Two independent signals, because either alone is wrong:
 *
 * - `location.key !== "default"` means React Router pushed this entry itself,
 *   so the previous one is an in-app screen. It is `"default"` for the first
 *   location of a session — which is the *usual* way a 404 is reached.
 * - `history.state.idx > 0` catches the reload case, where the key resets to
 *   `"default"` but the browser's own stack still has entries behind it. (React
 *   Router maintains `idx`; it is absent for an entry it never wrote.)
 */
const hasPreviousEntry = (locationKey: string): boolean => {
  if (locationKey !== "default") return true;
  if (typeof window === "undefined") return false;

  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" && idx > 0;
};

export const NotFoundPage = () => {
  useDocumentTitle("Page not found");

  const location = useLocation();
  const navigate = useNavigate();
  const primaryRef = useRef<HTMLAnchorElement>(null);

  /*
    Snapshotted at mount rather than read per render: `window.history` is not
    React state, and the answer cannot change while this page is on screen.

    The button is *not rendered at all* when there is nothing behind us. A 404 is
    normally reached by pasting or mistyping a URL, which makes it the first
    entry of the session — `navigate(-1)` there either does nothing (looks
    broken) or leaves the app entirely (worse).
  */
  const [canGoBack] = useState(() => hasPreviousEntry(location.key));

  // Focused on mount so a keyboard user can leave with one keystroke.
  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-3 py-12 sm:py-16">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Error 404</p>
      <h1 className="text-2xl font-semibold text-foreground">Page not found</h1>

      <p className="text-sm text-muted-foreground">
        Nothing in this app answers to{" "}
        {/*
          A text node inside <code>, never innerHTML. This string comes straight
          from the address bar, which is the most user-controlled input the app
          has — `/<img src=x onerror=alert(1)>` must be displayed, not run.
        */}
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all text-foreground">
          {location.pathname}
        </code>
        . It may have been mistyped, or the page it pointed at no longer exists.
      </p>

      <div className="mt-2 flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
        <Button asChild>
          <Link to="/tasks" ref={primaryRef}>
            Back to tasks
          </Link>
        </Button>
        {canGoBack ? (
          <Button variant="outline" onClick={() => void navigate(-1)}>
            Go back
          </Button>
        ) : null}
      </div>
    </div>
  );
};
