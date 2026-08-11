import { type CreateTicketInput } from "@helpdesk/contracts";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { isApiClientError } from "@/api/http";
import { useCreateTicketMutation } from "@/api/tickets";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { backToListPath, PageHeader } from "@/components/PageHeader";
import { emptyTicketFormValues, TicketForm } from "@/features/tickets/TicketForm";
import { errorCopy } from "@/lib/errorMessages";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { useUnsavedChangesGuard } from "@/lib/useUnsavedChangesGuard";

/**
 * `/tickets/new` — spec: `docs/pages/Ticket_Create.md`. Task 4.3 of the brief.
 *
 * Success navigates with **`replace`**: the entry this page occupies is a form
 * whose submission already happened, so leaving it in the history stack means
 * Back re-opens a form that would create a second ticket if resubmitted. Replace
 * makes Back go to the list, which is where the user came from.
 *
 * `state` is forwarded to the detail page so the filtered list the user started
 * from is still one click away after creating a ticket.
 */
export const TicketCreatePage = () => {
  useDocumentTitle("New ticket");

  const navigate = useNavigate();
  const location = useLocation();

  const [isDirty, setDirty] = useState(false);
  const [isDiscardOpen, setDiscardOpen] = useState(false);

  const { blocker, allowNavigation } = useUnsavedChangesGuard(isDirty);
  const mutation = useCreateTicketMutation();

  const leave = () => {
    allowNavigation();
    void navigate(backToListPath(location.state));
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="New ticket"
        description="Describe the problem. Everything here can be edited later."
      />

      <TicketForm
        mode="create"
        defaultValues={emptyTicketFormValues()}
        isSubmitting={mutation.isPending}
        submitLabel="Create ticket"
        onDirtyChange={setDirty}
        onCancel={() => {
          if (isDirty) {
            setDiscardOpen(true);
            return;
          }
          leave();
        }}
        onSubmit={(values, helpers) => {
          mutation.mutate(values as CreateTicketInput, {
            onSuccess: (ticket) => {
              allowNavigation();
              toast.success(`Ticket ${ticket.reference} created`);
              void navigate(`/tickets/${ticket.id}`, { replace: true, state: location.state });
            },
            onError: (error) => {
              // Maps `details` onto the fields it recognises, and everything
              // else into the summary. The typed values are untouched either
              // way — nothing on this path resets the form.
              helpers.applyServerError(error);

              // A 422 is on screen already. Anything else has no other home.
              if (!isApiClientError(error) || error.code !== "VALIDATION_ERROR") {
                const copy = errorCopy(error);
                toast.error(copy.title, { description: copy.description });
              }
            },
          });
        }}
      />

      <ConfirmDialog
        open={isDiscardOpen || blocker.state === "blocked"}
        onOpenChange={(open) => {
          if (open) return;
          setDiscardOpen(false);
          if (blocker.state === "blocked") blocker.reset();
        }}
        title="Discard this ticket?"
        description="You have unsaved changes. Leaving now loses everything typed here."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        onConfirm={() => {
          setDiscardOpen(false);
          if (blocker.state === "blocked") {
            allowNavigation();
            blocker.proceed();
            return;
          }
          leave();
        }}
      />
    </div>
  );
};
