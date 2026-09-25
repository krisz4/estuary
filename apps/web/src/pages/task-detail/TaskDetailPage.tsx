import { ticketIdParamSchema, type Ticket, type TicketStatus } from "@helpdesk/contracts";
import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { isApiClientError } from "@/api/http";
import { useDeleteTicketMutation, useTicketQuery, useTicketStatusMutation } from "@/api/tickets";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorPanel } from "@/components/ErrorPanel";
import { NotFoundState } from "@/components/NotFoundState";
import { PageHeader, useBackToListPath } from "@/components/PageHeader";
import { Button } from "@/components/ui";
import { CommentThread } from "@/features/comments/CommentThread";
import { PriorityBadge } from "@/features/tickets/PriorityBadge";
import { StatusSelect } from "@/features/tickets/StatusSelect";
import { errorCopy } from "@/lib/errorMessages";
import {
  formatAbsolute,
  formatRelative,
  TICKET_CATEGORY_LABELS,
  TICKET_STATUS_LABELS,
  toDateTimeAttribute,
} from "@/lib/formatting";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { DetailField } from "@/pages/ticket-detail/DetailField";
import { DetailSkeleton } from "@/pages/ticket-detail/DetailSkeleton";

/**
 * `/tickets/:ticketId` — spec: `docs/pages/Ticket_Detail.md`.
 *
 * A page, not a modal, so the URL is shareable (task 4.2 of the brief).
 *
 * The id is parsed with **`ticketIdParamSchema` from the contracts package** —
 * the same schema the API's route uses. Two parsers for one concept is how
 * `/tickets/0000000000000000042` came to resolve differently from
 * `?q=0000000000000000042` on the server side (stage 8); the client has no
 * business inventing a third.
 */
export const TicketDetailPage = () => {
  const { ticketId: raw } = useParams();
  const parsed = ticketIdParamSchema.safeParse(raw);

  /*
    Split into two components rather than gating a hook with `enabled`. A
    malformed id has no request to make and no cache entry to hold, and the
    alternative — one component whose query key contains a sentinel id — puts an
    entry for a ticket that cannot exist into the cache.
  */
  if (!parsed.success) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Ticket" showBackLink />
        <NotFoundState description="That address does not contain a valid ticket number." />
      </div>
    );
  }

  return <TicketDetailView ticketId={parsed.data} />;
};

