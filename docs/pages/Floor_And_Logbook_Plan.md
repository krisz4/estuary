---
type: Page
title: Floor and Logbook (redesign plan)
description: Plan for the main task view (Estuary map at /tasks/map, originally planned from the Task Foundry prototype) plus a history page (/logbook) — scaling, connections, filters, backend needs, phasing
tags: [redesign, floor, logbook, dependencies, history, plan]
status: plan
---

# Floor and Logbook — redesign plan

> **Design switch (2026-09-26): the view implements the Estuary design, not Task Foundry.** It is a river map: tasks are beads, waiting work gathers in the lagoon's glowing pools, agents are boats on the reach, and the tide scrubber replays history. Task Foundry's isometric workshop was dropped. Everything below about scaling, identification, connections, filters, the Logbook, and the backend still applies. Where this doc says belts, crates, or piles, read **groups (sectors of each station cluster), beads, and shoals**. The view is `/tasks/map` (`/tasks/floor` redirects). What ships is in [Tasks_Map.md](./Tasks_Map.md), and the Logbook in [Logbook.md](./Logbook.md).
>
> **Second switch (2026-09-26, same day): the Map became the app's landing page (`/` redirects to it).** Instead of one screen (map + Ledger side by side), it is now a single long-scrolling page — a `100dvh` hero (briefing + the map + a "needs you" rail) followed by four progressively more detailed sections (`#needs-you`, `#in-flight`, `#all`, `#recent`). The map/canvas mechanics, connections, colours, and replay described below are unchanged; what moved is the page composition around them. Current state is in [Tasks_Map.md](./Tasks_Map.md)'s "Sections" table — read that first, this doc's "Shell (phase 1)" section below describes the *pre-landing-page* single-screen layout and is superseded by it.

This doc lists what to keep, what breaks, and how the real page should work.

## Goals

1. **Scales from 5 tasks to thousands.** It looks deliberate when nearly empty and stays readable when full.
2. **You can tell what a task is about** without hovering over every crate.
3. **Connections are visible**: what blocks what, parent and subtasks, and dependencies that cross projects.
4. **History** has its own page (Logbook), and you can scrub the floor back in time.
5. **Filters, search, create, transitions, decisions, and QA** are part of the floor, not bolted on around it.

## What breaks in the prototype

| Problem | Where it shows |
| --- | --- |
| Fixed station widths, and overflow stacks crates vertically | Around 10 tasks in one station, you get towers. The seed's 62 tasks already crowd Backlog and Done. |
| One belt per project, hardcoded to three | 8 projects means 8 belts. The canvas gets very tall and most belts are empty. |
| Crates only show `#id` | You can't read what a task is about on the floor. The clipboard does all the work. |
| Dependencies only appear on hover | You can't see chains at a glance, and subtasks aren't shown at all. |
| Done piles up forever | The Shipped shelf grows without limit. |
| Project chips are the only filter | They also duplicate the header project switcher. The header switcher must stay the **only** project control. No search, labels, priority, or assignee filters. |
| No history | Only a 24h sparkline and a six-line log in the drawer. |
| Phone layout | An isometric canvas at 360px isn't usable. |

## What to keep

- Four zones on one x-axis: **Planning bench** (backlog, refine, todo), **Build bay** (in progress), **Waiting dock** (blocked, decide, act, review), **Shipped** (done, deferred). Station order never changes, so spatial memory stays intact.
- The yellow "needs you" safety zone with ? ! ✓ tags. Straps for blocked tasks, a tarp for deferred ones, and a priority band on each crate.
- Arms at the build bay represent agents, with heartbeat-driven motion. Agent activity stays in the background rather than being how the floor is organised.
- The clipboard as a text twin of the floor. Hovering a row highlights its crate and vice versa. It's also the accessible version.
- The drawer as the place to act (answer, approve, send back, hand back, release).

## Floor — `/tasks/floor`

