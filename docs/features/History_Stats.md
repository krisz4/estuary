---
type: Feature
title: History stats
description: GET /stats/history — the Logbook's charts. Buckets, the cumulative-flow snapshot, human-wait and cycle-time percentiles, and per-agent activity, all computed from TaskEvent.
resource: apps/api/src/services/history.service.ts
tags: [tasks, history, logbook, events, api]
status: canonical
---
# History stats

`GET /api/v1/stats/history` — everything the Logbook's charts need (`docs/pages/Floor_And_Logbook_Plan.md`), computed from `TaskEvent`. No new tables: `task.created`, `task.status_changed`, `task.claimed`, `task.released`, `decision.requested`, and `decision.answered` events already carry everything required.

## Overview

| Concern | Location |
| ------- | -------- |
| Query + response schemas | `packages/contracts/src/history.ts` |
| Service | `apps/api/src/services/history.service.ts` |
| Route | `GET /api/v1/stats/history` in `apps/api/src/routes/history.route.ts` |

## Query

`project` (repeatable, scopes by the project recorded **on the event**, same as `GET /events?project=`), `from` / `to` (instants; `to` defaults to now, `from` defaults to 7 days before `to`), `bucket` (`hour` / `day` / `week`, default `day`).

**The response's `from`/`to` are the *aligned* bucket boundaries, not the raw query params.** `from` is floored to the start of its bucket (UTC hour, UTC day, or Monday-starting UTC week); `to` is ceiled to the next boundary. `?from=2026-09-01T10:15:00Z&bucket=hour` comes back as `from: "2026-09-01T10:00:00.000Z"`. Every count and chart in the response covers exactly the aligned range — nothing is silently dropped at an unaligned edge.

A range producing more than `HISTORY_MAX_BUCKETS` (400) buckets is `VALIDATION_ERROR` (422, `details.bucket`) rather than a slow or enormous response — narrow the range or choose a bigger bucket.

## Per-bucket rows

Each `buckets[]` row covers `[start, end)`:

- `created` / `completed` / `deferred`: `task.created` events, and `task.status_changed` events with `to: "done"` / `to: "deferred"`, whose `createdAt` falls in the bucket.
- `sentBack`: `task.status_changed` events with `from: "needs_qa"` and `to` anything but `done` or `deferred` — a QA rejection.
- `statusCounts`: **a full replay from the beginning of the event log**, not just the requested window — the cumulative-flow diagram's whole point is that an old task already `done` before `from` still occupies the `done` column in every bucket. One task in, or with a deleted `task.deleted` event, drops out of every later bucket's counts.
- `humanWait`: percentiles over stints in a human-wait status (`needs_user_decision`, `needs_user_action`, `needs_qa`) that **ended** in this bucket.

## Totals, cycle times, longest waits, agents

- **`totals`** sums the per-bucket counts over the whole aligned range, plus `decisionsRequested` / `decisionsAnswered` (`decision.requested` / `decision.answered` event counts) and range-wide `humanWait` / `cycleTime` percentiles.
- **`cycleTimes`** (newest finished first, capped at `HISTORY_MAX_CYCLE_TIMES`): one entry per pass from `in_progress` to `needs_qa` or `done` that finished in range, attributed to whichever actor made that closing transition. A task sent back and resubmitted produces a second, independent pass.
- **`longestWaits`** (longest first, capped at `HISTORY_LONGEST_WAITS`): stints in a human-wait status that overlap the range, including ones still open (`endedAt: null`) — an open stint's duration is measured against *now*, not the range's `to`, since it is genuinely still waiting.
- **`agents`**: actors whose stored value starts `agent:` and did anything in range, most `submitted` first. `submitted` counts that actor's `→ needs_qa` transitions; `approved` / `sentBack` count what happened next to those same submissions (`needs_qa → done` / `needs_qa → anything else`, matching the `sentBack` rule above) — a `needs_qa → deferred` outcome counts as neither. `claims` / `releases` count that actor's `task.claimed` / `task.released` events; there is no separate "lease expired" event type, so an abandoned claim that simply times out is not counted here.
- **`title`** on a `cycleTimes` or `longestWaits` row is `null` when the task has since been deleted — looked up from the current `Task` table, not stored on the event.

## Performance

One event query (filtered by type and, if given, project) drives every bucket, every total, and every stint/cycle computation in a single ordered pass — not one query per bucket. If this gets slow on a large installation's event log, add an index on `TaskEvent(type, createdAt)` — flagged for `db-migrator`, not created by this change.

## Related

- [../pages/Floor_And_Logbook_Plan.md](../pages/Floor_And_Logbook_Plan.md) — the Logbook page this endpoint feeds
- [Task_Workflow_API.md](./Task_Workflow_API.md) — the event types and payload shapes this endpoint reads
- [Floor_Snapshot.md](./Floor_Snapshot.md) — the sibling endpoint that replays status at a single instant, rather than over a range
