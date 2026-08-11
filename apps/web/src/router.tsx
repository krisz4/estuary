import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { NotFoundPage } from "@/pages/not-found/NotFoundPage";
import { StagePlaceholderPage } from "@/pages/StagePlaceholderPage";
import { TicketsListPage } from "@/pages/tickets-list/TicketsListPage";

/**
 * The route table. Documented per screen in `docs/pages/`.
 *
 * **`/tickets/new` is declared before `/tickets/:ticketId`.** React Router 7
 * ranks routes by specificity rather than by declaration order, so it happens to
 * resolve correctly either way today — but the ordering is written down as the
 * rule in `docs/pages/README.md` and in the implementation plan, and relying on
 * a ranking algorithm to save a mis-ordered table is a bet on an implementation
 * detail. Written in the safe order, both mechanisms agree.
 *
 * Every route sits under `AppLayout`, including the catch-all: a 404 that loses
 * the header leaves the user with no way out but the back button.
 */
export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/tickets" replace /> },

      { path: "tickets", element: <TicketsListPage /> },

      {
        path: "tickets/new",
        element: (
          <StagePlaceholderPage
            title="New ticket"
            stage="Stage 12"
            summary="The create form, sharing TicketForm with the edit page and validating through the contract schema."
          />
        ),
      },

      {
        path: "tickets/:ticketId",
        element: (
          <StagePlaceholderPage
            title="Ticket detail"
            stage="Stage 12"
            summary="Detail view with the comment thread, status control, and delete confirmation."
          />
        ),
      },

      {
        path: "tickets/:ticketId/edit",
        element: (
          <StagePlaceholderPage
            title="Edit ticket"
            stage="Stage 12"
            summary="The edit form — TicketForm generalised to a partial PATCH."
          />
        ),
      },

      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);