```
┌ header: project switcher · search · + New task · Logbook ───────────────────────────┐
│ Shift report:  [4 waiting on you · oldest 2h] [3 building] [4 blocked · 1 external] │
│                [⛓ #22 unblocks 3]  [shipped 7 today ▁▂▅▃]                           │
├ Dispatch bar: /search  Priority▾ Labels▾ Assignee▾ Created by▾ More▾ │ Belts: project▾ │
│               Links: blocking▾ │ dim|hide │ presets: Needs me · Chains · Stale        │
├──────────────────────────────────────────────────────────────┬──────────────────────┤
│  PLANNING BENCH       BUILD BAY   WAITING DOCK       SHIPPED │ WORK ORDERS  (12/62) │
│  ▸ estuary ═══[#17][#58] ··· [#10 Bearer…]  ⚙[#12] ⛓[#23]… │ ▾ Needs you        5 │
│  ▸ billing  ═══[+14 ▤]  [#33 Coupons…]      ⚙[#22] [#29 ?]… │ ▾ Building         3 │
│  ▸ 3 more belts ─── ·2 ·5 ·0 ·1 ·0 ·1 ·0 ·2 ·9 ·1 (fold)     │ ▾ Blocked          4 │
│  rail: Backlog 14 · Refine 2 · To do 6 · … (click = filter)  │ …   (virtualised)    │
│  ◂────────── time scrubber ─────────────────────── Now ▸     │                      │
└──────────────────────────────────────────────────────────────┴──────────────────────┘
```

### Layout that adapts to the load

**Belts (rows) are a group-by, not a fixed list of projects.** `?belts=` takes one of:

| Value | Rows are | Default when |
| --- | --- | --- |
| `project` | one belt per project | scope is all projects |
| `epic` | one belt per parent task, plus a "No parent" belt | one project is in scope and it has parents |
| `chain` | one belt per dependency chain (connected component), largest first, plus a folded "Unconnected" belt | — (the connections lens) |
| `agent` | one belt per assignee or claim holder, plus "Unassigned" | — |
| `label` | one belt per label (a task with two labels goes on its first) | — |
| `none` | one belt | otherwise |

- Up to **6 belts** are expanded. The rest fold into thin rails that show a count pip per station and expand on click. Belts can be collapsed one at a time. Collapsed belts go in the URL (`?fold=`) because they change what a shared link shows.
- **Stations are sized to their content.** Width is roughly the square root of the busiest cell in that column, with a minimum (one crate and a count) and a maximum. Empty stations shrink to a painted outline but never disappear.
- **Auto-fit zoom.** The initial zoom is the largest one where every must-show crate fits the viewport width. With 5 tasks you get big crates with full labels. With 600 you get small crates and piles. Manual zoom works with ctrl+wheel, pinch, or the − / + buttons, and it goes in a client store, not the URL.

**Level of detail per cell (one belt × one station):**

1. **Must-show crates are always drawn individually**: needs you, in progress, blocked, urgent, matches the current search, selected, or at the end of a visible dependency edge.
2. Other tasks are drawn individually while they fit the cell.
3. Overflow becomes **one pile**: a pallet stencilled `+37`, with a thin priority mix band. Clicking a pile drills in by filtering the work orders to that belt and status (URL filter). There are never vertical towers.
4. At the farthest zoom, cells become fill gauges (count plus bar) and only must-show crates stay.

**The Shipped shelf shows a window**, 24h by default (`?shipped=24h|7d`). Older done and deferred tasks only count toward a stencilled "+212 in the Logbook" crate, which links to the archive.

### Crate encoding (what a task is about)

- **Shipping label on the front face**: `#22` plus the title, up to 2 lines when zoomed in and 1 line at normal zoom. The first label appears as a small stencil word.
- Body colour is the project, so it stays the same across group-bys and cross-project edges stay readable. The priority band stays as is.
- **Blocked**: straps plus a chain icon when it waits on tasks, or a padlock when the reason is external. The report already makes this split.
- **Unblocks N** badge `⛓3` when the task is upstream of two or more open tasks (transitive).
- **Claim health**: the arm's lamp is green, turns amber when the heartbeat is older than half the TTL, and the crate gets a clock tag when the lease has expired.
- **Stale** tasks (untouched for more than 7 days) get a faint dust layer on the top face.
- **GitHub**: a small PR tag (open, merged, or red when checks fail).
- **Hover card**: title, status note, labels, assignee, "waits on 2 · unblocks 3", PR, and updated time.

### Connections

`?links=` controls the dependency layer:

| Mode | Draws |
| --- | --- |
| `focus` | edges of the hovered or selected task only |
| `blocking` **(default)** | edges into tasks that are currently blocked, i.e. the ones that matter now |
| `all` | every open edge. Satisfied edges (blocker done) are faded and dashed. |
| `off` | nothing |

- Edges are overhead **chains**, catenary curves from the top of the blocker to the top of the dependent, with an arrowhead at the dependent. An edge into a pile attaches to the pile.
- **Trace (selection)**: selecting a crate dims everything outside its dependency closure to 25%. The drawer gets a **Chain** section, a small tree of "waits on ↑" and "unblocks ↓" (2 hops, expandable). `[` and `]` step upstream and downstream.
- **Off-scope blockers** (a project outside the current scope) show as a ghost crate at the belt's wall-end "port", labelled `mobile-app #49`. Clicking it opens the drawer without changing scope.
- **Subtasks**: `belts=epic` is the main view for these, since the belt is the parent. In other group-bys, the label shows `◳ 3/5` subtask progress, and selecting a crate draws thin sibling lines.
- **Bottlenecks**: the shift report gets a tile for the open task that unblocks the most others. Within a station, ordering is needs-you age, then priority, then unblocks N, then updated.