const TicketDetailView = ({ ticketId }: { ticketId: number }) => {
  const navigate = useNavigate();
  const location = useLocation();

  // Read before the early returns: the delete handler needs the same
  // destination the header's back link points at, and hooks cannot be called
  // below the loading and error branches.
  const backPath = useBackToListPath();

  const [isDeleteOpen, setDeleteOpen] = useState(false);
  const [statusError, setStatusError] = useState<unknown>(null);
  const [statusAnnouncement, setStatusAnnouncement] = useState("");

  const { data: ticket, error, isPending, isFetching, refetch } = useTicketQuery(ticketId);

  const statusMutation = useTicketStatusMutation(ticketId);
  const deleteMutation = useDeleteTicketMutation();

  useDocumentTitle(ticket === undefined ? undefined : ticket.reference);

  const isMissing = isApiClientError(error) && error.code === "TICKET_NOT_FOUND";

  if (isPending) return <DetailSkeleton />;

  if (isMissing) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Ticket" />
        <NotFoundState />
      </div>
    );
  }

  if (ticket === undefined) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Ticket" />
        <ErrorPanel error={error} onRetry={() => void refetch()} isRetrying={isFetching} />
      </div>
    );
  }

  const changeStatus = (next: TicketStatus) => {
    setStatusError(null);
    statusMutation.mutate(next, {
      onSuccess: (updated) => {
        setStatusAnnouncement(`Status changed to ${TICKET_STATUS_LABELS[updated.status]}`);
        toast.success(`${updated.reference} is now ${TICKET_STATUS_LABELS[updated.status]}`);
      },
      onError: (mutationError) => {
        // Inline next to the control, not a toast: the 409 names which targets
        // are legal, and that belongs beside the control the user is about to
        // use again. `useTicketStatusMutation` has already rolled the optimistic
        // value back by the time this runs.
        setStatusError(mutationError);
      },
    });
  };

  const confirmDelete = () => {
    deleteMutation.mutate(ticketId, {
      onSuccess: () => {
        setDeleteOpen(false);
        toast.success(`${ticket.reference} deleted`);
        void navigate(backPath, { replace: true });
      },
      onError: (deleteError) => {
        setDeleteOpen(false);
        const copy = errorCopy(deleteError);
        toast.error(copy.title, { description: copy.description });
      },
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={ticket.reference}
        title={ticket.title}
        actions={
          <>
            <Button asChild variant="outline">
              <Link to={`/tickets/${ticket.id}/edit`} state={location.state}>
                <Pencil aria-hidden="true" />
                Edit
              </Link>
            </Button>
            <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2 aria-hidden="true" />
              Delete
            </Button>
          </>
        }
      />

      {/* Polite, so it does not interrupt — the change is already visible. */}
      <p aria-live="polite" className="sr-only">
        {statusAnnouncement}
      </p>

      {/*
        Below `md` the summary comes FIRST, then the description and thread.
        With source order alone, a phone user has to scroll past the whole
        comment thread and the composer to find out what status the ticket is
        in — the thing they most likely opened it for. `order` flips the two
        without duplicating either, and the DOM order stays main-then-aside so
        the reading order above `md` matches the visual one.
      */}
      <div className="flex flex-col gap-8 md:flex-row md:items-start">
        <div className="order-2 flex min-w-0 flex-1 flex-col gap-8 md:order-1">
          <section aria-labelledby="description-heading" className="flex flex-col gap-2">
            <h2 id="description-heading" className="text-base font-semibold text-foreground">
              Description
            </h2>
            {/*
              A text node with `whitespace-pre-wrap`. The requester's line breaks
              survive; their angle brackets are displayed, not parsed. There is
              no `dangerouslySetInnerHTML` anywhere in this app.
            */}
            <p className="text-sm whitespace-pre-wrap text-foreground">{ticket.description}</p>
          </section>

          <CommentThread ticketId={ticket.id} comments={ticket.comments} />
        </div>

        <aside className="order-1 flex w-full flex-col gap-5 md:order-2 md:w-72 md:shrink-0">
          <StatusSelect
            value={ticket.status}
            onChange={changeStatus}
            isPending={statusMutation.isPending}
            error={statusError}
          />

          {/*
            No "Status" row in this list. `StatusSelect` above already shows the
            current status *and* is the control that changes it — a `StatusBadge`
            repeating the same word 40px below it reads as two different facts
            about the ticket. The badge still belongs on the list page, where
            there is no control to carry the value.
          */}
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-1">
            <DetailField label="Priority">
              <PriorityBadge priority={ticket.priority} />
            </DetailField>
            <DetailField label="Category">
              {ticket.category === null ? (
                <span className="text-muted-foreground">Uncategorised</span>
              ) : (
                TICKET_CATEGORY_LABELS[ticket.category]
              )}
            </DetailField>
            <DetailField label="Requester">
              <span className="block">{ticket.requesterName}</span>
              <a
                href={`mailto:${ticket.requesterEmail}`}
                className="text-primary hover:underline"
                // Long addresses must wrap rather than widen the 288px aside.
                style={{ overflowWrap: "anywhere" }}
              >
                {ticket.requesterEmail}
              </a>
            </DetailField>
            <DetailField label="Assignee">
              {ticket.assignee === null ? (
                <span className="text-muted-foreground">Unassigned</span>
              ) : (
                ticket.assignee
              )}
            </DetailField>
            <DetailField label="Created">
              <TimeValue iso={ticket.createdAt} />
            </DetailField>
            <DetailField label="Updated">
              <TimeValue iso={ticket.updatedAt} />
            </DetailField>
            {ticket.resolvedAt === null ? null : (
              <DetailField label="Resolved">
                <TimeValue iso={ticket.resolvedAt} />
              </DetailField>
            )}
            {ticket.closedAt === null ? null : (
              <DetailField label="Closed">
                <TimeValue iso={ticket.closedAt} />
              </DetailField>
            )}
          </dl>
        </aside>
      </div>

      <ConfirmDialog
        open={isDeleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${ticket.reference}?`}
        description={deleteDescription(ticket)}
        confirmLabel="Delete ticket"
        isPending={deleteMutation.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
};

/** "Delete HD-000042? This also deletes its 3 comments. This can't be undone." */
const deleteDescription = (ticket: Ticket): string => {
  const count = ticket.comments.length;
  const comments =
    count === 0 ? "" : ` This also deletes its ${count} ${count === 1 ? "comment" : "comments"}.`;
  return `${ticket.title}.${comments} This can't be undone.`;
};

const TimeValue = ({ iso }: { iso: string }) => (
  <time dateTime={toDateTimeAttribute(iso)} title={formatAbsolute(iso)}>
    {formatRelative(iso)}
  </time>
);
