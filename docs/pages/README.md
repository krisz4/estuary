# Page specs index

One doc per UI route in `apps/web`. Parent index: [../README.md](../README.md). Agent entry: [../AGENTS.md](../AGENTS.md).

Each doc has YAML frontmatter (`type: Page`, `title`, `description`, `tags`, optional `resource` / `status`) and follows the body shape in [AGENTS.md](../AGENTS.md#page-doc-body-preferred-shape): Route → Dependencies → Behavior → States → Responsive → Accessibility → Related.

## Routes

| Route | Doc | Description |
| ----- | --- | ----------- |
| *(all)* | [App_Shell.md](./App_Shell.md) | Layout, header, session ("You"), toaster, error boundary |
| `/` → `/tasks/map` | [Tasks_Map.md](./Tasks_Map.md) | The landing page — a long-scrolling page with progressive disclosure over the Estuary river map (hero), needs-you queue, in-flight work, the full filterable list, and recent activity. (`/tasks/floor` and the retired `/tasks/board` also redirect here.) |
| `/tasks` | [Tasks_List.md](./Tasks_List.md) | Task list with filtering, sorting, paging |
| `/tasks/new` | [Task_Create.md](./Task_Create.md) | Create a task |
| `/tasks/:taskId` | [Task_Detail.md](./Task_Detail.md) | Detail view — status/claim/decision controls, dependencies, comments, activity, delete |
| `/tasks/:taskId/edit` | [Task_Edit.md](./Task_Edit.md) | Edit an existing task, with version-conflict handling |
| `/inbox` | [Inbox.md](./Inbox.md) | Everything waiting on a human — decisions, actions, QA, refinement, agent suggestions, outside-blocked |
| `/inbox/focus` | [Inbox_Focus.md](./Inbox_Focus.md) | Focus mode — the attention queue one item at a time, with context, progress, skip/previous, keyboard shortcuts, and auto-advance |
| `/logbook` | [Logbook.md](./Logbook.md) | History — since-you-left, cumulative flow, throughput, human wait, cycle time, agents, event log, archive |
| `*` | [Not_Found.md](./Not_Found.md) | Unmatched routes |

## Plans (not runtime SoT — confirm in code)

| Route | Doc | Description |
| ----- | --- | ----------- |
| `/tasks/map` (remaining) | [Floor_And_Logbook_Plan.md](./Floor_And_Logbook_Plan.md) | Redesign plan: phase 4 (live bead travel, drag-to-transition) has landed; quick add was later removed — see [Tasks_Map.md](./Tasks_Map.md) § Known gaps for the small remainder (boat fade-in/out) |

Route order matters: `/tasks/new`, `/tasks/board`, and `/tasks/map` are declared **before** `/tasks/:taskId` so none is parsed as an id. (`/tasks/board` is a redirect to `/tasks/map`, kept for old links — the Kanban board itself was retired.)

`/tasks` and `/tasks/map` are two readings of the **same URL state** — both parse it with `useTaskListParams` (the map layers its own `group`/`links`/`match`/`shipped`/`fold`/`task`/`at` on top via `useFloorParams`), and `ViewSwitch` carries the search string between them. `ViewSwitch` itself now renders inside `/tasks/map`'s "All tasks" section header, not that page's top-level header.

## Conventions across all pages

- Server state via TanStack Query only; query keys from `apps/web/src/api/queryKeys.ts`.
- List state lives in the URL — see [../features/Task_Query_Filter_Sort_Page.md](../features/Task_Query_Filter_Sort_Page.md).
- Every async view wires **loading, error (with retry), and empty** states.
- Forms use react-hook-form with the zod resolver from `packages/contracts`.
- Responsive is checked at 360px, 768px, and 1280px. Layout rules: [../engineering/UI_DESIGN_GUIDELINES.md](../engineering/UI_DESIGN_GUIDELINES.md).

## Related

- Domain behavior behind these screens: [../features/README.md](../features/README.md)
