---
type: Feature
title: Ticket priority
description: Priority scale, severity-ordered sorting, and UI mapping.
resource: packages/contracts/src/ticket.ts
tags: [tickets, priority, sorting]
status: canonical
---
# Ticket priority

## Overview

| Concern | Location |
| ------- | -------- |
| Enum | `TicketPriority` in `packages/contracts/src/ticket.ts` |
| Rank mapping | `PRIORITY_RANK` in `apps/api/src/services/ticket-status.ts` |
| Badge | `apps/web/src/features/tickets/PriorityBadge.tsx` |

## Values

| Value | Rank | Intended use |
| ----- | ---- | ------------ |
| `low` | 0 | Nice to have, no deadline |
| `medium` | 1 | **Default.** Normal work |
| `high` | 2 | Blocks one person's work |
| `urgent` | 3 | Blocks a team, or a security/outage issue |

Priority is set by the requester on create and adjustable by IT afterwards. There is no escalation automation — out of scope.

## Sorting

`?sort=priority:desc` must return `urgent` first. Alphabetically that would be `urgent, medium, low, high`, which is meaningless, so priority sorting reads the persisted `priorityRank` integer instead of the string column.

**Invariant:** any write that touches `priority` must recompute `priorityRank` in the same operation. Both go through `applyTicketRanks()` in the ticket service; a raw `prisma.ticket.update({ data: { priority } })` anywhere else is a bug that corrupts sort order silently. If you add a new write path, add a test asserting sort order after it.

## UI mapping

| Priority | Badge | Icon |
| -------- | ----- | ---- |
| `low` | outline, muted | — |
| `medium` | outline, neutral | — |
| `high` | amber | `ArrowUp` |
| `urgent` | red, filled | `AlertTriangle` |

Icons are `aria-hidden`; the text label carries the meaning. On the mobile card layout, priority renders as a left border stripe plus the label so it is scannable in a stacked list.

## Related pages

- [../pages/Tickets_List.md](../pages/Tickets_List.md)
- [Ticket_Query_Filter_Sort_Page.md](./Ticket_Query_Filter_Sort_Page.md)
