---
type: Feature
title: Ticket status lifecycle
description: Status values, legal transitions, and the timestamp side effects they trigger.
resource: apps/api/src/services/ticket-status.ts
tags: [tickets, status, workflow]
status: canonical
---
# Ticket status lifecycle

## Overview

| Concern | Location |
| ------- | -------- |
| Enum | `TicketStatus` in `packages/contracts/src/ticket.ts` |
| Transition table + guard | `apps/api/src/services/ticket-status.ts` (`assertTransition`, `applyStatusSideEffects`) |
| Rank mapping for sorting | Same file (`STATUS_RANK`) |
| UI badge + picker | `apps/web/src/features/tickets/StatusBadge.tsx`, `StatusSelect.tsx` |

## States

| Value | Meaning | Rank |
| ----- | ------- | ---- |
| `open` | Filed, nobody working it yet | 0 |
| `in_progress` | An IT person is actively on it | 1 |
| `resolved` | Fix delivered, awaiting confirmation | 2 |
| `closed` | Terminal | 3 |

`rank` is persisted as `statusRank` and exists only so SQLite can sort by lifecycle order instead of alphabetically. It is derived — never accept it from a client, and always set it through `applyTicketRanks()`.

## Transitions

```
open ──────► in_progress ──────► resolved ──────► closed
 │                 │                  │              │
 │                 └──────────────────┴──────────────┘
 │                        (reopen ► open / in_progress)
 └──────────────────────────────────────────────► closed
```

| From | Allowed to |
| ---- | ---------- |
| `open` | `in_progress`, `resolved`, `closed` |
| `in_progress` | `open`, `resolved`, `closed` |
| `resolved` | `in_progress`, `closed`, `open` (reopen) |
| `closed` | `open`, `in_progress` (reopen) |

Every transition is legal except `closed → resolved`, which is rejected with `INVALID_STATUS_TRANSITION` (409): a closed ticket reopens to active work, it does not slide back into "awaiting confirmation".

The guard is deliberately permissive — this is a helpdesk, not an approval workflow, and an over-strict table produces support tickets about the ticket system.

### Setting the status it already has

`X → X` is a **success that performs no write**. The service compares before updating and returns the existing row untouched.

This matters because of `@updatedAt`: if a same-status PATCH reached Prisma, `updatedAt` would move and the ticket would jump to the top of an `updatedAt` sort without anything having changed. "No-op" has to mean no write, not a write of identical values.

(A PATCH containing status *and* a genuinely changed field still writes — the short-circuit is per-field, applied when status is the only difference.)

## Side effects

Applied in `applyStatusSideEffects()`, inside the same write:

| Transition | Effect |
| ---------- | ------ |
| → `resolved` | `resolvedAt = now` (only if currently null) |
| → `closed` | `closedAt = now`; `resolvedAt ??= now` |
| `resolved` or `closed` → `open` or `in_progress` | `resolvedAt = null`, `closedAt = null` |

The third row is stated as an explicit pair of source states, not "from a terminal state" — only `closed` is terminal, so that phrasing left `resolved → in_progress` undefined and would have stranded a stale `resolvedAt` on a ticket that is demonstrably not resolved. **Reopening from either state clears both timestamps.**

`closed` backfilling `resolvedAt` means a ticket closed straight from `open` reports a resolution time it never really had. That is deliberate — it keeps "closed implies resolved" true for any consumer — but worth knowing before computing time-to-resolution from this data.

`updatedAt` is Prisma-managed and moves on every write that actually happens.

## UI mapping

| Status | Badge | Notes |
| ------ | ----- | ----- |
| `open` | slate / neutral | Default filter chip on the list page |
| `in_progress` | blue | |
| `resolved` | green | |
| `closed` | muted grey, lower contrast text | Visually recedes so active work reads first |

Color alone never carries the meaning — the badge always renders the text label too. See [../engineering/UI_DESIGN_GUIDELINES.md](../engineering/UI_DESIGN_GUIDELINES.md).

## Error codes

| Code | Status | When |
| ---- | ------ | ---- |
| `INVALID_STATUS_TRANSITION` | 409 | `closed → resolved`. `details` carries `{ from, to, allowed: [...] }` |
| `VALIDATION_ERROR` | 422 | Status string not in the enum |

## Related pages

- [../pages/Ticket_Detail.md](../pages/Ticket_Detail.md) — inline status change
- [../pages/Ticket_Edit.md](../pages/Ticket_Edit.md) — status in the edit form
- [Tickets.md](./Tickets.md)
