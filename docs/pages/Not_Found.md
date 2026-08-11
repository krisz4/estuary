---
type: Page
title: Not found
description: Catch-all route for unmatched URLs.
resource: apps/web/src/pages/not-found/
tags: [routing, errors]
status: canonical
---
# Page Review: Not Found

## Route

- Path: `*` (catch-all, declared last)
- File: `src/pages/not-found/NotFoundPage.tsx`
- Type: Client component, no data fetching

## Behavior / UI flow

Renders inside the app shell — header and skip link stay available. Shows the attempted path, a short explanation, and "Back to tickets" (primary, → `/tickets`).

A secondary "Go back" (`navigate(-1)`) is rendered **only when there is an in-app entry behind this one** — `location.key !== "default"`, or `history.state.idx > 0` for the reload case. The common way to reach a 404 is a pasted or mistyped URL, which makes it the *first* entry of the session; `navigate(-1)` there either does nothing or leaves the app, so the button is omitted rather than shown broken.

**This is only for unmatched routes.** A *matched* route whose resource is missing — `/tickets/<valid-shape-but-gone>` — renders the in-page `NotFoundState` on [Ticket_Detail.md](./Ticket_Detail.md) instead, because the ticket-specific message ("this ticket was deleted") is more useful than a generic 404, and the route itself is legitimate.

## States

Single static state. No loading, no error, no data.

## Responsive

Centered column, `max-w-md`, generous vertical padding. Actions stack full-width below `sm` and sit side by side above it.

## Accessibility

- `<h1>` reads "Page not found" — not just "404", which announces as a bare number.
- The attempted path is rendered in a `<code>` element and is escaped as a text node (it is user-controlled input from the URL bar).
- Primary action receives focus on mount so keyboard users can leave with one keystroke.

## Related

- [App_Shell.md](./App_Shell.md) — routing and the shell this renders inside
- [Ticket_Detail.md](./Ticket_Detail.md) — the resource-level not-found state
