---
type: Page
title: Tasks Map
description: /tasks/map — the app's landing page, a single long-scrolling page with progressive disclosure over the Estuary flow map (hero), the needs-you queue, in-flight work, the full filterable task list, and recent activity
resource: apps/web/src/pages/tasks-map/
tags: [tasks, map, dependencies, filters, canvas, replay, landing-page]
status: canonical
---

# Tasks Map — `/tasks/map`

The app's front door: `/` redirects here. One long-scrolling page, five stacked sections with hash anchors, each progressively more detailed than the last — "harmonic first look, then scroll into detail" (the design brief). Section 1, the hero, is everything a glance needs (a briefing sentence, four tide numbers, the river map, and the top-priority items) and is sized to fit one screen **only at `>=1280px`** (the hero flows below that — see § Responsive); sections 2–5 are the "oversee everything" depth below it.

Built on the "Estuary" river/beads design (every task is a bead on a river: planning at the headwaters, agents at work in the reach, humans waiting in the lagoon, done at the mouth) — see [Floor_And_Logbook_Plan.md](./Floor_And_Logbook_Plan.md) for the full design history (Foundry → Estuary → this landing-page restructure) and phasing.

**Phase 4 (live motion, drag-to-transition, quick add) has landed, and so has the Kanban board's retirement** (`/tasks/board` now redirects here — see [App_Shell.md](./App_Shell.md)). Quick add, drag-to-transition, the poll-and-refresh plumbing, and the bead-travel canvas animation (a bead visibly travelling the river, with a trail, a splash, and a flashing station) are all real, end-to-end and tested. The one thing not built is boat fade-in/fade-out when a claim appears or disappears — see § Live motion and Known gaps.

## Route

