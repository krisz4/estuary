---
type: Page
title: Inbox focus mode
description: The attention queue one item at a time at /inbox/focus — same clearing controls as the inbox, plus context, progress, skip/previous, keyboard shortcuts, and auto-advance.
resource: apps/web/src/pages/inbox-focus/
tags: [tasks, inbox, focus, attention, keyboard, projects]
status: canonical
---
# Page Review: Inbox focus mode

The [inbox](./Inbox.md), one item at a time. The inbox is for scanning — every group on one page; focus mode is for **getting through it**: one item fills the screen together with the context needed to decide it, clearing it moves straight on to the next, and the whole session can be driven from the keyboard.

## Route

- Path: `/inbox/focus`
- File: `src/pages/inbox-focus/InboxFocusPage.tsx`; ordering rules in `src/pages/inbox-focus/focusQueue.ts`
- Type: Client component, data via TanStack Query, polling
- Entered from the inbox: **Focus mode** in the page header (whole queue) and **Focus** in any group header with two or more items (`?kind=` that group). The header's "Inbox" nav item stays active here

## Dependencies

### Components used

| Component | Role on this page |
| --------- | ----------------- |
| `InboxItem` (`src/pages/inbox/InboxItem.tsx`) | The current item, with exactly the inbox's clearing controls — answer, hand back, approve, send back, refine, accept, dismiss, unblock, park. A third consumer of the one card (after the inbox and the map's "Needs you"), so an action added there appears here too. Keyed by task id, so a half-typed refine form never carries over to the next item |
| `groupByAttentionKind`, `ATTENTION_GROUP_META` (`src/pages/inbox/attentionGroups.ts`) | The initial reading order (by kind, then the query's priority sort) and the kind titles |
| `FocusContext` (in the page) | What the inbox card leaves out: the description (skipped for a Suggested item, whose card already shows it) and the latest 3 comments, with an "N earlier comments" line and an **Open task** link |
| `EmptyState`, `ErrorPanel`, `Skeleton`, `ReachEyebrow` | Async states and the "FOCUS *one pool at a time*" eyebrow |

### Hooks

| Hook | Role |
| ---- | ---- |
| `useInboxQuery(projects)` | The same `?attention=true` request as the inbox — same query key, so the two pages share one cache entry and one 15s poll |
| `useTaskQuery(id)` | The current item's thread for `FocusContext` |
| `queryClient.prefetchQuery(tasks.detail(next))` | Warms the next item's thread, so Skip or a clear lands on a loaded card |
| `useRememberProjectScope(projects)` | `/inbox/focus` is in `PROJECT_SCOPED_PATHS`; the header switcher rewrites `?project=` here and keeps `?kind=` |

### API calls

Read: `GET /api/v1/tasks?attention=true&pageSize=100&sort=priority:desc[&project=…]` and `GET /api/v1/tasks/:taskId`. Writes are `InboxItem`'s — see [Inbox.md § API calls](./Inbox.md#api-calls).

## Route params

| Param | Effect |
| ----- | ------ |
| `project` | Repeatable. Narrows the queue to those projects, as on the inbox |
| `kind` | One of the [attention kinds](../features/Attention_Queue.md#the-six-kinds) (`decide`, `act`, `review`, `refine`, `suggested`, `blocked`). Narrows the session to that kind; the heading reads "Focus: Review". An unknown value is ignored (whole queue) |

Changing either starts a new session — order, cursor, and cleared count reset.

## Behavior / UI flow

1. **Order is fixed for the session.** On first load the items are taken in inbox reading order. After that the page keeps the ids it has seen, in first-seen order, and uses each poll only to learn which still wait: **new arrivals join at the end**, however urgent, so the item being read never gets pushed aside, and a cleared item stays in the order as a gap so "the one after it" is still defined.
2. **One item at a time**, with `FocusContext` underneath it. Progress above: "3 of 9 left" (position among what is still waiting) and "N cleared", plus a bar of cleared over seen. **Previous / Skip** sit on the progress row, above the card — a decision or a QA summary can run a screen long, and stepping should never need a scroll. Each new item scrolls the page back to the top.
3. **Clearing auto-advances.** Any action that takes the item out of the slice — this page's buttons, another tab, an agent, a change of kind — moves to the next remaining item after it; when it was the last, back to the first one skipped; when none remain, the finished state. Once moved on, the view never jumps back to an item that reappears.
4. **Skip** (`j` / `→`) goes to the next remaining item; past the end it wraps to the first remaining one with a line "Back to the start of what's left — these are the ones you skipped." Disabled with one item left. **Previous** (`k` / `←`) goes back without wrapping; disabled at the first remaining item.
5. **Kind chips** above the progress — "All 12 · Decide 2 · Review 7 …", counted over the whole loaded queue — link to the other slices, the current one marked.
6. **Exit** (button, or `Esc`) goes to `/inbox` in the same project scope. `o` opens the current task's page.

### Keyboard

| Key | Action |
| --- | ------ |
| `j`, `→` | Skip |
| `k`, `←` | Previous |
| `o` | Open the task |
| `Esc` | In a field: leave the field. Otherwise: exit to the inbox |

Shortcuts never fire while typing in an input, textarea, select, or contenteditable; with a modifier key held; or while a dialog is open (Send back, the transition dialog, a confirm) — the dialog owns the keyboard. A Refine item focuses its criteria box on arrival, so `Esc` first, then `j`/`k`. The hint line is hidden below `sm`, where there is usually no keyboard.

## States

| State | Behavior |
| ----- | -------- |
| Loading | One card-shaped skeleton (`aria-label="Loading focus"`) |
| Empty from the start | `EmptyState art="still-water"`, "Nothing needs you" (or "Nothing in Review needs you" for a kind) with Back to the inbox / Go to the map |
| Finished | "All clear — N items cleared", same art and actions |
| Kind slice clear, others waiting | Same panel with one primary action, **Focus on everything else (N)** → `/inbox/focus` |
| Error | `ErrorPanel` + Retry; a failed background poll keeps the current item and shows the panel above it |
| Thread loading / failed | `FocusContext` only: a small skeleton, or "Couldn't load the thread. Retry" — the item's actions above stay usable |

## Responsive

Single column, `max-w-3xl`, centred. Below `sm` the Previous / Skip buttons drop under the progress line and share the row half-and-half and the card's own buttons stack full-width (as on the inbox); the shortcut hint is hidden. Checked at 360px.

## Accessibility

- The current item sits in a focusable region (`aria-label="Current item"`). When a clear removes the focused button, focus moves to the new item rather than dropping to `<body>`; a field that focused itself keeps focus.
- Each new item is announced through a polite live region ("TASK-000042: Title").
- Progress is a `role="progressbar"` labelled "Cleared this session"; the kind chips are a `nav` labelled "Focus on" with `aria-current="page"` on the active one; Previous/Skip are a `nav` labelled "Focus".

## Related

- [Inbox.md](./Inbox.md) — the same queue, all at once, and every clearing action's exact writes
- [../features/Attention_Queue.md](../features/Attention_Queue.md) — the six attention kinds
- [App_Shell.md](./App_Shell.md) — project scope and the header switcher
