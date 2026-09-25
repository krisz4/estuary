import {
  hasAtLeastOneField,
  ticketIdParamSchema,
  type Ticket,
  type UpdateTicketInput,
} from "@helpdesk/contracts";
import { useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { isApiClientError } from "@/api/http";
import { useTicketQuery, useUpdateTicketMutation } from "@/api/tickets";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorPanel } from "@/components/ErrorPanel";
import { NotFoundState } from "@/components/NotFoundState";
import { PageHeader } from "@/components/PageHeader";
import {
  TicketForm,
  type TicketFormHelpers,
  type TicketFormValues,
} from "@/features/tickets/TicketForm";
import { formatAbsolute, formatDate } from "@/lib/formatting";
import { errorCopy } from "@/lib/errorMessages";
import { statusChangeErrorMessage } from "@/lib/statusTransition";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { useUnsavedChangesGuard } from "@/lib/useUnsavedChangesGuard";
import { DetailField } from "@/pages/ticket-detail/DetailField";
import { FormSkeleton } from "@/pages/ticket-edit/FormSkeleton";

/**
 * `/tickets/:ticketId/edit` — spec: `docs/pages/Ticket_Edit.md`. Task 4.5.
 *
 * The same `TicketForm` as create, in `mode="edit"`. What this page adds is the
 * **diff**: only fields whose value actually changed are PATCHed.
 *
 * That is not an optimisation. `PATCH` is partial by contract
 * (`docs/features/Tickets.md`), so sending the whole object would write eight
 * fields every save — and would clobber a concurrent change to a field this user
 * never touched with the value that was on screen when the page loaded.
 */
export const TicketEditPage = () => {
  const { ticketId: raw } = useParams();
  const parsed = ticketIdParamSchema.safeParse(raw);

  if (!parsed.success) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Edit ticket" />
        <NotFoundState description="That address does not contain a valid ticket number." />
      </div>
    );
  }

  return <TicketEditView ticketId={parsed.data} />;
};