### Filters and controls

- **The header project switcher stays the only project control.** No project chips on the floor, and "Clear all" keeps `project`.
- **The Dispatch bar** reuses `useTaskListParams`, so `/tasks`, `/tasks/floor`, and `/inbox` read the same URL state and `ViewSwitch` carries it between them. It has search (`q`, `/` to focus), priority, labels, assignee (agents, humans, unassigned), created by, "has PR", "stale", and the presets **Needs me**, **Chains** (`belts=chain&links=all`), **Agents working**, and **Stale**.
- **Status filtering is done on the floor itself**: click a station's rail label to toggle `status`, or a zone name to toggle its whole group. Shift report tiles are filters too, e.g. "Blocked 4" sets `status=blocked`.
- **Dim vs hide** (`?match=dim|hide`). Dim is the default: non-matching crates fade in place, so positions stay put, and piles show "3 of 37 match". The work orders list always shows only matches.
- Sort applies to the work orders list and to the slot order inside a cell.

### Actions on the floor

- **Drawer** covers answering decisions, approving, sending back, handing back, releasing a claim, transitioning (reusing `TransitionDialog` and its requirements), comments, the dependency editor (add or remove, `DEPENDENCY_CYCLE` shown inline), subtasks, and GitHub status. It has an "Open full page" link to `/tasks/:id` for editing.
- **Drag a crate to a station** to transition it, replacing the board's drag and drop. Only stations that `transitionInputSchema` allows light up. If the target needs input (blocked reason, deferred reason), the dialog opens.
- **Quick add**: hovering a planning station shows a `+` that creates the task in that status and belt (project, parent, or label prefilled). "+ New task" is also in the header.
- **Keyboard**: j/k through work orders, Enter opens the drawer, arrow keys move the selection across the station grid, `/` focuses search, `c` creates a task, `g l` opens the Logbook, `?` shows help.

### Live updates and time

- Poll `GET /events?after=` as today. **Events drive the animations**: `task.status_changed` moves a crate along the belt, `task.claimed` has an arm pick it up, and `decision.requested` pops a tag. When more than about 20 events arrive at once (tab was in the background), the floor snaps instead of animating. Reduced motion always snaps.
- **Time scrubber** (the replay idea from Daybreak): a thin timeline under the floor with event density ticks. Dragging it back puts the floor into read-only replay at `?at=<ISO>` with a yellow "Viewing Tue 14:20" banner, actions disabled, and "Back to now". Titles and priority come from the current values; only status, claims, and existence are replayed. The banner says so.

### Responsive

- **≥ 1280**: floor and clipboard side by side, and the clipboard can collapse to a rail.
- **768–1279**: tabs (Floor / Work orders), as in the prototype.
- **< 768**: Work orders is the default tab. The Floor tab becomes a flat **station strip** (four zone cards with per-station counts and needs-you tags; tapping one filters the list) instead of the isometric canvas. The drawer becomes a bottom sheet. Checked at 360px.

### States

- Loading: a floor outline with empty stations and skeleton work orders.
- Error: a banner over a dimmed floor with Retry.
- Empty scope: the painted floor with "Nothing on the bench — file the first task" plus a CTA.
- No filter matches: "0 of 62 match" with Clear filters.

## Logbook — `/logbook`

History as its own page. It shares scope (the project switcher) and the actor filter, and adds a range (`?range=24h|7d|30d|90d` or `from`/`to`).

1. **Since you left**: shipped, new decisions and actions for you, and agent sessions. The last-visit timestamp goes in a client store.
2. **Flow**: a cumulative flow diagram banded by the four zones (toggle for all ten statuses). A widening Waiting-dock band is a bottleneck you can see.
3. **Throughput**: created vs shipped per bucket, plus how many were sent back from QA.
4. **Waiting on humans**: median and p90 time spent in decide, act, or review per bucket, and the ten longest waits. This is the key metric for a human-and-agent loop.
5. **Cycle time**: a dot strip from in progress to needs QA or done, split by agent.
6. **Agents**: per agent, tasks shipped, QA pass rate, decisions asked, and releases or expired claims.
7. **Event log**: grouped by day, newest first, filterable by type and actor, with infinite scroll back. Each row links to the task and to "Replay on the floor" (`/tasks/floor?at=`).
8. **Archive**: a searchable table of done and deferred tasks sorted by completion. This is where the "+212" crate on the Shipped shelf leads.

