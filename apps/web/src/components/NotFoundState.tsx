import { SearchX } from "lucide-react";
import { Link } from "react-router-dom";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui";

/**
 * A *matched* route whose resource is gone — `/tickets/999999`, or a ticket
 * deleted in another tab and hit again on the next refetch.
 *
 * Distinct from `NotFoundPage` on purpose (`docs/pages/Not_Found.md`): the route
 * is legitimate and the useful message is about the ticket, not about the URL.
 * It is also not a toast — a toast disappears and leaves a blank page behind.
 */
export const NotFoundState = ({
  title = "This ticket doesn't exist",
  description = "It may have been deleted, or the number in the address is wrong.",
}: {
  title?: string;
  description?: string;
}) => (
  <EmptyState
    icon={SearchX}
    title={title}
    description={description}
    action={
      <Button asChild variant="outline">
        <Link to="/tickets">Back to tickets</Link>
      </Button>
    }
  />
);
