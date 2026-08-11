import { Link } from "react-router-dom";
import { Button } from "@/components/ui";
import { useDocumentTitle } from "@/lib/useDocumentTitle";

/**
 * Unmatched routes. Fully specified in `docs/pages/Not_Found.md`; this is the
 * stage-10 version — a real page, not a placeholder, because the router needs a
 * catch-all from the moment it exists and a `null` there is a blank screen.
 */
export const NotFoundPage = () => {
  useDocumentTitle("Page not found");

  return (
    <div className="mx-auto flex max-w-lg flex-col items-start gap-3 py-12">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Error 404</p>
      <h1 className="text-2xl font-semibold text-foreground">Page not found</h1>
      <p className="text-sm text-muted-foreground">
        That address does not match any screen in this app. It may have been mistyped, or the ticket
        it pointed at was deleted.
      </p>
      <Button asChild className="mt-2">
        <Link to="/tickets">Back to tickets</Link>
      </Button>
    </div>
  );
};