- `tasks/map`, declared before `tasks/:taskId` in `router.tsx`. The index route (`/`) redirects here (`routeChildren`'s `{ index: true, element: <Navigate to="/tasks/map" replace /> }`) — see [App_Shell.md](./App_Shell.md).
- **`tasks/floor` redirects to `tasks/map`, preserving the query string** (`router.tsx`'s `FloorRedirect`) — a link or `?task=`/`?at=` written before the rename still resolves.
- Component: `pages/tasks-map/TasksMapPage.tsx`, composing the section components under `pages/tasks-map/sections/`.
- Added to `ViewSwitch` (List · Map — the Kanban board was retired; `/tasks/board` now redirects here). The switch itself now renders inside **section 4's** sticky header, not the page header. Added to `stores/projectScope.ts`'s `PROJECT_SCOPED_PATHS`, so the header's `ProjectSwitcher` — the page's **only** project control — carries scope here the same way it does on the list and inbox.
- **Full page width**: `AppLayout`'s shared `<Container>` caps at `max-w-6xl` (1152px), which starved the map on a wide screen. This page breaks out of that container with a viewport-relative negative margin and re-centres at its own, wider cap — the only page in the app that needs to.

## Sections

| # | Anchor | Component | What it shows |
| - | ------ | --------- | -------------- |
| 1 | `#hero` | `sections/Hero.tsx` | Briefing sentence (+ a live "N agents working · synced Xs ago" line) and four tide numbers (Waiting on you, Under way, Blocked, Shipped), the river map with a **non-overlaying toolbar row** (clock, legend toggle, search, Filters, View) above the canvas and a compact tide scrubber below it, and the top-priority "needs you" rail of compact `NeedsYouCard`s (`>=1280px`: beside the map; narrower: below it, or a horizontal row on phones). Exactly `100dvh` minus the header **only at `>=1280px`** — below that the hero flows (see § Responsive). |
| 2 | `#needs-you` | `sections/NeedsYouSection.tsx` | The **full** human-attention queue, grouped Decide / Act / Review, each item a **compact row** collapsed by default — click or `Enter` expands it inline into the real `InboxItem` (one at a time) — see § Reuse. |
| 3 | `#in-flight` | `sections/InFlightSection.tsx` | Two columns `>=1100px`: every `in_progress` task split into "Working" (live lease) and "Stalled" (expired/missing lease), and blocked dependency chains as small node-link diagrams. |
| 4 | `#all` | `sections/AllTasksSection.tsx` | The full Dispatch bar (shared URL state with the hero's map) plus a sticky column header, the List⇄Map `ViewSwitch`, and the Ledger in **dense** mode — real aligned columns at `>=1024px`. |
| 5 | `#recent` | `sections/RecentlySection.tsx` | The last 24h as a compact timeline grouped by hour (human sentences, not raw event types), plus a 7-day created-vs-shipped sparkline and a Logbook link. |

A `sections/MiniNav.tsx` sticky bar appears once the hero scrolls out of view (`IntersectionObserver` on a sentinel at the hero's bottom edge, `rootMargin` shrunk by the sticky app header's height so the sentinel's visibility is judged against what's actually visible under the header, not the raw viewport), scroll-spying which section is in view and linking `#hero`/`#needs-you`/`#in-flight`/`#all`/`#recent` with live counts for Needs you and In flight (`useInboxQuery`/`computeInFlightCount`, deduped against the same query the sections themselves use). It mounts alongside the sections (not earlier, while the floor query is still pending) — mounting it before the hero's sentinel exists in the DOM was the bug behind "the nav never appeared". Every section carries `scroll-mt-28` (and the hero `scroll-mt-14`) so a hash-anchor jump lands below the sticky header and nav, not underneath them.

A `sections/SectionHeader.tsx` gives every section (2–5) the same shape: an eyebrow label, title, count, and an optional right-aligned action — the "visual harmony" requirement, so five sections read as one page rather than five stapled-together panels.

## Dependencies

- **`GET /floor`** via `api/floor.ts`'s `useFloorQuery`, keyed at `queryKeys.tasks.floor()` (invalidated by every task write through `tasks.all`/`invalidateAfterWorkflowWrite`). Polls at `POLL_INTERVAL_MS` **except while replaying** (`?at=` set). Read once at the page level and passed down to the hero (briefing + canvas), section 3 (claims + blocked chains), and section 4 (the Ledger) — one fetch, five readers.
- **`GET /tasks`** via `api/tasks.ts`'s `useInboxQuery` — the same hook and query key `/inbox` uses — for the hero's "needs you" rail (top N) and section 2's full queue. **Not** derived from the `FloorSnapshot`: `FloorTask` is a compact shape without the full `TaskSummary` fields `InboxItem` needs (`openDecision`, `statusNote`, `acceptanceCriteria`, `links`), so this is a second, deliberate request rather than a doomed reuse of the first.
- **`GET /events`** via `api/events.ts`'s `useEventLogQuery` — the same hook the Logbook and (previously) the Briefing use — for the hero's "Since you left" sentence and section 5's recent-activity list. Reads only; cannot break the Logbook's own paging.
- `GET /tasks/facets` for the Dispatch bar's assignee/label/creator options and the project colour order.
- `features/floor/layout.ts` — pure functions: `FloorSnapshot` (`tasks`, `edges`, `refs`) + view state → station clusters, beads, shoals, ghost beads (`buildMapLayout`), plus `buildBlockedChains(tasks, edges)` for section 3's diagrams (connected components with at least one open edge, largest first, each with a per-chain bottleneck by `unblocksCount`). Unit-tested in `layout.test.ts`.
- `features/floor/scene.ts` + `FloorCanvas.tsx` — the canvas renderer (the river spline, terrain, beads, arcs, boats, day/night).
- `features/floor/colorAlpha.ts` — `colorWithAlpha()`, a `color-mix()`-based helper that fades *any* CSS colour syntax.
- `features/floor/DispatchBar.tsx` — the filter bar, with **three** layouts sharing one set of fields/mutations: `toolbar` (search + separate "Filters"/"View" popover buttons, non-collapsing — the hero's map-card toolbar row), the popover-row `full` mode (section 4's sticky header), and `compact` (search + one combined sheet, kept for narrow standalone use). Nothing here overlays the canvas any more.
- `features/floor/Briefing.tsx` (now the hero's "top strip" — no card chrome, four tiles instead of five; the former fifth tile, the map-wide bottleneck, moved into section 3's per-chain bottleneck badges), `Ledger.tsx` (its `dense` prop drives section 4's aligned-column mode — see § Behavior), `TaskDrawer.tsx`, `TideScrubber.tsx`.
- `pages/tasks-map/sections/NeedsYouCard.tsx` + `useNeedsYouActions.ts` — the hero rail's compact card (~90–120px) and the one shared hook behind its and `NeedsYouSection`'s one-click primary action (a decision's recommended option, a QA approve, an action hand-back). Anything needing typed input (a note, a send-back reason) opens the real task instead of a second inline form.
- `pages/inbox/InboxItem.tsx` — reused by section 2's row-expansion (see § Reuse); the hero rail uses `NeedsYouCard` instead (a stretched `InboxItem` there ran to 438px and blew the hero past one screen).
- `pages/tasks-map/useFloorParams.ts` — the URL state (unchanged; see below), shared by the hero's canvas and section 4's Dispatch bar/Ledger.
- `stores/mapVisit.ts`'s `useMapLastVisit()` — the page's own "last visited" store (see `Briefing`'s history for why it isn't `logbookVisit`'s).

## Reuse (not a duplicate)

The brief was explicit: the hero's rail and section 2 must **reuse** the Inbox's existing controls rather than re-implement "quick actions" against the same mutations a second time.

- **Section 2's rows** expand inline into `pages/inbox/InboxItem.tsx` directly — the same component `/inbox` renders — so a decision's full options, a QA item's Approve/Send back, and an action's Done/hand-back all go through `DecisionAnswer`, `useTransitionTaskMutation`, `useSendBackMutation`, and their existing version-conflict handling, unchanged. See [Inbox.md](./Inbox.md) for the note that it now has two consumers.
- **The hero rail's `NeedsYouCard`** is compact and cannot fit `InboxItem`'s full form, so it calls the *same underlying mutations* (`useAnswerDecisionMutation`, `useTransitionTaskMutation`) through `useNeedsYouActions` for the one unambiguous action per kind, and falls back to opening the real task for anything needing typed input — one hook, not a second copy of the transition logic.

The Ledger's grouping (Needs you / Under way / Blocked / Planning / Shipped & shelved) is reused as-is in section 4, just in `dense` mode and rendered full width instead of beside the canvas.

`buildBlockedChains` reuses the same union-find connected-component approach as `layout.ts`'s chain grouping mode, rather than a second graph implementation.

## URL state

Unchanged from before the restructure — `useFloorParams()` extends the list's `useTaskListParams` pure helpers with map-only keys, in **one** `useSearchParams()`-backed hook:

| Key | Values | Notes |
| --- | --- | --- |
| `group` | `project \| none \| epic \| chain \| agent \| label` | **`belts` is a deprecated, read-only alias.** Default computed by `layout.ts`'s `computeDefaultBeltsMode`. |
| `links` | `focus \| blocking` (default) `\| all \| off` | Which dependency arcs the canvas draws. |
| `match` | `dim` (default) `\| hide` | Non-matching beads fade to 10–15% alpha vs. disappear. |
| `shipped` | `24h` (default) `\| 7d` | The mouth's window, and the hero's "Shipped" tile. |
| `fold` | repeatable group keys | Read and parsed; no control folds a group from the map itself yet. |
| `task` | a task id | The open drawer — shareable. |
| `stale` / `working` | `1` / absent | Client-computed presets. |
| `at` | an ISO datetime | Replay (phase 6) — see below. |
| everything `useTaskListParams` owns | — | `status`, `priority`, `label`, `assignee`/`assigneeIsNull`, `createdBy`, `q`, `createdFrom`/`createdTo`. Filtering in section 4's Dispatch bar filters the hero's map too — they share this one hook. |

## Behavior / UI flow

1. **Hero** (`#hero`) — the briefing sentence + four tide tiles, the map card (a toolbar row above the canvas: clock chip, a Legend show/hide toggle, then the Dispatch bar's `toolbar` layout — search, "Filters", "View" — with active-filter chips in the same row; a compact tide-scrubber row below the canvas), and the "Needs you" rail of `NeedsYouCard`s, height-bound and internally scrollable. A "Details ↓" scroll cue sits at the hero's bottom edge, which doubles as the `MiniNav`'s show/hide sentinel.
2. **Needs you** (`#needs-you`) — the full queue as collapsed rows (type chip, `#id`, title, project dot, "waiting since", the one-click primary action), grouped Decide/Act/Review with counts; a row expands inline into the full `InboxItem` on click/`Enter`, one row at a time. Empty state: "Nothing needs you." / "Agents are on it."
3. **In flight** (`#in-flight`) — every `in_progress` task, split into "Working" (a live, unexpired claim — "claimed `{relative}` · lease `{n}`m left") and "Stalled" (no claim, or an expired lease — "lease expired `{relative}`", styled in the attention colour), plus "Blocked chains" (each chain a left→right row of 2-line pill nodes — border colour by the node's own status: `blocked` reads pool-block, a needs-you status reads pool-attn, `in_progress`/`needs_qa` read ok, everything else neutral — with a one-line caption naming the bottleneck's `unblocks N` and what it's waiting on), capped to 6 chains with "show all". The section's own count is `working + stalled + chains.length` — exactly what's listed.
4. **All tasks** (`#all`) — one sticky block holding the section header ("N of M match" when filtered, replacing a separate "Ledger (n/m)" header the Ledger no longer renders in `dense` mode), the full Dispatch bar, and a column header (ref/title/status/priority/assignee/deps/age) sharing the exact grid template (`LEDGER_DENSE_GRID_COLS`) the rows below use, then the Ledger itself: collapsible zone groups, zebra striping, 44px rows, real aligned columns at `>=1024px` and the previous stacked-card layout below it.
5. **Recently** (`#recent`) — the last 24h grouped by hour, each row a human sentence (`describeEvent`, the same formatter the Logbook's timeline uses) with the task's `#id title` appended and linked, plus a 7-day created-vs-shipped sparkline (`throughputSeries`, the Logbook's own transform) and a link to `/logbook`.

### The map itself (unchanged mechanics)

A generated river (Catmull-Rom spline through fixed control points, marching-squares contour terrain, tidal flats, sand stipple, a sea gradient at the mouth) with ten stations along it. Each station is a phyllotaxis cluster of beads — one per task, radius by priority × two density factors (viewport width and how many tasks are on the whole map). A cluster past its radius budget keeps every must-show bead individual and folds the rest into a **shoal**. Waiting/blocked stations glow; in-progress claims get a boat and a flag (`agent · #id`). Clicking a bead opens its drawer; clicking a station pin or a shoal sets the `status` filter.

## Connections

- **`links`** controls which edges draw as overhead, quadratic "chain" arcs with an arrowhead: `focus` (hover/selection only), `blocking` (default — unsatisfied edges only), `all` (every edge; satisfied ones faded and dashed), `off`. An arc into a shoaled task attaches to the shoal.
- **Trace**: selecting a bead computes its full transitive dependency closure and dims everything outside it.
- **Off-scope ghost beads**: a hollow, dashed bead at the map's edge (the "tributary"), labelled `project #id`, for any ref touched by an edge whose other end is out of scope.
- **`group=chain`** groups by connected component (largest first). **`group=epic`** groups by `parentId`. **`group=agent`** groups by the live claim holder. **`group=label`** groups by a task's first label.
- **Colours**: a curated 8-hue "lane" palette, assigned by sorted project order when `group=project`, or by the group's own sector index otherwise.

## Replay (phase 6)

- The tide scrubber (`TideScrubber.tsx`, in the hero's map card) shows an activity sparkline and a draggable/keyboard playhead (arrow keys move 10 minutes, shift+arrow 1 hour, Page Up/Down jump events, Home/End range ends). On phone (`<640px`) it's `compact`: play + time on one non-wrapping row, the track full-width below, "Now" as a small icon button.
- `useFloorQuery({ ..., at })` is a **real** `GET /floor?at=` refetch — the server replays status from `task.status_changed` events. Only status and existence are replayed; titles and priority are today's. The query keeps the previous snapshot on screen while the next `at` loads (`keepPreviousData`), so a scrub or replay tick never drops the page back to its skeleton, which would unmount the scrubber.
- History: leaving "now" pushes one entry; every later scrub or replay step replaces it, so Back returns to the live map.
- **Play replays events, not the clock.** The button reads "Replay N moves" (disabled as "Nothing to replay" at zero): N is the `task.status_changed` events in the scrubber's range, from their own `GET /events?type=task.status_changed` read (so comments and heartbeats can't crowd them off the first page). `features/floor/replayPlan.ts`'s `buildReplaySteps` orders them oldest first and splits them into at most `REPLAY_MAX_STEPS` (14) steps; events at the same instant always share one. Playback rewinds to just before the first change, holds 2s, then shows one step every 1.5s — each step writes `at` = its last event's time (`GET /floor?at=` is inclusive) — holds the last step for 2.5s, and hands back to "now". Quiet hours cost nothing, so a whole day replays in about 20 seconds. Pressing Play with the playhead in the past resumes from the next change after it; dragging, arrow keys, or "Now" stop playback.
- While playing, beads **travel** between snapshots (`FloorCanvas`'s `animateReplay`, set by `Hero` from the scrubber's `onPlayingChange`) — the same layout-diff animation as live motion. A drag or keyboard scrub stays a plain redraw: one jump can cover hours of changes. The page prefetches the next step's snapshot (`api/floor.ts`'s `usePrefetchFloorAt`, via the scrubber's `onPrefetch`) so each move starts on the beat.
- The caption names the step on screen ("19:59 · claude-code moved #17 To do → In progress", "+N more" for a shared step); when not playing, it names the next change at or after the playhead.
- While replaying, the map is read-only; the drawer's controls sit in a disabled `<fieldset>`, with a "Back to now" banner/button. **Drag-to-transition and quick add are both disabled while replaying too** (`FloorCanvas`'s `onDropTask`/`onQuickAdd` props are simply omitted when `?at=` is set) — a snapshot from the past isn't where a write belongs.
- Honours `prefers-reduced-motion`.

## Live motion (phase 4)

- `features/floor/useLiveMotion.ts` polls `GET /events?after={snapshot.meta.lastEventId}` every ~5s while the tab is visible and not replaying, and invalidates `queryKeys.tasks.all` whenever new events arrive — the floor snapshot (and everything built on it) refreshes on its own, without a manual refetch.
- `features/floor/liveMotion.ts`'s `planLiveAnimations(events, { reducedMotion })` is the pure decision layer: `task.status_changed` → a `move` animation, `task.claimed` → a `claim` animation, `decision.requested` → a `pulse` animation; everything else is ignored. It **snaps** (returns no individual animations) when `reducedMotion` is set or when a poll returns more than `LIVE_MOTION_SNAP_THRESHOLD` (20) events — "a lot happened while this tab wasn't watching" reads as a refresh, not motion. Unit-tested in `liveMotion.test.ts`.
- The hero's briefing gets a quiet live line — `formatLiveStatusLine(workingCount, syncedSecondsAgo)` → "3 agents working · synced 12s ago", or **"No agent working"** at zero (no pulse either) — with a small pulsing dot (`animate-pulse`, disabled under `prefers-reduced-motion` or when nobody's working) next to "Since {relative}". `workingCount` is `layout.ts`'s `countWorkingAgents(snapshot.tasks)` — distinct `agent:*` actors with a **live** claim (non-null, `expiresAt` in the future) — not `statusCounts.in_progress`: a task can sit `in_progress` with an expired or missing claim (the seed data's own "Stalled" case), which isn't an agent working right now. Hidden entirely while replaying.
- **Bead travel** (`features/floor/route.ts` + `FloorCanvas.tsx`) is the actual renderer work: a bead visibly travels from its last-rendered position to its new station rather than snapping. It works for **any** source of a status change — a poll, a drag-drop, a rail quick action, the drawer — because the mechanism is a diff, not an event listener: `FloorCanvas` keeps `prevRenderedRef` (status + pixel position per task, from the last frame it actually drew) and, whenever a new `layout` arrives, `route.ts`'s `diffMovedTasks` compares the two. A route is a straight slice of the main channel's own sampled points when moving forward on `MAIN_ORDER` (`pickRouteKind`), otherwise a quadratic hop arc (`sampleQuadratic`, the same bow shape a dependency arc uses); duration is `computeAnimationDurationMs(pathLength)`, clamped 900–2000ms; easing is `easeInOutCubic`. The moving bead draws with a ~20-sample fading trail (behind it along the *same* route, not a stored history — cheaper and always consistent), and arrival triggers a splash ring + a station-pin flash, with an extra soft pulse when the target is a pool station (waiting on a human — covers the `decision.requested` case generally, since that always lands on `needs_user_decision`). A drag-drop's travel starts from the exact drop point, not the bead's original station — the user just watched the ghost bead travel that far already. More than `ROUTE_SNAP_THRESHOLD` (20) simultaneous moves, `prefers-reduced-motion`, or a replay that isn't *playing* (a drag or keyboard scrub): no travel animation at all, tasks simply redraw at their new resting position. Unit-tested in `route.test.ts` (route selection, duration clamping, easing, the polyline/point-at-fraction geometry helpers, and the moved-task diff).
- **Not built**: boat fade-in/fade-out when a claim appears/disappears (a claim change alone, with no status change, doesn't go through the same diff — `planLiveAnimations`'s `claim` animation kind exists but isn't wired to a visual yet).

## Drag-to-transition (phase 4)

- Pointer-drag a bead onto a station (`FloorCanvas`'s `onDropTask` prop): a ghost bead follows the pointer, every station **other than the bead's own current one** rings green (there is no transition table — `lib/statusTransition.ts` — so every status may move to any other; `layout.ts`'s `isValidDropTarget` is the one pure rule, unit-tested), and the drop radius matches the ring's own radius (`clusterR + 12`), not `hitTest`'s tighter click-precision radius — a drop target smaller than its own visual affordance would be a real usability bug.
- **Touch**: long-press (~350ms) picks the bead up; a normal tap still opens the drawer. **Mouse**: a real drag starts once the pointer has moved a few px, so an ordinary click keeps working unchanged.
- **Esc** cancels a drag in progress.
- On drop, `TasksMapPage`'s `handleDropTask` decides direct-post vs. dialog exactly like the inbox/drawer do: `transitionNeedsInput(target, { acceptanceCriteria: null })` — the `null` is a deliberate, documented stand-in, since `FloorTask` (the map's compact shape) doesn't carry `acceptanceCriteria` the way `TaskSummary` does; this means a drop onto `todo` always opens `TransitionDialog` rather than risk a direct move the server would 422 on, at the cost of one extra click in the one case the client can't be sure about. Every other target's requirement doesn't depend on that field. A direct move posts with `expectedVersion` and the same `VERSION_CONFLICT` handling (toast, try again) the rest of the app uses.
- Disabled entirely while replaying (see § Replay).

## Quick add (phase 4)

- Hovering (or keyboard-focusing) a planning station's plate (backlog / needs_refinement / todo) shows a small "+" button. It navigates to `/tasks/new?status=<station>&project=<…>` — `TaskCreatePage` already supports both (`parseCreatePrefill`, unit-tested), reusing the create form's existing "Starting status" field and project default rather than building a second entry point.
- `project` is omitted (falling back to the header's project scope, the create page's existing default) unless the map is grouped by project, in which case it's the cluster's own dominant group — a "+" clicked on `helpdesk`'s `todo` cluster files into `helpdesk`, not whatever the header happens to be scoped to.
- Disabled entirely while replaying (see § Replay).

## States

- **Loading** — `MapSkeleton`: outline blocks for the hero row and the map card.
- **Error** — `ErrorPanel` with `refetch()`; per-section for `#needs-you`/`#recent` (their own queries), page-level for the hero/`#in-flight`/`#all` (all read the one `FloorSnapshot`).
- **Empty map** — "Nothing on the map" + "File the first task", when the snapshot has zero tasks and no filter is active.
- **No filter matches** — "0 of N match" + "Clear filters", in the hero and in `#all`.
- **Nothing needs you** — "Nothing needs you." / "Agents are on it." — distinct copy from "nothing on the map" (nothing exists vs. nothing needs attention).
- **No agent working** — "No agent is working right now." in `#in-flight`.
- **No blocked chains** — "Nothing is chain-blocked right now." in `#in-flight`.

## Responsive

- **Hero, `>=1280px`** (the rail breakpoint, `MAP_RAIL_QUERY`): exactly `100dvh` minus the app header, everything visible without scrolling — the map card is `flex-1` inside that fixed height. **`<1280px`: the hero flows** instead — the map card gets a real height derived from its own width (`clamp(420px,62vh,640px)` at `>=600px` width via a fixed CSS height, `aspect-[1/2.1]` capped `900px` below it) rather than `flex-1` in a box with no definite height, which is how the map went missing entirely on phone (the canvas is `position: absolute` and contributes no intrinsic size — see FloorCanvas) and got squeezed to ~130px by the needs-you row on tablet.
- **Vertical river, `<600px`** (`computeGeometry`'s own `horiz` threshold): calmer on purpose — station **plates only**, no bead callouts except the selected/hovered one (every must-show/urgent/blocked callout at once, stacked in a 390px column, was the actual illegibility bug), plate subtitles drop to a bare count ("4 tasks", not "4 · waiting"), region labels show only the lane word (no italic subtitle), and beads are a little smaller (`computeViewportScale`'s vertical case: `0.8`, was `0.95`).
- **Toolbar, `<640px`** (`SM_BREAKPOINT_QUERY`): collapses further — the Legend toggle drops, and the Filters/View split becomes one icon-only search (expands to a full-width field on tap) plus one "Filters" button whose sheet folds the View controls back in (`DispatchBar`'s `narrow` prop). The Legend panel itself also defaults to collapsed here.
- **Needs-you rail, `>=1280px`**: beside the map card. **768–1279px**: a horizontal row below the map. **`<768px`**: capped to 3 cards instead of 4.
- **`#in-flight`, `>=1100px`**: two columns (agents / chains) side by side; below that, stacked.
- Checked at 360/390/768/900/1280/1440px. The drawer is a Radix `Dialog`; below 640px it is a bottom sheet.

## Accessibility

- The canvas is `role="img"` with a generated summary `aria-label`; the Ledger (in `#all`) is its full accessible twin.
- The canvas is focusable and keyboard-operable: arrow keys cycle beads, `Enter` opens the focused one.
- `j`/`k` step focus through the Ledger's rows; `/` focuses the Dispatch bar's search box from anywhere on the page.
- The tide scrubber's playhead is a real `role="slider"`.
- `MiniNav` is a real `<nav>` of `<a href="#...">` links — keyboard/back-button behaviour and the shareable hash come for free.
- Colour never carries meaning alone: priority is bead size **and** a legend; blocked/waiting pools glow **and** have a station plate; a chain's bottleneck has a ring **and** an "unblocks N" text badge.

## The canvas's height (fixed: it now fills the hero, not a fixed 580px)

`FloorCanvas` measures **both** width and height of its own wrapper (`ResizeObserver`'s `contentRect`), not width alone. Three regimes, matching the three height strategies in § Responsive:
- **`>=1280px`** (one-screen hero): the wrapper is `min-h-0 flex-1` inside `#hero`'s `h-[calc(100dvh-3.5rem)]`, so it has a real, viewport-derived height; `computeCanvasHeight`/`computeGeometry`'s `availableHeight` uses it directly (clamped to a sane aspect-ratio band).
- **`600–1279px`** (horizontal river, hero flows): the wrapper gets a fixed CSS height of its own (`clamp(420px,62vh,640px)`).
- **`<600px`** (vertical river): the wrapper is `aspect-[1/2.1] max-h-[900px]` — height derived from its *own* width via CSS, not a measured container height — and `computeCanvasHeight` ignores `availableHeight` for this case entirely, using the same `~2.1×width, capped 900px` formula, so the two can't disagree.

**No feedback loop** in any of the three: the `<canvas>` element itself is `position: absolute; inset: 0` inside the wrapper, so it can never contribute to the wrapper's own measured size.

## Known gaps (honest scope-cut)

- **Section 4's "Table" mode** (a row-for-row reuse of `TaskTable`) was scoped but not built: `TaskTable` is typed against `TaskSummary`, while this page only fetches `FloorTask` — a second request to feed a lookalike table isn't reuse. The Ledger's grouped view covers the same columns (ref/title/labels/assignee/claim/deps/age/priority) in a denser, already-shared form; `/tasks` remains the place for a true sortable table.
- No control on the map itself folds/unfolds a group yet (`fold` is read and parsed, unwritten).
- Boat flags show `agent · #id` rather than a live step/percentage: `TaskClaim` on the wire carries only `{ actor, expiresAt }`.
- **Boat fade-in/fade-out is not built** — see § Live motion. Bead travel, its trail/splash/station-flash, and the pool pulse all are.
- Plates now actively dodge other plates, every bead's own disc, and ghost-bead labels join the same collision set (`placePlate`'s collision set includes bead obstacles; ghost labels sweep clear of `[...beadObstacles, ...plateRects]` with a shared 6px minimum gap), so a bead or ghost label landing on top of a plate should be rare — `placePlate` still never returns `null` (a still-overlapping fallback beats no plate at all), so an extremely crowded cluster can still produce one.
- Dependency arcs draw **before** plates now (plates paint over them, not the other way around), so an arc never obscures a plate's text.

## Related

- [App_Shell.md](./App_Shell.md) — the `/` → `/tasks/map` redirect.
- [Inbox.md](./Inbox.md) — `InboxItem`'s second consumer.
- [Floor_And_Logbook_Plan.md](./Floor_And_Logbook_Plan.md) — the full design and its phasing.
- [../features/Floor_Snapshot.md](../features/Floor_Snapshot.md) — the `GET /floor` contract, including `?at=`.
- [Tasks_List.md](./Tasks_List.md) — the other reading of `useTaskListParams`'s URL state.
- [../features/Task_Query_Filter_Sort_Page.md](../features/Task_Query_Filter_Sort_Page.md), [../features/Task_Workflow_API.md](../features/Task_Workflow_API.md)
