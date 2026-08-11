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

## Dependencies

### Providers (outermost → innermost)

| Provider | Purpose |
| -------- | ------- |
| `QueryClientProvider` | TanStack Query. Defaults: `staleTime` 30s, `retry` 2 for queries and `0` for mutations, `refetchOnWindowFocus` false (a helpdesk list refetching every tab switch is noise) |
| `RouterProvider` | React Router data router |
| `ErrorBoundary` | Catches render crashes below the header so the user keeps navigation |
| `Toaster` | Sonner. Bottom-right on desktop, top on mobile so it does not sit under the thumb |

`QueryClient` is created once at module scope, not inside a component — recreating it on render throws away the whole cache.

### Components used

| Component | Role |
| --------- | ---- |
| `AppHeader` | Product name linking to `/tickets`, and the primary "New ticket" button |
| `Container` | `max-w-6xl` centered wrapper with responsive horizontal padding |
| `ErrorBoundary` | Fallback panel with "Reload" and "Back to tickets" |
| `Toaster` | Global toast outlet |

No sidebar, no navigation drawer: there are four screens and one of them is a form. A nav shell would be scaffolding around nothing.

### API calls

None. The shell is presentational.

## Behavior / UI flow

1. Header is sticky on scroll with a hairline bottom border once scrolled — it keeps "New ticket" reachable in a long list.
2. `<main>` renders the matched route inside `Container`.
3. Route changes scroll to top (`ScrollRestoration`), otherwise paging through the list leaves you halfway down the next page.
4. Document title is set per route via a small `useDocumentTitle(title)` hook — `HD-000042 · Helpdesk` on detail, `Tickets · Helpdesk` on the list.

## States

| State | Behavior |
| ----- | -------- |
| Render crash | `ErrorBoundary` fallback inside `<main>`; header stays usable |
| Route not matched | Delegated to [Not_Found.md](./Not_Found.md) |
| Offline / API down | Not handled globally — each page's error panel covers it, so the failure is shown where the data was expected |

## Responsive

| Breakpoint | Layout |
| ---------- | ------ |
| < `sm` (360–639px) | Header is one row: wordmark + icon-only "New" button with `aria-label` |
| ≥ `sm` | Full "New ticket" button with label |
| ≥ `lg` | `Container` hits its `max-w-6xl` ceiling and centers |

## Accessibility

- Landmarks: `<header>`, `<main id="main">`, `<footer>`.
- "Skip to content" link, first in tab order, visible on focus, targets `#main`.
- Toasts render in an `aria-live="polite"` region (Sonner default); destructive toasts use `assertive`.
- Focus ring is never removed — `focus-visible` styling is defined once in the base layer.

## Related

- [Tickets_List.md](./Tickets_List.md) — the default landing route
- [../engineering/UI_DESIGN_GUIDELINES.md](../engineering/UI_DESIGN_GUIDELINES.md)
- [../features/Error_Handling.md](../features/Error_Handling.md)
