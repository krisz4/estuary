---
type: Feature
title: Seed data
description: What db:seed generates — tasks, threads, decisions, dependencies, and events — and why the shape of the data matters for review.
resource: apps/api/src/seed/index.ts
tags: [database, dx, seed]
status: canonical
---
# Seed data

## Overview

| Concern | Location |
| ------- | -------- |
| Generator + writer | `apps/api/src/seed/index.ts` |
| Task content (templates, actors, working notes) | `apps/api/src/seed/seed-data.ts` |
| Tests | `apps/api/src/seed/seed.test.ts` |
| Commands | `pnpm --filter @helpdesk/api db:seed` (wipes first), `pnpm --filter @helpdesk/api db:reset` (migrate reset + seed, via the `prisma.seed` hook) |

## What it creates

**62 tasks** across three projects, plus everything they would have accumulated had they really been worked through the API: **85 comments**, **7 decisions**, **8 dependencies**, and **327 events**. Runs are reproducible. The same `now` always gives the same rows and ids.

| Dimension | Shape |
| --------- | ----- |
| Count | 62 tasks: three full pages and a partial fourth at the default `pageSize=20` |
| Status | Every one of the ten statuses. More in the plan and closed lanes, a handful in each attention status (table below) |
| Projects | `helpdesk` 22, `billing-service` 21, `mobile-app` 17, plus 2 with **no** project. Null is a state every screen has to render |
| Creators | Agents `agent:claude-code` (18), `agent:claude-code-ci` (8), `agent:claude-code-nightly` (2); humans `human:dana` (11), `human:krisz` (10), `human:marco` (8), `human:lena` (5) |
| Priority | low 14 / medium 22 / high 20 / urgent 6, so severity sorting is visibly not alphabetical |
| Assignee | The actor who worked the task, or a named human on a few backlog items. 23 unassigned, so `assigneeIsNull=true` has results |
| `createdAt` | Spread over the last 60 days (about 1 to 58 days old). Rows are inserted oldest-first, so task numbers run in chronological order and `TASK-000001` is the oldest |
| Subtasks | Three parents with three children each (`parentId`): the MCP server, PDF rendering, offline mode |
| Links | 21 tasks carry PR/branch links under `https://github.com/example-org/<project>/…`: every `needs_qa` and `done` task, plus a couple of `needs_user_action` tasks with a PR |
| `idempotencyKey` | On every agent-created task, `<agent-name>:<project>:<slug>` (for example `claude-code:billing-service:vies-client`), unique |

### Status distribution

| Status | Count | What the seed gives it |
| ------ | ----- | ---------------------- |
| `backlog` | 12 | Filed and not yet specified |
| `needs_refinement` | 4 | `statusNote` says what is unclear (set by an agent that tried to pick it up) |
| `todo` | 8 | Acceptance criteria. One is back from an answered decision (`statusNote` = `Decision: …`). One depends on a task that is already `done` (ready), two on unfinished tasks |
| `in_progress` | 6 | A claim and `startedAt`. **4 live leases** (heartbeat minutes ago, `claimExpiresAt = heartbeat + CLAIM_LEASE_MINUTES`) and **2 expired** leases from agents that went quiet 1.5–3.5 days ago, to demo crash recovery through `POST /tasks/next`. One is a human's own claim. One carries an answered decision from earlier in its life |
| `blocked` | 4 | A reason in `statusNote` and at least one **unfinished** blocker, added through the transition's `blockedBy`. A blocked task whose blockers were all done would already have been auto-unblocked |
| `needs_user_decision` | 4 | Exactly one **open** `Decision`: question, 3 options, a `recommendedOption` that is one of the labels, and context. `statusNote` is the question |
| `needs_user_action` | 3 | Step-by-step instructions for the human in `statusNote` |
| `needs_qa` | 5 | A change summary with verification steps in `statusNote`, plus links |
| `done` | 14 | `completedAt` and links. Each went through `needs_qa` and was closed by a human. Two were **sent back from QA once** (a `qa_feedback` comment and a trip back to `todo`) before passing. One carries an answered decision |
| `deferred` | 2 | The reason it is parked, in `statusNote` |

### Threads and history

