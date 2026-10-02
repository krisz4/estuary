---
type: Page
title: App shell
description: Root layout, providers, header, session dialog, and route-level error boundary shared by every page.
resource: apps/web/src/App.tsx
tags: [layout, providers, shell, session, projects]
status: canonical
---
# Page Review: App Shell

Not a route of its own — the frame every other page renders inside.

## Route

- File: `src/App.tsx` (providers + router), `src/components/layout/AppLayout.tsx` (chrome)
- Router: `createBrowserRouter` in `src/router.tsx`
- Type: SPA. No SSR, no server components — the API is a separate service.

`/tasks/new`, `/tasks/board`, and `/tasks/map` are declared **before** `/tasks/:taskId`. React Router 7 ranks by specificity rather than declaration order, so it resolves correctly either way today — but the safe order is the written rule, and relying on a ranking algorithm to rescue a mis-ordered table is a bet on an implementation detail.

**`/` (the index route) redirects to `/tasks/map`.** The Map became the app's landing page — a single long-scrolling page with progressive disclosure (see [Tasks_Map.md](./Tasks_Map.md)) — rather than the plain task list; `/tasks` itself is unchanged and still reachable directly (the wordmark links there).

**`/tasks/board` redirects to `/tasks/map`, preserving the query string.** The Kanban board was retired in favor of the map; the redirect keeps an old bookmark or shared link useful instead of 404ing.

Every route: `/tasks` ([Tasks_List.md](./Tasks_List.md)), `/tasks/new` ([Task_Create.md](./Task_Create.md)), `/tasks/map` ([Tasks_Map.md](./Tasks_Map.md)), `/tasks/:taskId` ([Task_Detail.md](./Task_Detail.md)), `/tasks/:taskId/edit` ([Task_Edit.md](./Task_Edit.md)), `/inbox` ([Inbox.md](./Inbox.md)), `/logbook` ([Logbook.md](./Logbook.md)), and `*` ([Not_Found.md](./Not_Found.md)).

## Dependencies

### Providers (outermost → innermost)

`App.tsx` holds `QueryClientProvider` → `RouterProvider`, plus the `Toaster` outlet as a sibling of the router.

| Provider | Purpose |
| -------- | ------- |
| `QueryClientProvider` | TanStack Query. `queryClient` is a module-scope singleton (`src/api/queryClient.ts`) — recreating it on render would throw away the whole cache |
| `RouterProvider` | React Router data router, from `src/router.tsx` |
| `Toaster` | Sonner. Bottom-right from `sm`, top-centre below it, so a toast does not sit under the thumb or over a sticky mobile form's action bar. `theme` is set explicitly from `useTheme()`'s *resolved* value — Sonner injects its own unlayered `<style>` and defaults to light, so leaving the prop off renders every toast in the light palette on a dark page |

`ErrorBoundary` is deliberately **not** a provider here. It is mounted inside `AppLayout`'s `<main>`, below the header, so a render crash leaves working navigation instead of a blank document. It is keyed on `location.pathname`, without which a crash on one route would keep the fallback rendered forever — navigating changes the children but not the boundary's own state.

