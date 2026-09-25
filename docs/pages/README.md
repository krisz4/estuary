# Page specs index

One doc per UI route in `apps/web`. Parent index: [../README.md](../README.md). Agent entry: [../AGENTS.md](../AGENTS.md).

Each doc has YAML frontmatter (`type: Page`, `title`, `description`, `tags`, optional `resource` / `status`) and follows the body shape in [AGENTS.md](../AGENTS.md#page-doc-body-preferred-shape): Route → Dependencies → Behavior → States → Responsive → Accessibility → Related.

## Routes

| Route | Doc | Description |
| ----- | --- | ----------- |
| *(all)* | [App_Shell.md](./App_Shell.md) | Layout, header, session ("You"), toaster, error boundary |
| `/` → `/tasks` | [Tasks_List.md](./Tasks_List.md) | Task list with filtering, sorting, paging |
| `/tasks/new` | [Task_Create.md](./Task_Create.md) | Create a task |
| `/tasks/board` | [Tasks_Board.md](./Tasks_Board.md) | Kanban board — ten status columns in four lanes, drag and drop to change status |
| `/tasks/:taskId` | [Task_Detail.md](./Task_Detail.md) | Detail view — status/claim/decision controls, dependencies, comments, activity, delete |
| `/tasks/:taskId/edit` | [Task_Edit.md](./Task_Edit.md) | Edit an existing task, with version-conflict handling |
| `/inbox` | [Inbox.md](./Inbox.md) | Everything waiting on a human — decisions, actions, QA |
| `*` | [Not_Found.md](./Not_Found.md) | Unmatched routes |

Route order matters: `/tasks/new` and `/tasks/board` are declared **before** `/tasks/:taskId` so neither is parsed as an id.

`/tasks` and `/tasks/board` are two readings of the **same URL state** — both parse it with `useTaskListParams`, and `ViewSwitch` carries the search string between them.

## Conventions across all pages

- Server state via TanStack Query only; query keys from `apps/web/src/api/queryKeys.ts`.
- List state lives in the URL — see [../features/Task_Query_Filter_Sort_Page.md](../features/Task_Query_Filter_Sort_Page.md).
- Every async view wires **loading, error (with retry), and empty** states.
- Forms use react-hook-form with the zod resolver from `packages/contracts`.
- Responsive is checked at 360px, 768px, and 1280px. Layout rules: [../engineering/UI_DESIGN_GUIDELINES.md](../engineering/UI_DESIGN_GUIDELINES.md).

## Related

- Domain behavior behind these screens: [../features/README.md](../features/README.md)