- **Comments** are `progress` (76: an agent's working notes, one to three per stretch of `in_progress`, drawn from a pool), `note` (7: human discussion and agent replies written for specific tasks), and `qa_feedback` (2).
- **Decisions:** 4 open, one per `needs_user_decision` task, and 3 answered on tasks that have since moved on (`done`, `in_progress`, `todo`). Answers come from humans and pick one of the offered labels.
- **Dependencies:** 8 edges. Every edge points from a newer task to an older one, so the graph is acyclic by construction. The generator rejects a template that breaks this.
- **Events:** each task has a `task.created` first, then one event for every write it went through: `task.status_changed`, `task.claimed`, `comment.created`, `decision.requested`, `decision.answered`, `dependency.added`. Payloads match [Task_Workflow_API.md](./Task_Workflow_API.md#events) and use real ids (`commentId`, `decisionId`, `dependsOnId`). Replaying a task's `status_changed` chain from its `task.created` status arrives at its current status and `statusNote`. **Event ids are chronological across the whole table**, as are comment and decision ids, so an `after=<id>` poller reads history in the order it happened.

Titles and descriptions are realistic software work ("Idempotency keys for POST /refunds", "Crash on launch on iOS 17.0 when the keychain is empty"), not `Lorem ipsum`. A reviewer scanning the board should see a believable product.

## Rules

- **Statuses are authored; timings are drawn.** Each template in `seed-data.ts` states its status and the content that status requires (reason, question, summary, blockers). `index.ts` derives the history that would have produced it and replays it into rows and events, following the workflow service's rules:
  - a claim is a transition to `in_progress`;
  - agents hand off at `needs_qa` and humans move work to `done`;
  - answering a decision sends the task to `todo`;
  - `startedAt` is set on the first claim and never cleared;
  - `statusNote` is the note of the last transition.

  The PRNG only decides *when* things happened and which working notes were left.
- **Reproducible:** a fixed PRNG seed (`mulberry32`, no `Math.random()` anywhere), and every time is an offset from the `now` passed in. Two developers running `db:seed` see the same tasks with the same numbers. That makes screenshots and bug reports comparable. Since statuses are authored, the seed *value* is not tuned for a distribution. `seed.test.ts` asserts the structural rules across several seed values, so a rule cannot hold by luck.
- **Live leases expire in real time.** A live claim lasts `CLAIM_LEASE_MINUTES` after its last heartbeat, exactly as an API claim does. About half an hour after seeding (with the default lease), the four "live" claims have lapsed too. `POST /tasks/next` will then hand them out as recoverable work. Re-seed for fresh claims.
- **Idempotent:** the script deletes every row from `TaskEvent`, `Decision`, `TaskDependency`, `Comment`, and `Task` before inserting. It also resets `sqlite_sequence`, so a re-seed reuses the same ids rather than continuing the count. Without that reset, "reproducible" would hold for content but not for numbers, and `TASK-000042` would be a different task on every run. `TaskEvent` is cleared explicitly because it has no foreign key and is not cascaded. The whole seed is one transaction, so an interrupted run cannot leave a half-populated database.
- **Guarded by `ALLOW_SEED`, not `NODE_ENV`.** The script refuses unless `ALLOW_SEED=true` or `NODE_ENV !== "production"`. Keying the guard on `NODE_ENV` alone would stop the Docker image from seeding at all, and that image legitimately runs a production build *and* wants demo data. The container passes `SEED_ON_START=true` and seeds only when the task table is empty. See [../operations/DOCKER.md](../operations/DOCKER.md).
- **It lives under `src/`, not under `prisma/`.** That is a build constraint, not a preference. `tsconfig.build.json` has `rootDir: "src"`, and the runtime image runs the *compiled* seed because `tsx` is a devDependency that is not installed there ([../operations/DOCKER.md](../operations/DOCKER.md)). A file outside `rootDir` cannot be added to the build at all. `prisma/` keeps the schema and the migrations; the `prisma.seed` hook in `apps/api/package.json` names the file, which is all Prisma needs.
- **Ids are not forced.** Autoincrement assigns them. Tasks are inserted oldest-first. Comments, decisions, and events are each inserted in time order across all tasks. Parents are always older than their children, so a child's `parentId` is known at insert time.
- **Comment timestamps fall within their task's lifetime**, and in four tasks two working notes land in the same millisecond on purpose. That is what exercises the `id` ordering tiebreaker in [Comments.md](./Comments.md).
- Ranks (`statusRank`, `priorityRank`) are written through **`applyTaskRanks()`**, the same helper the services use. Bypassing it does more than produce data that sorts oddly. The list query pushes the rank predicate as well as the text one, so a rank-drifted row matches **no** status or priority filter. It disappears from every filtered page and from `meta.total`, while still reading back perfectly over `GET /tasks/:id`. The seed's write type has no rank fields, so the compiler enforces this rather than the reader. `src/seed/seed.test.ts` asserts it twice: once by sorting, once by grepping the source for a direct rank write.

## Tests

Seed data is **not** used by tests. Test suites build their own fixtures against a temp database so a seed change can never break an assertion. See [../engineering/TESTING.md](../engineering/TESTING.md).

The one exception is `apps/api/src/seed/seed.test.ts`, which tests *the seed itself*. On the pure builder, across five PRNG seeds, it checks:

- count, determinism, and chronological ids;
- the status table above, with every status represented;
- contract validity of every field and actor;
- claims only on `in_progress`, with two lapsed;
- notes, acceptance criteria, and links per status;
- lifecycle timestamp order;
- idempotency keys unique and agent-only;
- exactly one open, schema-valid decision per `needs_user_decision` task;
- answered decisions picking an offered label;
- no dependency cycles, and at least one unfinished blocker per blocked task;
- an event trail that replays to each task's current status and note.

Against the worker's temp database it checks:

- row counts in all five tables;
- idempotent re-seeding with reused ids;
- the rank invariant, by sorting and through the list filters;
- one open decision per waiting task;
- an acyclic stored graph;
- chronological event, comment, and decision ids;
- that every id inside an event payload resolves to a row of the same task.

No other file reads what it writes.

## Related

- [../engineering/DATABASE.md](../engineering/DATABASE.md)
- [Task_Workflow_API.md](./Task_Workflow_API.md)
- [Task_Query_Filter_Sort_Page.md](./Task_Query_Filter_Sort_Page.md)
