---
type: Feature
title: Seed data
description: What db:seed generates and why the shape of the data matters for review.
resource: apps/api/src/seed/index.ts
tags: [database, dx, seed]
status: canonical
---
# Seed data

## Overview

| Concern | Location |
| ------- | -------- |
| Script | `apps/api/src/seed/index.ts` |
| Fixture pools | `apps/api/src/seed/seed-data.ts` |
| Tests | `apps/api/src/seed/seed.test.ts` |
| Commands | `pnpm --filter @helpdesk/api db:seed` (wipes first), `pnpm --filter @helpdesk/api db:reset` (migrate reset + seed, via the `prisma.seed` hook) |

## What it creates

**63 tickets** and **180 comments** (0–6 per ticket, averaging 2.9), generated from a fixed seed value so runs are reproducible.

Distribution is chosen so the list page actually exercises its features:

| Dimension | Shape |
| --------- | ----- |
| Count | 63 tickets — more than 3 pages at the default `pageSize=20`, so paging is visible immediately |
| Status | ~40% `open`, ~25% `in_progress`, ~20% `resolved`, ~15% `closed`. Realised: **25 / 17 / 13 / 8** |
| Priority | Weighted toward `medium`, with a handful of `urgent` so severity sorting is obviously not alphabetical |
| Category | All six of `hardware`, `software`, `network`, `access`, `email`, `other`, plus two tickets with **no** category — a nullable field the list page still has to render |
| `createdAt` | Spread over the last 90 days, not all "now" — otherwise date sorting and date-range filters look broken. Rows are inserted oldest-first, so ticket numbers run in chronological order and `HD-000001` is the oldest ticket |
| `updatedAt` | Written explicitly rather than left to `@updatedAt`, which would stamp all 63 rows with the same instant and make `?sort=updatedAt:desc` look broken |
| Requesters | ~15 recurring names/emails, so `requesterEmail` filtering returns a plausible set |
| Assignee | 8 recurring IT names, ~30% unassigned (realised: **19 of 63**) so `assigneeIsNull=true` has results |
| Comments | 0–6 per ticket, timestamps after the ticket's `createdAt` |

Titles and descriptions are realistic IT issues ("Printer on floor 3 jams on duplex", "SSO redirect loop after password reset"), not `Lorem ipsum` — a reviewer scanning the list should see a believable product.

## Rules

- **Reproducible:** a fixed PRNG seed (`mulberry32`, no `Math.random()` anywhere). Two developers running `db:seed` see the same 63 tickets, which makes screenshots and bug reports comparable. The seed *value* is chosen rather than arbitrary: 63 draws from the weight tables is a small sample, and the first value tried produced 7 `in_progress` tickets against an expectation of 16 — which on the list page reads as a broken filter. `src/seed/seed.test.ts` asserts the realised distribution, so changing the constant is a test failure rather than a silent drift.
- **Idempotent:** the script deletes all comments and tickets before inserting, **and resets `sqlite_sequence`**, so a re-seed reuses ids 1–63 rather than continuing from 64. Without the sequence reset, "reproducible" would hold for the content of the tickets but not for their numbers, and `HD-000042` would be a different ticket on every run. It never appends to an existing set. The whole seed is one transaction, so an interrupted run cannot leave a half-populated database.
- **Guarded by `ALLOW_SEED`, not `NODE_ENV`.** The script refuses unless `ALLOW_SEED=true` or `NODE_ENV !== "production"`. Keying the guard on `NODE_ENV` alone would make the Docker image — which legitimately runs a production build *and* wants demo data — unable to seed at all. The container passes `SEED_ON_START=true` and seeds only when the table is empty. See [../operations/DOCKER.md](../operations/DOCKER.md).
- **It lives under `src/`, not under `prisma/`.** That is a build constraint, not a preference: `tsconfig.build.json` has `rootDir: "src"`, and the runtime image runs the *compiled* seed because `tsx` is a devDependency that is not installed there ([../operations/DOCKER.md](../operations/DOCKER.md)). A file outside `rootDir` cannot be added to the build at all, so the choice was between moving it and shipping a TypeScript runner into production. `prisma/` keeps the schema and the migrations; the `prisma.seed` hook in `apps/api/package.json` names the file, which is all Prisma needs.
- **Ids are not forced.** The seed lets autoincrement assign them, so ticket numbers behave exactly as they will in real use.
- **Lifecycle timestamps match what the API would have produced.** A `resolved` ticket carries a `resolvedAt` and no `closedAt`; a `closed` ticket carries both, with `resolvedAt <= closedAt` — the same "closed implies resolved" backfill `applyStatusSideEffects()` performs. An `open` or `in_progress` ticket carries neither.
- **Comment timestamps are spread within their ticket's lifetime**, and several land in the same millisecond on purpose — that is what exercises the `id` ordering tiebreaker in [Comments.md](./Comments.md).
- Ranks (`statusRank`, `priorityRank`) are written through **`applyTicketRanks()`**, the same helper the service uses. Seeding around it does more than produce data that sorts oddly: since the list query pushes the rank predicate as well as the text one, a rank-drifted row matches **no** status or priority filter at all — it disappears from every filtered page and from `meta.total` while still reading back perfectly over `GET /tickets/:id`. The seed's write type deliberately has no rank fields, so the compiler enforces this rather than the reader; `src/seed/seed.test.ts` asserts it twice, once by sorting and once by grepping the source for a direct rank write.

## Tests

Seed data is **not** used by tests. Test suites build their own fixtures against a temp database so a seed change can never break an assertion. See [../engineering/TESTING.md](../engineering/TESTING.md).

The one exception is `apps/api/src/seed/seed.test.ts`, which tests *the seed itself* — count, determinism, distribution, lifecycle invariants, idempotency, and the rank invariant. It runs against the worker's temp database like every other suite and no other file reads what it writes.

## Related

- [../engineering/DATABASE.md](../engineering/DATABASE.md)
- [Ticket_Query_Filter_Sort_Page.md](./Ticket_Query_Filter_Sort_Page.md)
