# Page specs index

One doc per UI route in `apps/web`. Parent index: [../README.md](../README.md). Agent entry: [../AGENTS.md](../AGENTS.md).

Each doc has YAML frontmatter (`type: Page`, `title`, `description`, `tags`, optional `resource` / `status`) and follows the body shape in [AGENTS.md](../AGENTS.md#page-doc-body-preferred-shape): Route → Dependencies → Behavior → States → Responsive → Accessibility → Related.

## Routes

| Route | Doc | Description |
| ----- | --- | ----------- |
| *(all)* | [App_Shell.md](./App_Shell.md) | Layout, header, providers, toaster, error boundary |
| `/` → `/tickets` | [Tickets_List.md](./Tickets_List.md) | Ticket list with filtering, sorting, paging |
| `/tickets/new` | [Ticket_Create.md](./Ticket_Create.md) | Create a ticket |
| `/tickets/:ticketId` | [Ticket_Detail.md](./Ticket_Detail.md) | Detail view, status change, comments, delete |
| `/tickets/:ticketId/edit` | [Ticket_Edit.md](./Ticket_Edit.md) | Edit an existing ticket |
| `*` | [Not_Found.md](./Not_Found.md) | Unmatched routes |

Route order matters: `/tickets/new` is declared **before** `/tickets/:ticketId` so `new` is not parsed as an id.

## Conventions across all pages

- Server state via TanStack Query only; query keys from `apps/web/src/api/queryKeys.ts`.
- List state lives in the URL — see [../features/Ticket_Query_Filter_Sort_Page.md](../features/Ticket_Query_Filter_Sort_Page.md).
- Every async view wires **loading, error (with retry), and empty** states.
- Forms use react-hook-form with the zod resolver from `packages/contracts`.
- Responsive is checked at 360px, 768px, and 1280px. Layout rules: [../engineering/UI_DESIGN_GUIDELINES.md](../engineering/UI_DESIGN_GUIDELINES.md).

## Related

- Domain behavior behind these screens: [../features/README.md](../features/README.md)
