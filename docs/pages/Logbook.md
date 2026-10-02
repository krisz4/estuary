---
type: Page
title: Logbook
description: History for /logbook — since-you-left summary, cumulative flow, throughput, human wait, cycle time, agents, event log, and the done/deferred archive.
resource: apps/web/src/pages/logbook/
tags: [history, charts, events, archive, agents, projects]
status: canonical
---
# Page Review: Logbook

The history companion to the floor (`docs/pages/Floor_And_Logbook_Plan.md`, phase 5), and the Map's ([Tasks_Map.md](./Tasks_Map.md)) opposite number in the same visual language ("Estuary" — the `--map-*` tokens, `SectionHeader`, a sticky scroll-spy nav): a calm "at a glance" first screen — the range control and a one-line "since you left" briefing sentence, four KPI tiles with sparklines, then the Flow chart as the hero graphic — followed by the same eight sections it always had, all reading the same scope and range.

## Route

- Path: `/logbook`
- File: `src/pages/logbook/LogbookPage.tsx`
- Type: Client component, data via TanStack Query, polling on the history and chart sections
- Linked from `AppHeader`'s "Logbook" nav item on every screen

## Dependencies

### Components used (all in `src/features/logbook/`, unless noted)

| Component | Role on this page |
| --------- | ------------------ |
| `ReachEyebrow` (`src/components/`) | "TIDE LOG *every movement on the river*" above the heading |
| `RangeControl` | The `?range=` button group — a single row at every width; short labels ("24h", "7d") below `sm`, full labels ("Last 24 hours") at `sm` and up, `aria-label` pinned to the full label regardless of which text is visible |
| `SinceYouLeftPanel` | The compact one-line "since you left" sentence (via `sinceYouLeftSentence()`), or the first-visit line — sits next to `RangeControl` in the top row, not its own section |
| `KpiRow` (+ `kpis.ts`, `Sparkline`, `sparklineGeometry.ts`) | The four "at a glance" tiles — Shipped, Created, Median wait on humans, QA pass rate — same tile shape as the Map's `Briefing` tide numbers, each with a tiny gap-aware sparkline over the range's history buckets: a dot per available bucket, a solid line between adjacent buckets, a faint dotted one where the line bridges a gap, and a muted dash instead of a line below `MIN_SPARKLINE_POINTS` (3) real values — a lone point or two otherwise drew as an unreadable zig-zag |
| `pages/tasks-map/sections/SectionHeader` (imported, not owned by this page) | Every section's eyebrow/title/count/action header, so the two pages read as one product |
| `LogbookMiniNav` | The sticky scroll-spy nav, appearing once the top area (range + briefing + KPIs) scrolls past — a local copy of the Map's `MiniNav` (that component's "Map"/`#hero` home link doesn't generalise, and `pages/tasks-map/` is not this page's to edit) |
| `CumulativeFlowChart` | Stacked-area SVG, used for both the 4-zone and all-status views — the hero graphic, right after the KPI row |
| `ThroughputChart` | Created vs shipped grouped bars, sent-back count under the axis, at most 6 x-axis date labels |
| `WaitingChart` + `LongestWaitsList` | Median/p90 line chart, and the ten longest human waits (`#<id>` + a two-line-clamped title, not the full `TASK-000042` prefix — that overflowed narrow cards) |
| `CycleTimeDotStrip` | One dot per finished `in_progress → done/needs_qa` pass, one lane per agent |
| `AgentsTable` | Per-agent submitted/QA-pass-rate/decisions/claims/releases — a real `<table>` at `md` and up, stacked cards below it |
| `EventLog` | The day-grouped, actor/type-filterable, infinite-scroll event log; each row's task link is `#<id>` (mono) + `event.taskTitle` (sans), matching the Map's `RecentlySection` convention |
| `ArchiveTable` | Done/deferred tasks, searchable, paged, sorted by `completedAt` desc |
| `EmptyState`, `ErrorPanel`, `Skeleton`, `Pagination` (`src/components/`) | Shared async/paging chrome |

