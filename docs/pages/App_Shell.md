---
type: Page
title: App shell
description: Root layout, providers, header, toaster, and route-level error boundary shared by every page.
resource: apps/web/src/App.tsx
tags: [layout, providers, shell]
status: canonical
---
# Page Review: App Shell

Not a route of its own — the frame every other page renders inside.

## Route

- File: `src/App.tsx` (providers + router), `src/components/layout/AppLayout.tsx` (chrome)
- Router: `createBrowserRouter` in `src/router.tsx`
- Type: SPA. No SSR, no server components — the API is a separate service.

`/tickets/new` is declared **before** `/tickets/:ticketId`. React Router 7 ranks by specificity rather than declaration order, so it resolves correctly either way today — but the safe order is the written rule, and relying on a ranking algorithm to rescue a mis-ordered table is a bet on an implementation detail.

Every route is real as of stage 12: `/tickets` ([Tickets_List.md](./Tickets_List.md)), `/tickets/new` ([Ticket_Create.md](./Ticket_Create.md)), `/tickets/:ticketId` ([Ticket_Detail.md](./Ticket_Detail.md)), `/tickets/:ticketId/edit` ([Ticket_Edit.md](./Ticket_Edit.md)), and `*` ([Not_Found.md](./Not_Found.md)). `StagePlaceholderPage`, which backed the three `/tickets/*` routes through stage 11, was deleted in stage 12 along with its route entries.

## Dependencies

### Providers (outermost → innermost)

`App.tsx` holds two, plus the toast outlet:

| Provider | Purpose |
| -------- | ------- |
| `QueryClientProvider` | TanStack Query. Defaults: `staleTime` 30s, `retry` 2 for queries and `0` for mutations, `refetchOnWindowFocus` false (a helpdesk list refetching every tab switch is noise) |
| `RouterProvider` | React Router data router, from `src/router.tsx` |
| `Toaster` | Sonner. Bottom-right from `sm`, top-centre below it so it does not sit under the thumb or over stage 12's sticky form actions |

`QueryClient` is created once at module scope in `src/api/queryClient.ts`, not inside a component — recreating it on render throws away the whole cache.

Retry is a **predicate**, not a count: queries retry twice and only for `NETWORK_ERROR` or a 5xx. Retrying a 404 costs three round trips to show the same "ticket not found".

Sonner's `position` is a single document-wide value with no responsive form, so the breakpoint is read in JS via `useMediaQuery` rather than expressed as a class. That is the exception, not the pattern — everything that can be a Tailwind breakpoint is one.

**`ErrorBoundary` is deliberately not a provider.** It is mounted inside `AppLayout`'s `<main>`, below the header, so a render crash leaves working navigation instead of a blank document. It is keyed on the pathname; without that, a crash on one route keeps the fallback rendered forever, because navigating changes the children but not the boundary's own state.

### Components used

| Component | Role |
| --------- | ---- |
| `AppLayout` | Skip link → header → `<main>` → footer, plus `ScrollRestoration` |
| `AppHeader` | Product name linking to `/tickets`, theme toggle, and the primary "New ticket" button |
| `Container` | `max-w-6xl` centered wrapper, `px-4` mobile / `px-6` from `md` |
| `ThemeToggle` | Cycles light → dark → system; state is in the `aria-label`, not only the icon |
| `ErrorBoundary` | Fallback panel with "Try again" and "Back to tickets" |
| `Toaster` | Global toast outlet |

No sidebar, no navigation drawer: there are four screens and one of them is a form. A nav shell would be scaffolding around nothing.

### API calls

None. The shell is presentational.

## Behavior / UI flow

1. Header is sticky with a hairline bottom border — it keeps "New ticket" reachable in a long list. The border is unconditional rather than appearing on scroll: a scroll listener toggling a class costs a re-render per frame for an effect nobody asks about.
2. `<main>` renders the matched route inside `Container`.
3. Route changes scroll to top (`ScrollRestoration`), otherwise paging through the list leaves you halfway down the next page.
4. Document title is set per route via a small `useDocumentTitle(title)` hook — `HD-000042 · Helpdesk` on detail, `Tickets · Helpdesk` on the list. Passing `undefined` while data loads keeps the previous title rather than flashing a placeholder.
5. Theme resolves before first paint from an inline script in `index.html`; the header toggle cycles light → dark → system and persists to `localStorage` under `helpdesk.theme`.

## States

| State | Behavior |
| ----- | -------- |
| Render crash | `ErrorBoundary` fallback inside `<main>`; header stays usable |
| Route not matched | Delegated to [Not_Found.md](./Not_Found.md) |
| Offline / API down | Not handled globally — each page's error panel covers it, so the failure is shown where the data was expected |

## Responsive

| Breakpoint | Layout |
| ---------- | ------ |
| < `sm` (360–639px) | Header is one row: wordmark + theme toggle + icon-only "New" button with `aria-label`. Toasts top-centre |
| ≥ `sm` | Full "New ticket" button with label. Toasts bottom-right |
| ≥ `lg` | `Container` hits its `max-w-6xl` ceiling and centers |

The two "New ticket" controls are **separate elements** hidden by breakpoint, not one element with a responsive label. An icon-only button needs an `aria-label` and a labelled one must not carry a redundant one, so a single element would have an accessible name that is correct at one breakpoint and doubled at the other.

## Accessibility

- Landmarks: `<header>`, `<main id="main">`, `<footer>`.
- "Skip to content" link, first in tab order, visible on focus, targets `#main`. `<main>` carries `tabIndex={-1}`, without which the browser moves the scroll position but leaves focus in the header the user just skipped — the single most common way a skip link ships broken.
- Toasts render in an `aria-live="polite"` region (Sonner default); destructive toasts use `assertive`.
- Focus ring is never removed — `focus-visible` styling is defined once in the base layer.

## Related

- [Tickets_List.md](./Tickets_List.md) — the default landing route
- [../engineering/UI_DESIGN_GUIDELINES.md](../engineering/UI_DESIGN_GUIDELINES.md)
- [../features/Error_Handling.md](../features/Error_Handling.md)