Every chart has loading, error, and empty states. Chart colours follow the four zone tokens in both themes.

## Backend work

All shapes go into `packages/contracts` first.

| Need | Change |
| --- | --- |
| Floor snapshot (list API caps `pageSize` at 100 and has no edges) | **`GET /floor`**: the same filters as `GET /tasks` plus `shipped`. Returns compact rows for open tasks (capped around 600, with per-cell counts above the cap), closed tasks inside the window plus an older count, dependency edges touching returned tasks (off-scope ends included as refs), and derived `unblocksCount` / `openBlockerCount`. |
| Replay | `GET /floor?at=`: status per task at T from `task.status_changed` payloads (`{ from, to }`). Tasks created after T are excluded. |
| Newest-first event paging and date ranges | `GET /events` gains `before` (cursor), `order=desc`, and `from`/`to`. |
| Charts | **`GET /stats/history?from&to&bucket=hour\|day\|week&project`**: per bucket, created, completed, deferred, and sent-back counts, a status snapshot at bucket end (for the CFD), and human-wait and cycle-time percentiles, computed from `TaskEvent`. |
| Archive sort | add `completedAt` to `TASK_SORT_FIELDS`. |

No schema change should be needed, since events already carry `project` and status `from`/`to`. If `stats/history` is slow on large logs, add an index on `TaskEvent(type, createdAt)` in a migration.

## Web structure

- `pages/tasks-floor/` (route), `pages/logbook/`.
- `features/floor/`:
  - **`layout.ts`**: a pure function from (tasks, edges, groupBy, zoom, viewport) to belts, cells, crates, piles, and edge paths. This is the unit-tested core (LOD thresholds, station sizing, must-show rules).
  - `scene.ts`: the canvas renderer, with a static layer and a frame layer, ported from the prototype.
  - `hit.ts`, `FloorCanvas.tsx`, `DispatchBar.tsx`, `ShiftReport.tsx`, `WorkOrders.tsx` (virtualised), `TaskDrawer.tsx` (reusing `DecisionAnswer`, `TransitionDialog`, `DependencyList`, `ClaimIndicator`, `GithubStatusBadge`), `TimeScrubber.tsx`, `StationStrip.tsx` (phone).
- URL state (shareable): `belts`, `links`, `match`, `shipped`, `fold`, `at`, and the existing list params. Store (per machine): zoom, clipboard collapsed.
- Accessibility: the canvas is `role="img"` with a live summary label. The work orders list is the full accessible twin, and selection syncs both ways.

## Phasing

1. **Shell**: contracts, `GET /floor`, the page with shift report, Dispatch bar, work orders, drawer. Useful before any canvas exists.
2. **Floor v1**: port the canvas with content-sized stations, `belts=project|none`, crates with labels, piles, the Shipped window, dim filters, station-rail status toggles.
3. **Connections**: links modes, trace, unblocks badge, off-scope ports, `belts=chain|epic|agent|label`.
4. **Live and hands-on**: event-driven animation, drag-to-transition, quick add. (`/tasks/board` already redirects to `/tasks/map` — see Decisions.)
5. **Logbook**: events paging, `stats/history`, charts, event log, archive.
6. **Replay**: `?at=` and the time scrubber.

Each phase ships with its docs (this page split into `Tasks_Floor.md` / `Logbook.md`, plus feature docs for the new endpoints) and tests. The phone station strip is part of phase 2, not an afterthought.

## Decisions (2026-09-26)

1. **The map replaces the board.** `/tasks/board` now redirects to `/tasks/map` (the Kanban board, `ViewSwitch`'s third tab, and `stores/taskView`'s `"board"` view are removed; a stored `"board"` preference migrates to `"map"`). Drag-to-transition (phase 4) is landing on the map separately. The list stays as the dense view.
2. **Default belts**: `project` when every project is in scope. With one project in scope, `epic` if it has parent tasks, otherwise `none`. `chain` is available through the "Chains" preset.
3. **Replay is status-only.** Titles, priority, and labels show their current values, and the banner says so.

## Related

- [Tasks_Map.md](./Tasks_Map.md), [Tasks_List.md](./Tasks_List.md), [Inbox.md](./Inbox.md)
- [../features/Task_Query_Filter_Sort_Page.md](../features/Task_Query_Filter_Sort_Page.md), [../features/Task_Workflow_API.md](../features/Task_Workflow_API.md)