> **Resolved gap:** `TaskEvent` (`GET /events`) now carries `taskTitle: string | null` — the task's *current* title, `null` once the task has been deleted. Each event log row shows it `line-clamp-2 sm:line-clamp-1` next to the `#<id>` link (2 lines on phone, 1 at `sm` and up, rather than a hard `truncate` — the same reasoning as `LongestWaitsList`'s title fix); a deleted task renders "deleted task" in muted italic instead of blank space. Previously this page showed `#<id>` alone, since `TaskEvent` had no title and a per-row lookup would have meant either an N+1 fetch or a new batch endpoint — flagged rather than worked around, per the repo's contract-first rule, until the contract added the field.

### Pure logic (unit-tested, no React)

| Module | Role |
| ------ | ---- |
| `zones.ts` | The estuary's four reaches for this page's purposes, named like the Map's regions (`ZONE_NAMES` · `ZONE_REACHES`, legend "Waiting · the lagoon") — **not** `TASK_STATUS_LANES`: Plan · headwaters `[backlog, needs_refinement, todo]`, Doing · the reach `[in_progress]`, Waiting · the lagoon `[blocked, needs_user_decision, needs_user_action, needs_qa]`, Closed · the mouth `[done, deferred]`. Unlike the Map, `needs_qa` counts as waiting here: the chart asks who work waits on, and review waits on a human |
| `range.ts` | `?range=` ⇄ `{from, to, bucket}`; `bucketForSpan` picks hour/day/week |
| `cfd.ts` | `HistoryBucketRow.statusCounts` → stacked-area bands, by zone or by status |
| `throughput.ts`, `waiting.ts`, `cycleTime.ts` | Chart-ready series from `HistoryResponse` |
| `sinceYouLeft.ts` | Counts ship/sent-back/decision/action/QA events after the last-visit timestamp, from the event log's already-loaded pages; `sinceYouLeftSentence()` turns that into the one-line briefing sentence |
| `kpis.ts` | `HistoryResponse` → the four KPI tiles' values and sparkline series |
| `chartColors.ts` | Every chart's colour: the Map's own "Estuary" `--map-*` tokens — `--map-ink-3` (neutral, planning), `--map-ok` (build/"moved forward" — the same colour the tide scrubber uses for `in_progress`/`needs_qa`/`done`), `--map-pool-attn` (waiting), `--map-pool-block` (blocked, broken out of the waiting zone's shading in the all-statuses view), `--map-water-edge` (shipped). The all-statuses view otherwise shades within its zone's hue rather than adding new colours |

### Hooks

| Hook | Role |
| ---- | ---- |
| `useHistoryQuery(query)` (`api/history.ts`) | `GET /stats/history` — backs sections 2–6 (Flow, Throughput, Waiting, Cycle time, Agents) with one request and one loading/error state |
| `useEventLogQuery(filter)` (`api/events.ts`) | `GET /events?order=desc`, infinite, paged backwards with `before`. Feeds both "Since you left" (its loaded pages) and the event log section (actor/type filters, "load older") |
| `useArchiveQuery(query)` (`api/tasks.ts`) | `GET /tasks?status=done&status=deferred&sort=completedAt:desc` |
| `useRememberProjectScope(projects)` | Same as every other scoped screen — see [App_Shell.md](./App_Shell.md) |
| `useLastVisit()` (`stores/logbookVisit.ts`) | The timestamp "Since you left" measures from, frozen at mount and floored to at least 12h before now (`LOGBOOK_VISIT_MIN_LOOKBACK_MS`) — a visit minutes ago should not read as "nothing happened"; advances the store to now on unmount **and** on `pagehide` (a reload/tab close doesn't reliably unmount React first) |

### API calls

| Call | Method | Endpoint |
| ---- | ------ | -------- |
| `getHistory(query)` | `GET` | `/api/v1/stats/history?project=…&from=…&to=…&bucket=hour\|day\|week` |
| `listEvents(query)` | `GET` | `/api/v1/events?order=desc&project=…&actor=…&type=…[&before=…]` |
| `listTasks(query)` | `GET` | `/api/v1/tasks?status=done&status=deferred&sort=completedAt:desc&project=…&q=…&page=…&pageSize=…` |

## Route params

| Param | Effect |
| ----- | ------ |
| `project` | Repeatable. The header's project switcher — the **only** project control, same rule as the floor and the inbox. Read via `parseProjects` + `useRememberProjectScope`, exactly like Inbox |
| `range` | `24h \| 7d \| 30d \| 90d \| custom`. Default `7d`. `custom` requires both `from` and `to`; without both it falls back to `7d` |
| `from`, `to` | ISO instants, only meaningful with `range=custom` |
| `actor` | Event log filter, lowercased |
| `type` | Event log filter — one `TaskEventType` (the URL carries at most one; the `Select` offers "Any type") |
| `q` | Archive search |
| `page`, `pageSize` | Archive paging |

Changing `range`, `actor`, or `type` does not reset `page`/`q`: the archive is its own paged section, independent of the range and event-log filters (per the plan, the archive is "sorted by completion", not scoped to the selected range).

## Behavior / UI flow

**The top area — "first look… harmonic, only the most relevant data".** One tidy row holds the range control and the "since you left" sentence; a row of four KPI tiles (Shipped, Created, Median wait on humans, QA pass rate — each with a sparkline over the range's history buckets) follows; the Flow chart is the hero graphic right after. A `LogbookMiniNav` sticky scroll-spy bar (a local copy of the Map's `MiniNav` — see the component table) appears once this area scrolls out of view, so a reader can jump straight to any section below or scroll to "go into details… with the option to oversee everything and go into details".

1. **Since you left.** `useLastVisit()` freezes the stored timestamp at mount (floored to at least 12h before now — see the hooks table — and not read again until the *next* visit) and schedules the store to advance to "now" on unmount or `pagehide`. The one-line sentence ("Since you left 14h ago: 5 shipped, 2 sent back, claude-code asked 3 questions") is computed from the event log query's already-loaded pages — no second request — so it undercounts if the last visit was longer ago than the loaded pages reach back, in which case a small note says so. First-ever visit (no stored timestamp) shows a welcome line instead; a visit with nothing to report shows "Nothing new since your last visit."
2. **Flow.** A cumulative flow diagram: `HistoryBucketRow.statusCounts` is already a snapshot at each bucket's end, so the chart is a direct stack, not an accumulation. Default is the four reaches (Closed anchors the bottom, since it only grows); a toggle switches to all ten statuses, each shaded within its zone's colour — `blocked` always renders in `--map-pool-block`, distinct from its lagoon siblings' amber, since that distinction is the point of switching to this view.
3. **Throughput.** Created vs shipped (`completed + deferred`) grouped bars per bucket, with the sent-back count as a small number under the axis when non-zero. At most 6 x-axis date labels (same tick-picking the Flow chart uses), so a `90d`/day-bucket range doesn't render 90 overlapping labels.
4. **Waiting on humans.** Median/p90 minutes in a human-wait status (`needs_user_decision`, `needs_user_action`, `needs_qa`) per bucket, as two lines (gaps where a bucket had no waits), plus the ten longest waits in range — still-open ones (`endedAt: null`) get a "Still waiting" badge and link straight to the task.
5. **Cycle time.** One dot per finished `in_progress → done/needs_qa` pass, one horizontal lane per agent, busiest agent first. Hovering or focusing a dot shows the task and duration.
6. **Agents.** Submitted (moved into `needs_qa`), QA pass rate (`approved / (approved + sentBack)`), decisions asked, claims, releases.
7. **Event log.** Newest first, grouped by local calendar day, filtered by actor (free text) and type (one at a time). "Load older" pages backwards with `before`. Each row links to its task as `#<id>` (mono) and offers "Replay on the floor" → `/tasks/map?at=<event.createdAt>` (the map's own replay mode, see [Tasks_Map.md](./Tasks_Map.md) § Replay; this is a plain link, not a shared component).
8. **Archive.** Done/deferred tasks, searchable, sorted by `completedAt` desc — where the floor's "+N in the Logbook" crate is meant to lead once the floor ships it.

Sections 2–6 share one `useHistoryQuery` call (the same one the KPI tiles read): they are all views over the same bucketed response, so a single loading/error state (and a single retry) covers all of them rather than near-identical ones per section.

## States

| State | Behavior |
| ----- | -------- |
| Loading (KPI tiles, 2–6) | `KpiRow` shows four tile skeletons; each history-backed section shows one skeleton block, while `useHistoryQuery` is pending |
| Error (2–6) | `ErrorPanel` + Retry, shared across the five sections (the KPI row simply renders nothing until `historyQuery.data` resolves — it shares the same query, so the section below it always carries the retry) |
| Empty (2–6) | Per-section copy ("No task activity in this range yet.", etc.) when the range has no relevant events — distinct from a request error |
| Event log loading/error/empty | Its own `ErrorPanel`/`EmptyState`, since it is an independent request; the empty state distinguishes "no events at all" from "no events match" (offers "Clear filters" only in the latter case) |
| Archive loading/error/empty | Its own states; empty distinguishes "nothing shipped yet" from "no search matches" |
| Since you left | First-visit line, "Nothing new" line, or the sentence — never a spinner, since it derives from data the event log section already has |

## Responsive

- Charts scale via `viewBox` and stay legible at 360px; the CFD is the one chart the plan allows horizontal scroll inside at the widest range (`90d`) — not exercised by the current fixed `viewBox`+`min-width` implementation, which shrinks instead. Revisit if a 90-day CFD becomes unreadable in practice.
- The CFD, Throughput, Waiting, and Cycle time charts all set `preserveAspectRatio="none"` on their `<svg>`: the default (`"meet"`) fits the fixed viewBox to whichever axis is the tighter constraint and letterboxes the rest, which on a wide desktop card (much wider than the viewBox's own fixed aspect ratio) meant the chart rendering at roughly 60% of the card's actual width with empty margin on both sides. `none` stretches non-uniformly to fill the card exactly; nothing in these charts depends on x and y sharing a scale, so the distortion is invisible. The first/last x-axis tick labels on the CFD and Throughput charts anchor `start`/`end` rather than `middle` for the same reason — a centred label sitting exactly on the plot's edge now clips against the SVG's own bounds instead of having letterbox margin to spill into.
- `RangeControl` is a single row at every width — never two — via short labels ("24h", "7d", "30d", "90d") below `sm` and full labels ("Last 24 hours", …) at `sm` and up; the button's `aria-label` is pinned to the full label at every width, so its accessible name never changes with the breakpoint.
- The KPI tile row is `grid-cols-2` below `560px`, `grid-cols-4` above it.
- `LongestWaitsList` shows `#<id>` (mono) rather than the full `TASK-000042` reference, with the title `line-clamp-2` instead of `truncate` — the full reference plus a single truncated line was cutting titles down to a handful of characters on a narrow card. The event log's row title uses the same idea, `line-clamp-2 sm:line-clamp-1`.
- The agents table and the archive table are real `<table>`s at `md` and up; below `md` both render as stacked cards with the same data (no horizontal table scroll on mobile, per the design guidelines).
- The event log's rows wrap; the "Replay on the floor" link sits on its own line on narrow screens via `flex-wrap`.
- Every `sr-only` data table (one per chart) is wrapped in its own `<div className="sr-only">`, not applied to the `<table>` element directly — an un-wrapped `sr-only` table can still contribute to the *layout* box in some engines and was a source of horizontal overflow; the wrapper keeps it purely off-screen.

## Accessibility

- Every chart is `<svg role="img">` with a `<title>` and a `sr-only <table>` fallback carrying the same numbers a sighted reader gets from the shape.
- Hover/focus targets are `tabIndex={0}` rectangles/circles with a per-point `aria-label`; a `role="status"` tooltip mirrors the same values visibly.
- The agents and archive tables are semantic, with `<caption class="sr-only">` and real `<th scope>`.
- The event log's actor/type filters have real labels; icon-only "Replay on the floor" is not icon-only — it carries text.

## Related

- [Floor_And_Logbook_Plan.md](./Floor_And_Logbook_Plan.md) — the redesign plan this page implements phase 5 of
- [Tasks_Map.md](./Tasks_Map.md) — the landing page this page shares its visual language with (`SectionHeader`, the `--map-*` tokens, the sticky scroll-spy nav pattern), where "Replay on the floor" leads (§ Replay), and the "+N in the Logbook" crate the archive answers
- [../features/Task_Workflow_API.md](../features/Task_Workflow_API.md) — the events feed this page's charts and log are computed from
- [App_Shell.md](./App_Shell.md) — the project switcher and its scope rule
