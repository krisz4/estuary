import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { NotFoundPage } from "@/pages/not-found/NotFoundPage";
import { TicketCreatePage } from "@/pages/ticket-create/TicketCreatePage";
import { TicketDetailPage } from "@/pages/ticket-detail/TicketDetailPage";
import { TicketEditPage } from "@/pages/ticket-edit/TicketEditPage";
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

      { path: "tickets/new", element: <TicketCreatePage /> },

      { path: "tickets/:ticketId", element: <TicketDetailPage /> },

      { path: "tickets/:ticketId/edit", element: <TicketEditPage /> },

      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);