`SessionDialog` is also mounted once here (inside `AppLayout`), as a single document-wide dialog that three different triggers open through the session store — see [Behavior](#behavior--ui-flow).

### Components used

| Component | Role |
| --------- | ---- |
| `AppLayout` | Skip link → header → `UnauthorizedBanner` → `<main>` → footer, plus `ScrollRestoration` and `SessionDialog`. Behind it all, `.estuary-ground`: the Map's survey contours as a faint, seamless tile (`src/assets/contours.svg`, from `apps/web/scripts/generate-contours.mjs`), painted through a mask in `--ground-contour` and fading down the page. Cards are opaque, so it only shows in the gutters |
| `AppHeader` | Full-bleed to the landing page's width (`max-w-[1760px]`, same gutters as the Map), not `Container`. Left to right: the **Estuary** wordmark (36px `EstuaryMark` + name; the same drawing is `public/favicon.svg`) linking to `/tasks`; a slash divider; `ProjectSwitcher` as a pill; a segmented pill nav — **Tasks** (the remembered list/map view, current on every `/tasks…` screen except `/tasks/new`), **Inbox** with an amber live badge, **Logbook**; then theme toggle, `SessionControl` ("You"), and a rounded primary "New task". The bottom edge is a **waterline**: two sine strokes in water colours drifting at different speeds (`.waterline` in `index.css`; still under `prefers-reduced-motion`). It is water only, because amber is reserved for "waits on you". The wordmark and all three nav links carry the project scope |
| `ProjectSwitcher` (`src/components/layout/`) | "Current project" select — All projects, or one project from facets. Hidden while no task has a project. See [Behavior](#behavior--ui-flow) step 8 |
| `SessionDialog` | The "You" form — display name and API token — opened from the header, the 401 banner, or the comment composer |
| `UnauthorizedBanner` | A dismiss-by-fixing banner shown under the header once any request has come back `UNAUTHORIZED` |
| `Container` | `max-w-6xl` centered wrapper, `px-4` mobile / `px-6` from `md` |
| `ThemeToggle` | Cycles light → dark → system; state is in the `aria-label`, not only the icon |
| `ErrorBoundary` | Fallback panel with "Try again" and "Back to tasks" |

No sidebar, no navigation drawer: the app is two places to look at tasks (all of them, or the inbox of what needs a human) plus three forms. A nav shell would be scaffolding around that.

### API calls

None directly. `AppHeader` mounts `useTaskStatsQuery([project])` (`GET /api/v1/tasks/stats?project=…`, unscoped when no project is in scope) for the inbox badge, and `ProjectSwitcher` mounts `useTaskFacetsQuery()` (`GET /api/v1/tasks/facets`) for its options — see [Tasks_List.md](./Tasks_List.md) and [Inbox.md](./Inbox.md) for what stats itself gates.

## Behavior / UI flow

1. Header is sticky and translucent (backdrop blur) with a hairline bottom border — it keeps "Inbox" and "New task" reachable in a long list. The border is unconditional rather than appearing on scroll.
2. `<main>` renders the matched route inside `Container`. Route changes scroll to top (`ScrollRestoration`).
3. Document title is set per route via `useDocumentTitle(title)` — `TASK-000042 · Estuary` on detail, `Tasks · Estuary` on the list, `Inbox · Estuary` on the inbox. Passing `undefined` while data loads keeps the previous title rather than flashing a placeholder.
4. Theme resolves before first paint from an inline script in `index.html`; the header toggle cycles light → dark → system and persists to `localStorage`.
5. **Session ("You").** There are no accounts (`docs/features/Actors.md`). `SessionControl` in the header shows who this browser writes as (or "You" when anonymous) and opens `SessionDialog`, which sets a display name (slugified into `human:<slug>` and sent as `X-Actor` on every write) and an optional API token (sent as `Authorization: Bearer …` when the server was started with `API_TOKEN`). Both persist to `localStorage` under `estuary.session`; saving with a changed token invalidates every query, since a token change can turn previously-401 requests into ones that succeed. Three surfaces open the same dialog instance: the header button, `UnauthorizedBanner`, and the comment composer's "posting as … Change" link.
6. **Unauthorized banner.** Any request that comes back `UNAUTHORIZED` sets a store flag; `UnauthorizedBanner` renders under the header until the session dialog is saved. One banner rather than one per failing panel, because a missing token breaks the list, the stats badge, and every poll at once.
7. **Polling.** Screens that show agent-driven state (list, map, inbox, detail, activity timeline) poll every 15s (`api/polling.ts`, `POLL_INTERVAL_MS`) — see [Tasks_List.md](./Tasks_List.md). A write made in this browser still invalidates its own keys immediately; polling is for what an agent changed elsewhere.
8. **Project scope.** For someone running agents on several repositories, the header scopes the app to one project at a time. The scope **is** the `project` query param on the three screens that filter by it (`/tasks`, `/tasks/map`, `/inbox`): exactly one project selected is a scope; none is "all projects" (several — only reachable by a hand-edited URL — shows a disabled "Several projects" entry). The switcher is the only project control: the list and map filter bars have no project pills, "Clear all" keeps the project, and the Filters count leaves it out. `stores/projectScope` remembers the last scope those screens' URLs selected (`useRememberProjectScope`, written on mount, persisted to `localStorage` under `estuary.projectScope`), so detail, create, and edit — which have no filter URL — keep it too. The store follows the URL and never drives it.
   - **Switching** on list, map, or inbox rewrites that screen's `project` param in place, keeping every other param and dropping `page`. From any other screen it navigates to the remembered view (list or map) with `?project=`.
   - **The wordmark and the Tasks, Inbox, and Logbook links** carry `?project=<scope>`, and the inbox badge counts only that project, so the badge and the page it opens agree.
   - **New task** prefills the form's project with the scope ([Task_Create.md](./Task_Create.md)).

## States

| State | Behavior |
| ----- | -------- |
| Render crash | `ErrorBoundary` fallback inside `<main>`; header stays usable |
| Route not matched | Delegated to [Not_Found.md](./Not_Found.md) |
| Any request `UNAUTHORIZED` | `UnauthorizedBanner` appears under the header until the session dialog is saved |
| Offline / API down | Not handled globally — each page's error panel covers it, so the failure is shown where the data was expected |

## Responsive

| Breakpoint | Layout |
| ---------- | ------ |
| < `sm` (360–639px) | Header in two rows: wordmark + theme toggle, icon-only session and "New task" (with `aria-label`s); then the project pill (max `8.5rem`) beside the nav. Below 420px the nav segments are icons only — labels are `sr-only`, so the links keep their names. Toasts top-centre |
| ≥ `sm` | Full labels on "You"/name and "New task". Toasts bottom-right |
| < `lg` | The project pill and nav stay on a second header row, the nav stretching to fill it (one set of elements moved with `order`, not a duplicate) |
| ≥ `lg` | Header is one 64px row. `Container` hits its `max-w-6xl` ceiling and centers; the header stays full-bleed |

Two pairs of controls in the header ("New task", the session button) are **separate elements** hidden by breakpoint, not one element with a responsive label — an icon-only button needs an `aria-label` and a labelled one must not carry a redundant one.

## Accessibility

- Landmarks: `<header>`, `<main id="main">`, `<footer>`.
- "Skip to content" link, first in tab order, visible on focus, targets `#main`. `<main>` carries `tabIndex={-1}`.
- The project switcher is named "Current project" — not "Project", which is the create/edit form's field and the filter bar's group.
- The inbox nav link's count is spoken as words in its `aria-label` ("Inbox, 3 waiting on you"); the visible pill is `aria-hidden`.
- The unauthorized banner is `role="alert"`.
- Toasts render in an `aria-live="polite"` region (Sonner default); destructive toasts use `assertive`.
- Focus ring is never removed — `focus-visible` styling is defined once in the base layer.

## Related

- [Tasks_Map.md](./Tasks_Map.md) — the default landing route (`/` redirects here)
- [Tasks_List.md](./Tasks_List.md) — the wordmark's link, and the other reading of the Map's URL state
- [Inbox.md](./Inbox.md) — the other screen the header always links to
- [../features/Actors.md](../features/Actors.md) — actors, `X-Actor`, and the API token
- [../engineering/UI_DESIGN_GUIDELINES.md](../engineering/UI_DESIGN_GUIDELINES.md)
- [../features/Error_Handling.md](../features/Error_Handling.md)
