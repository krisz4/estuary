---
type: Feature
title: Seed data
description: What db:seed generates and why the shape of the data matters for review.
resource: apps/api/prisma/seed.ts
tags: [database, dx, seed]
status: canonical
---
# Seed data

## Overview

| Concern | Location |
| ------- | -------- |
| Script | `apps/api/prisma/seed.ts` |
| Fixture pools | `apps/api/prisma/seed-data.ts` |
| Commands | `pnpm db:seed` (additive-safe: wipes first), `pnpm db:reset` (migrate reset + seed) |

## What it creates

**63 tickets** and **~190 comments** (0–6 per ticket, averaging 3), generated from a fixed seed value so runs are reproducible.

Distribution is chosen so the list page actually exercises its features:

| Dimension | Shape |
| --------- | ----- |
| Count | 63 tickets — more than 3 pages at the default `pageSize=20`, so paging is visible immediately |
| Status | ~40% `open`, ~25% `in_progress`, ~20% `resolved`, ~15% `closed` |
| Priority | Weighted toward `medium`, with a handful of `urgent` so severity sorting is obviously not alphabetical |
| Category | `hardware`, `software`, `network`, `access`, `email`, `other` |
| `createdAt` | Spread over the last 90 days, not all "now" — otherwise date sorting and date-range filters look broken |
| Requesters | ~15 recurring names/emails, so `requesterEmail` filtering returns a plausible set |
| Assignee | ~8 recurring IT names, ~30% unassigned so `assigneeIsNull=true` has results |
| Comments | 0–6 per ticket, timestamps after the ticket's `createdAt` |

Titles and descriptions are realistic IT issues ("Printer on floor 3 jams on duplex", "SSO redirect loop after password reset"), not `Lorem ipsum` — a reviewer scanning the list should see a believable product.

## Rules

- **Reproducible:** a fixed PRNG seed. Two developers running `db:seed` see the same 63 tickets, which makes screenshots and bug reports comparable.
- **Idempotent:** the script deletes all tickets (comments cascade) before inserting. It never appends to an existing set.
- **Guarded by `ALLOW_SEED`, not `NODE_ENV`.** The script refuses unless `ALLOW_SEED=true` or `NODE_ENV !== "production"`. Keying the guard on `NODE_ENV` alone would make the Docker image — which legitimately runs a production build *and* wants demo data — unable to seed at all. The container passes `SEED_ON_START=true` and seeds only when the table is empty. See [../operations/DOCKER.md](../operations/DOCKER.md).
- **Ids are not forced.** The seed lets autoincrement assign them, so ticket numbers behave exactly as they will in real use.
- **Comment timestamps are spread within their ticket's lifetime**, and several land in the same millisecond on purpose — that is what exercises the `id` ordering tiebreaker in [Comments.md](./Comments.md).
- Ranks (`statusRank`, `priorityRank`) are written through the same helper the service uses — seeding around it would produce data that sorts differently from data created through the API, which is a genuinely confusing bug to chase.

## Tests

Seed data is **not** used by tests. Test suites build their own fixtures against a temp database so a seed change can never break an assertion. See [../engineering/TESTING.md](../engineering/TESTING.md).

## Related

- [../engineering/DATABASE.md](../engineering/DATABASE.md)
- [Ticket_Query_Filter_Sort_Page.md](./Ticket_Query_Filter_Sort_Page.md)