const TicketEditView = ({ ticketId }: { ticketId: number }) => {
  const navigate = useNavigate();
  const location = useLocation();

  const [isDirty, setDirty] = useState(false);
  const [isDiscardOpen, setDiscardOpen] = useState(false);

  const { blocker, allowNavigation } = useUnsavedChangesGuard(isDirty);

  const { data: ticket, error, isPending, isFetching, refetch } = useTicketQuery(ticketId);
  const mutation = useUpdateTicketMutation(ticketId);

  useDocumentTitle(ticket === undefined ? undefined : `Edit ${ticket.reference}`);

  /**
   * `replace`, for the same reason `save()` below uses it: this page's history
   * entry is a form the user has finished with. Pushing over it makes Back land
   * *inside the edit form again* — from `/tickets/42` → Edit → Cancel the stack
   * would read `[list, detail, edit, detail]`, so one Back press reopens the
   * form they just abandoned, and a second returns to the detail page they were
   * already on. Cancel and save leave by the same door.
   */
  const backToTicket = () => {
    allowNavigation();
    void navigate(`/tickets/${ticketId}`, { replace: true, state: location.state });
  };

  if (isPending) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Edit ticket" />
        <FormSkeleton />
      </div>
    );
  }

  if (isApiClientError(error) && error.code === "TICKET_NOT_FOUND") {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Edit ticket" />
        <NotFoundState />
      </div>
    );
  }

  if (ticket === undefined) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Edit ticket" />
        <ErrorPanel error={error} onRetry={() => void refetch()} isRetrying={isFetching} />
      </div>
    );
  }

  const save = (patch: UpdateTicketInput, helpers: TicketFormHelpers) => {
    mutation.mutate(patch, {
      onSuccess: () => {
        allowNavigation();
        toast.success("Changes saved");
        void navigate(`/tickets/${ticketId}`, { replace: true, state: location.state });
      },
      onError: (saveError) => {
        // `details` → fields, unknown keys → summary. Never a direct map.
        helpers.applyServerError(saveError);

        // The 409 is not a VALIDATION_ERROR and carries no `details` map,
        // but it does have an obvious home: the status control. Everything
        // else the user typed stays in the form.
        if (isApiClientError(saveError) && saveError.code === "INVALID_STATUS_TRANSITION") {
          const message = statusChangeErrorMessage(saveError);
          if (message !== undefined) helpers.setFieldError("status", message);
          return;
        }

        if (!isApiClientError(saveError) || saveError.code !== "VALIDATION_ERROR") {
          const copy = errorCopy(saveError);
          toast.error(copy.title, { description: copy.description });
        }
      },
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={ticket.reference} title={`Edit ${ticket.reference}`} />

      {/*
        Mounted only once the ticket is here, so `defaultValues` are the real
        ones. A form that renders empty and repopulates in an effect fights
        anything already typed into it — the page doc calls this out explicitly.
      */}
      <TicketEditForm
        ticket={ticket}
        isSubmitting={mutation.isPending}
        onDirtyChange={setDirty}
        onCancel={() => {
          if (isDirty) {
            setDiscardOpen(true);
            return;
          }
          backToTicket();
        }}
        onSave={save}
      />

      {/*
        Read-only metadata as a `<dl>`, not disabled inputs. A disabled input is
        skipped by screen readers and reads as something you failed to enable.
      */}
      <dl className="grid max-w-2xl grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-4">
        <DetailField label="Ticket">{ticket.reference}</DetailField>
        <DetailField label="Created">
          <span title={formatAbsolute(ticket.createdAt)}>{formatDate(ticket.createdAt)}</span>
        </DetailField>
        <DetailField label="Resolved">
          {ticket.resolvedAt === null ? "—" : formatDate(ticket.resolvedAt)}
        </DetailField>
        <DetailField label="Closed">
          {ticket.closedAt === null ? "—" : formatDate(ticket.closedAt)}
        </DetailField>
      </dl>

      <ConfirmDialog
        open={isDiscardOpen || blocker.state === "blocked"}
        onOpenChange={(open) => {
          if (open) return;
          setDiscardOpen(false);
          if (blocker.state === "blocked") blocker.reset();
        }}
        title="Discard your changes?"
        description="You have unsaved changes to this ticket. Leaving now loses them."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        onConfirm={() => {
          setDiscardOpen(false);
          if (blocker.state === "blocked") {
            allowNavigation();
            blocker.proceed();
            return;
          }
          backToTicket();
        }}
      />
    </div>
  );
};

type TicketEditFormProps = {
  ticket: Ticket;
  isSubmitting: boolean;
  onDirtyChange: (isDirty: boolean) => void;
  onCancel: () => void;
  onSave: (patch: UpdateTicketInput, helpers: TicketFormHelpers) => void;
};

/**
 * The form, plus the **snapshot the form was initialised from**.
 *
 * This component exists for `baselineRef` and nothing else. react-hook-form
 * reads `defaultValues` exactly once, at mount, so the form's own idea of "what
 * was on screen when I loaded" is frozen there — while `ticket` is live query
 * data that keeps moving underneath it. With `staleTime: 30_000` and
 * `refetchOnMount`, opening a detail page, reading for a minute and clicking
 * Edit mounts this form from the stale cache while a refetch is already in
 * flight.
 *
 * Diffing the frozen control values against the *refetched* ticket is worse
 * than not diffing at all: a field the user never touched (`assignee`, still
 * `""` in the form because it was `null` at mount) now differs from a value
 * somebody else just wrote (`"Marcus Feld"`), so the diff PATCHes
 * `assignee: null` and silently destroys their edit — the exact loss the diff
 * exists to prevent.
 *
 * `useRef(ticket)` initialises on the first render of this component and is
 * never reassigned. The parent renders a skeleton until the ticket is here, so
 * that first render is the same one that produced `defaultValues`; the two
 * cannot drift apart.
 */
const TicketEditForm = ({
  ticket,
  isSubmitting,
  onDirtyChange,
  onCancel,
  onSave,
}: TicketEditFormProps) => {
  const baselineRef = useRef(ticket);

  return (
    <TicketForm
      mode="edit"
      /*
        `ticket`, not `baselineRef.current` — reading a ref during render is
        exactly what the lint rule forbids, and here the two are the same
        value: the ref was initialised from this prop on this render, and
        react-hook-form reads `defaultValues` only on that first one. Every
        later render passes a value the form ignores. The **submit** path,
        which runs in a handler, reads the ref.
      */
      defaultValues={toFormValues(ticket)}
      isSubmitting={isSubmitting}
      submitLabel="Save changes"
      onDirtyChange={onDirtyChange}
      onCancel={onCancel}
      onSubmit={(values, helpers) => {
        const patch = diffTicketPatch(values as UpdateTicketInput, baselineRef.current);

        // The server would answer `AT_LEAST_ONE_FIELD` (422) for an empty
        // patch. Short-circuiting is not about saving the round trip: a toast
        // reading "Nothing to save" is the honest answer, where the server's
        // 422 would surface as a red error for a harmless action.
        if (!hasAtLeastOneField(patch)) {
          toast.info("No changes to save");
          return;
        }

        onSave(patch, helpers);
      }}
    />
  );
};

/** Ticket → the controls' shape. `null` becomes `""`; the schema maps it back. */
export const toFormValues = (ticket: Ticket): TicketFormValues => ({
  title: ticket.title,
  description: ticket.description,
  status: ticket.status,
  priority: ticket.priority,
  category: ticket.category ?? "",
  requesterName: ticket.requesterName,
  requesterEmail: ticket.requesterEmail,
  assignee: ticket.assignee ?? "",
});

/**
 * The parsed form output minus everything that still equals the ticket the form
 * was **initialised from** (`TicketEditForm`'s `baselineRef`, never live query
 * data — see that component).
 *
 * Compared against a **ticket**, not against the raw `defaultValues`, and that
 * distinction is the point: both sides of the comparison are then in the
 * server's own canonical shape (`null` for an empty optional, a trimmed title, a
 * lowercased email), so "the user typed a trailing space" is correctly *not* a
 * change. Comparing the raw control values would send `title` on every save that
 * touched the title field at all.
 */
export const diffTicketPatch = (values: UpdateTicketInput, ticket: Ticket): UpdateTicketInput => {
  const current: UpdateTicketInput = {
    title: ticket.title,
    description: ticket.description,
    status: ticket.status,
    priority: ticket.priority,
    category: ticket.category,
    requesterName: ticket.requesterName,
    requesterEmail: ticket.requesterEmail,
    assignee: ticket.assignee,
  };

  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== (current as Record<string, unknown>)[key]) patch[key] = value;
  }
  return patch as UpdateTicketInput;
};
