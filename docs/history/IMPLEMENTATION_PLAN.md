# Implementation plan

> **Historical.** This describes the original build order for the **helpdesk ticketing system** —
> the code challenge this project started as, before the pivot to an AI task manager (agents via
> MCP + humans). It is left unedited as a record of how the initial system was built; it does not
> describe current behavior. For the system as it stands, start at [../AGENTS.md](../AGENTS.md) and
> [../features/README.md](../features/README.md).

Build order for the original helpdesk system, from an empty repo to a dockerised, tested, documented app.

The specs in `docs/` describe the **finished** system; this file describes the **order** in which to reach it and the gate that closes each stage. Where the two disagree, the spec wins — this is a schedule, not a source of truth.

**How to use it:** work top to bottom. A stage is done when its gate passes, not when its files exist. Do not start a stage whose dependencies are unmet — the dependency graph at the bottom shows what is actually parallelisable.

## Principles behind the ordering

1. **Contracts before consumers.** `packages/contracts` is the only place a shape is defined, so it is built before anything that would otherwise hand-write a duplicate. This is checklist rule #1 in [../../CLAUDE.md](../../CLAUDE.md).
2. **Test harness before the code it tests.** The `setupFiles` detail in [TESTING.md](../engineering/TESTING.md) means a late-added harness runs the entire suite against the developer's real database exactly once, and you discover it by losing that database.
3. **Highest-risk logic early, while there is time to get it wrong.** The list query (stage 7) carries the most graded weight and the most known traps; it lands before any UI exists to distract from it.
4. **Each stage ends at something demonstrable.** A gate is a command that passes or a screen that renders — never "the files are written".
5. **Docs are edited in the stage that changes behavior**, not swept up at the end. The exception is stage 16, which reconciles what implementation actually settled.

---

## Phase 0 — Workspace

### Stage 1 · Monorepo shell

| | |
| --- | --- |
| **Deliverables** | `pnpm-workspace.yaml`, root `package.json` (scripts: `dev`, `build`, `typecheck`, `lint`, `test`, `test:e2e`), `turbo.json`, `packages/tsconfig/*` bases, root `.gitignore`, `.editorconfig`, eslint + prettier config |
| **Depends on** | — |
| **Gate** | `pnpm install` succeeds; `pnpm typecheck` and `pnpm lint` run clean on the empty graph |

`.gitignore` must cover `apps/api/prisma/data/`, `*.db`, `*.db-wal`, `*.db-shm`, `.env`, `e2e/helpdesk-e2e.db` from the very first commit. A database file committed in stage 3 and removed in stage 14 stays in history forever.

Turborepo task graph: `build` depends on `^build`, `typecheck` depends on `^build`, `test` depends on `^build`. Getting this right now means `packages/contracts` is always compiled before the apps that import it.

---

## Phase 1 — Contracts

### Stage 2 · `packages/contracts`

| | |
| --- | --- |
| **Deliverables** | `src/errors.ts` (`ApiErrorCode` union, envelope schema), `src/pagination.ts` (`meta` shape), `src/task.ts` (enums, create/update/response schemas), `src/task-query.ts` (`taskListQuerySchema`), `src/comment.ts`, `src/index.ts` barrel, plus `*.test.ts` for each |
| **Depends on** | 1 |
| **Gate** | `pnpm --filter @helpdesk/contracts test` green; package builds and imports cleanly from a scratch file in both a Node and a Vite context |

Reference: [../features/Validation_And_Contracts.md](../features/Validation_And_Contracts.md), [../features/Tasks.md](../features/Tasks.md), [../features/Task_Query_Filter_Sort_Page.md](../features/Task_Query_Filter_Sort_Page.md).

Build these four behaviors here, not later — every one of them is a downstream bug if deferred:

- **`.strict()` on create/update.** A payload containing `id` or `createdAt` is a 422, not a silent strip.
- **Empty string → `null`** on `assignee` and `category`: `z.string().trim().transform(v => v === "" ? null : v).nullable().optional()`. Skipping this makes cleared fields match neither `assigneeIsNull=true` nor any name filter.
- **Empty query values are absent, not malformed.** A preprocessor drops `""` before parsing, so `?page=&status=` behaves like `?`. Without it `z.coerce.number()` turns `""` into `0` and fails `min(1)`.
- **`assignee` + `assigneeIsNull` together is a `VALIDATION_ERROR`**, expressed as a `superRefine` on the query schema.

Contracts stay runtime-agnostic: zod and nothing else. No `node:*`, no Express, no Prisma, no React — it is bundled into browser code, and a stray `node:crypto` surfaces as a Vite error pointing at a transitive file.

The `ApiErrorCode` union must match [API_ERROR_CONTRACT.md](../engineering/API_ERROR_CONTRACT.md) exactly, including the deliberate absence of `METHOD_NOT_ALLOWED` and `CONFLICT`.

---

## Phase 2 — API

### Stage 3 · Prisma schema + first migration

| | |
| --- | --- |
| **Deliverables** | `apps/api/prisma/schema.prisma`, migration `init_task_and_comment`, `src/lib/prisma.ts`, `src/lib/env.ts` (zod-parsed, the only `process.env` reader), `apps/api/env.example` |
| **Depends on** | 2 |
| **Gate** | `db:migrate` applies to an empty file; `prisma generate` succeeds; a scratch script writes and reads a task |

Schema exactly as [DATABASE.md](../engineering/DATABASE.md) specifies — both rank columns and all seven indexes in the first migration, so no follow-up migration is needed to make sorting work.

`lib/prisma.ts` instantiates the client **at import time** from `DATABASE_URL`. That is deliberate and it is what stage 5 has to work around; do not lazily initialise it to "fix" the test problem.

### Stage 4 · App skeleton, middleware, error envelope

| | |
| --- | --- |
| **Deliverables** | `src/app.ts` (factory, no `listen`), `src/server.ts`, `middleware/requestId.ts`, `middleware/errorHandler.ts`, `middleware/notFound.ts`, `lib/errors.ts` (`ApiError`), `lib/logger.ts`, `lib/serialize.ts`, `GET /health` |
| **Depends on** | 3 |
| **Gate** | supertest: `/health` → 200; unknown route → 404 `NOT_FOUND` in the envelope; malformed JSON → 400 `MALFORMED_JSON`; oversized body → 413 `PAYLOAD_TOO_LARGE`; a forced throw → 500 `INTERNAL_ERROR` with no stack trace |

Order in the chain: `requestId` → cors (`ALLOWED_ORIGINS`) → json parser (`BODY_LIMIT`) → routers → `notFound` → `errorHandler`.

`cors` must precede the parser. A parser failure calls `next(err)`, which skips the rest of the
non-error chain, so mounting `cors` after it sends `MALFORMED_JSON` and `PAYLOAD_TOO_LARGE` without
CORS headers — the browser then reports them as opaque network errors and the web client never sees
the code. This line said the reverse until stage 4 proved it wrong.

Handle the two body-parser failures **now**. They arrive as `entity.parse.failed` and `entity.too.large` on the error object rather than as anything route-shaped, and retrofitting them once routes exist means re-testing every endpoint. `GET /health` sits at the root, outside `/api/v1`, because Docker healthchecks it.

`serialize.ts` owns `Date` → ISO conversion and computes `reference` (`TASK-000042`). It is a single function so no route can forget it.

### Stage 5 · Test harness

| | |
| --- | --- |
| **Deliverables** | `apps/api/vitest.config.ts`, `vitest.setup.ts` (registered as `setupFiles`), `vitest.globalSetup.ts`, `src/test/factories.ts` (`makeTask`, `makeComment`) |
| **Depends on** | 4 |
| **Gate** | A throwaway service test passes **and** `apps/api/prisma/data/helpdesk.db` has an unchanged mtime afterwards. Two test files running in parallel do not deadlock |

Non-negotiable per [TESTING.md](../engineering/TESTING.md): `DATABASE_URL` is assigned in a `setupFiles` entry, **never** in `beforeAll`. Test modules import `lib/prisma.ts` before any hook runs, so a `beforeAll` assignment lands after the client has already bound to the dev database.

Each worker gets `${os.tmpdir()}/helpdesk-test-${VITEST_WORKER_ID}.db`, migrated with `prisma migrate deploy` in `globalSetup`, truncated in `beforeEach`, removed at teardown. Per-worker rather than per-file — vitest parallelises across workers and SQLite has one writer.

Verify the mtime assertion by hand once. It is the only check that proves the isolation actually works, and it is cheap insurance against the failure mode that costs a developer their local data.

### Stage 6 · Task service — CRUD, status lifecycle, ranks

| | |
| --- | --- |
| **Deliverables** | `services/task-status.ts` (`STATUS_RANK`, `PRIORITY_RANK`, `applyTaskRanks`, `assertTransition`, `applyStatusSideEffects`), `services/task.service.ts` (get / create / update / delete / facets), unit tests |
| **Depends on** | 5 |
| **Gate** | Every task + lifecycle case in [TESTING.md](../engineering/TESTING.md) passes at the service level |

The invariants that need tests written alongside the code, not after:

- **`applyTaskRanks()` is the only writer of `statusRank` / `priorityRank`.** Assert it by *sorting*, never by reading the column — a test that reads the column passes even when a second write path bypasses the helper.
- **Same-status PATCH performs no write.** Assert `updatedAt` is unchanged. "No-op" must mean no write, not a write of identical values, or `@updatedAt` bumps the task to the top of an `updatedAt` sort for free.
- **Reopening from `resolved` *or* `closed` clears both timestamps.** `resolved → in_progress` is the case that gets missed and strands a stale `resolvedAt`.
- **`closed → resolved` is the only illegal transition** → 409 with `details: { from, to, allowed }`.
- **PATCH and DELETE check existence explicitly** before writing, rather than relying on Prisma `P2025`.

### Stage 7 · List query service

| | |
| --- | --- |
| **Deliverables** | `services/task-query.ts` (`buildWhere`, `buildOrderBy`, `parseReference`), paging via `prisma.$transaction([findMany, count])`, `lib/pagination.ts` |
| **Depends on** | 6 |
| **Gate** | The full "List query" section of [TESTING.md](../engineering/TESTING.md) passes — it is the longest list in that document for a reason |

**This is the highest-risk stage in the project.** Task 3 of the brief, the most-graded surface, and the home of four known traps:

| Trap | Symptom if wrong | The test that catches it |
| ---- | ---------------- | ------------------------ |
| `q` branches hoisted to the top-level `AND` | Search *widens* past the active filters | A task matching `q` but not the status filter is absent |
| Priority sorted as text | `high` before `urgent` | Sorting by priority puts `urgent` first |
| No `id` tiebreaker on non-unique sorts | Rows repeat or vanish across pages | Page 1 ∪ page 2 ids are disjoint and cover the set |
| `createdTo` as a naive `lte` | The named day is excluded — reads as off-by-one | `createdTo` = a task's own creation date includes it |

The `q` clause is **one `OR` group nested inside the top-level `AND`**. `createdTo` expands to exclusive-next-day. The `{ id: "desc" }` tiebreaker is appended except when `id` is already the sort field. `totalPages` is `Math.max(1, ceil(total / pageSize))` so the pager never renders "Page 1 of 0"; `hasNextPage` is `page < totalPages`, so it is `false` on an over-the-end page.

`pageSize=101` is **rejected, not clamped** — clamping hides a client bug.

### Stage 8 · Routes

| | |
| --- | --- |
| **Deliverables** | `routes/tasks.route.ts`, `routes/comments.route.ts`, `services/comment.service.ts`, router mounting under `/api/v1`, integration tests |
| **Depends on** | 7 |
| **Gate** | Every error code in [API_ERROR_CONTRACT.md](../engineering/API_ERROR_CONTRACT.md) has a test that produces it. Routes contain no Prisma import; services contain no `req`/`res` |

Two ordering rules that fail confusingly if missed:

- **`/tasks/facets` is declared before `/tasks/:taskId`**, or `facets` parses as an id, fails numeric coercion, and 404s.
- **A non-numeric `:taskId` returns 404, not 422.** A malformed id and a missing task are indistinguishable to a caller.

Comments: `POST` does an explicit `findUnique` on the parent first — a missing parent raises Prisma `P2003`, not `P2025`, so an unguarded insert surfaces as a 500 instead of the documented 404. `DELETE` scopes by both ids with `deleteMany({ where: { id, taskId } })` and treats a zero count as `COMMENT_NOT_FOUND`, so the path cannot probe for other tasks' comment ids.

`PUT` is deliberately not implemented. Comment writes do not touch `Task.updatedAt`.

### Stage 9 · Seed + OpenAPI

| | |
| --- | --- |
| **Deliverables** | `prisma/seed-data.ts` (fixture pools), `prisma/seed.ts`, `db:*` scripts, `lib/openapi.ts`, `openapi:gen` script, committed `openapi.json`, `/docs` Swagger UI behind `DOCS_ENABLED` |
| **Depends on** | 8 |
| **Gate** | `pnpm --filter @helpdesk/api db:reset` yields 63 tasks that page, filter, and sort correctly through the real API; `/docs` renders every endpoint |

Seed lands before any UI work so the list page has realistic data from its first render. Per [../features/Seed_Data.md](../features/Seed_Data.md): fixed PRNG seed, idempotent (wipes first), guarded by `ALLOW_SEED` rather than `NODE_ENV`, ids left to autoincrement, `createdAt` spread over 90 days, ~30% unassigned, several comments deliberately colliding in the same millisecond.

The seed writes ranks **through `applyTaskRanks()`**. Seeding around the helper produces data that sorts differently from data created through the API — a genuinely confusing bug to chase.

Tests never use the seed; that stays true from here on.

---

## Phase 3 — Web

### Stage 10 · Shell + API client

| | |
| --- | --- |
| **Deliverables** | Vite + React 19 + TS app, Tailwind config + tokens in `index.css`, `App.tsx` router, `components/layout/*` (header, skip link, landmarks), providers (QueryClient, Sonner, ErrorBoundary), `api/http.ts`, `api/queryKeys.ts`, `lib/cn.ts`, `lib/formatting.ts`, `lib/errorMessages.ts`, `apps/web/env.example` |
| **Depends on** | 9 (needs a running API to develop against) |
| **Gate** | `pnpm dev` serves web on 5173 against API on 4000 with no CORS error; a scratch component fetches `/tasks` and renders the count; dark mode toggles without an undefined token |

`/tasks/new` is declared **before** `/tasks/:taskId` in the router. `http.ts` unwraps the envelope and turns any non-2xx into `ApiClientError { code, message, details, requestId, status }`; UI copy is keyed off `code` in `errorMessages.ts`, with an unrecognised code falling back to generic rather than rendering raw server text.

Define both light and dark values for every token now. A color defined only in the light block looks wrong in dark, and finding those later means re-auditing every screen.

Also build the `components/ui/` primitives here (Button, Input, Textarea, Select, Badge, Dialog, Skeleton) — every page in stages 11–12 consumes them, and building them per-page produces three slightly different buttons.

### Stage 11 · Tasks list page

| | |
| --- | --- |
| **Deliverables** | `pages/tasks-list/`, `useTaskListParams.ts`, `features/tasks/TaskFilterBar.tsx`, `TaskTable.tsx`, `TaskCardList.tsx`, `StatusBadge.tsx`, `PriorityBadge.tsx`, `Pagination.tsx`, `api/tasks.ts` hooks |
| **Depends on** | 10 |
| **Gate** | Filter, sort, and page all round-trip through the URL and survive reload and back/forward. Renders correctly at 360, 768, and 1280 |

Built first among the pages because it exercises the URL-state helper, the query hooks, and the responsive rules that every other screen reuses.

- **`useTaskListParams()` picks known keys** and validates them; it does **not** reuse the server's `.strict()` schema on raw params. A shared link carrying `?utm_source=slack` must not fail the parse and reset every filter. Invalid individual values fall back to that field's default.
- **Changing any filter resets `page` to 1**; changing `page` never touches filters. Forgetting this lands users on an empty page 5 of a 1-page result — the most common bug on this screen.
- `q` is debounced 300ms and written with `replace` so typing does not fill the history stack.
- Assignee options come from `GET /tasks/facets`, which is what makes case-sensitive exact matching safe.
- All four states wired, and the empty state **distinguishes "no tasks" from "no matches"** — "create" vs "clear filters".
- Below `md` the table is replaced by stacked cards. Row links are real `<a>` elements inside the row, not `onClick` on the `<tr>`.
- Refetch keeps previous data visible at reduced opacity with `aria-busy` rather than blanking.

### Stage 12 · Detail → Create → Edit

| | |
| --- | --- |
| **Deliverables** | `pages/task-detail/` (+ `features/comments/CommentThread.tsx`, `CommentComposer.tsx`, `StatusSelect.tsx`, `ConfirmDialog`), `pages/task-create/`, `pages/task-edit/`, shared `features/tasks/TaskForm.tsx`, `pages/not-found/` |
| **Depends on** | 11 |
| **Gate** | Full CRUD works end to end in the browser: create → detail → comment → status change → edit → delete, each with its toast, each surviving reload |

Order within the stage: **Detail, then Create, then Edit.** Detail is the landing target for create and the host for comments and delete; Create then establishes `TaskForm`, which Edit generalises to a partial PATCH. Building Edit first means writing the form twice.

Forms use react-hook-form with the zod resolver from `packages/contracts` — the same schema the server enforces, never a second set of rules. A failed submit **keeps the typed values**, and a server `VALIDATION_ERROR` maps `details` onto the matching fields. The comment composer clears only on success.

Mutations invalidate through `queryKeys` — `queryKeys.tasks.all` for list-affecting writes, `queryKeys.tasks.detail(id)` for comments — never inline key arrays. Delete confirms first and is irreversible.

Descriptions and comment bodies render as escaped text nodes. No `dangerouslySetInnerHTML` anywhere.

### Stage 13 · Web component tests

| | |
| --- | --- |
| **Deliverables** | MSW handlers, tests for `TaskFilterBar`, `useTaskListParams`, `TaskForm`, the list page's three states, `ConfirmDialog` |
| **Depends on** | 12 (write each test alongside its component, not batched after) |
| **Gate** | `pnpm test:web` green |

MSW intercepts at the network layer so the real query hooks and fetch client are exercised. Mocking the hooks would test the mock.

---

## Phase 4 — Ship

### Stage 14 · Docker

| | |
| --- | --- |
| **Deliverables** | `apps/api/Dockerfile`, `apps/web/Dockerfile`, `docker-compose.yml`, `.dockerignore`, container entrypoint |
| **Depends on** | 9 for the API image; 12 for the web image |
| **Gate** | `docker compose up` on a **clean volume** yields a working app with seeded data; `docker compose down && up` preserves the database |

Entrypoint runs `prisma migrate deploy` — never `db push` — then seeds only when `SEED_ON_START=true` and the task table is empty. The DB file lives on a named volume so it survives `down`. `HOST=0.0.0.0` in the container. `VITE_API_BASE_URL` is the **browser-reachable** URL, not the compose service name: the request is made by the user's browser, not by the container. `ALLOWED_ORIGINS` lists both `localhost` and `127.0.0.1` — they are different origins to a browser.

The clean-volume test is the one that matters. It is what catches a schema change that shipped without its migration.

### Stage 15 · E2E

| | |
| --- | --- |
| **Deliverables** | `playwright.config.ts` (with `webServer`), `e2e/globalSetup.ts`, the five specs from [TESTING.md](../engineering/TESTING.md) |
| **Depends on** | 12 |
| **Gate** | `pnpm test:e2e` green twice in a row from a cold start, and green when specs are shuffled |

A **third** database (`e2e/helpdesk-e2e.db`) — not the dev file, not the vitest temp files. `globalSetup` re-seeds from scratch each run so a crashed run never poisons the next.

Because all specs share one database, **every mutating test creates its own task and acts on that one.** No spec may edit or delete a seeded task, or the run becomes order-dependent and fails only in CI. Running the suite shuffled is what proves this, which is why it is in the gate.

Spec 5 loads the list at 375px and asserts the card layout — the brief grades mobile explicitly.

### Stage 16 · Docs reconciliation + README

| | |
| --- | --- |
| **Deliverables** | Root `README.md` (run instructions for both apps, per brief task 5), corrections across `docs/pages/` and `docs/features/`, both `env.example` files verified against [ENVIRONMENT_VARIABLES.md](../engineering/ENVIRONMENT_VARIABLES.md), CI workflow |
| **Depends on** | 15 |
| **Gate** | A reader following only the README, on a clean clone, gets a running app both ways (local and Docker). CI runs `typecheck` → `lint` → `test` → `test:e2e` green |

Walk every `docs/pages/` and `docs/features/` file against the code and fix what implementation settled differently. Frontmatter `resource:` paths must point at files that now exist; `status: plan` stays only on [../features/Attachments.md](../features/Attachments.md).

---

## Dependency graph

```
1 ─► 2 ─► 3 ─► 4 ─► 5 ─► 6 ─► 7 ─► 8 ─► 9 ─┬─► 10 ─► 11 ─► 12 ─┬─► 13
                                            │                   │
                                            └────► 14 ◄─────────┤
                                                                └─► 15 ─► 16
```

Stages 1–9 are a hard chain: each one's gate is the next one's precondition. The only real parallelism opens after stage 9 — web work (10–13) and the API Docker image (14) proceed independently, and stage 15 needs only the UI.

**If delegating** ([../../CLAUDE.md](../../CLAUDE.md#subagents)): `db-migrator` owns stage 3; `api-engineer` owns 4–9; `web-engineer` takes 10–13 while Docker proceeds; `qa-verifier` owns 15; `docs-keeper` owns 16 and reviews the doc edits made inside earlier stages.

## Checkpoints worth stopping at

Four points where the work is demonstrable to someone else, useful if you want review before continuing:

| After stage | You can show |
| ----------- | ------------ |
| 9 | A complete, tested, documented API — brief tasks 1–3 and bonus items 1, 2, 4, 5 |
| 12 | The full product working in a browser — brief task 4 |
| 14 | `docker compose up` — bonus item 3 |
| 16 | The submission |

## Deferred by design

Do not add these mid-build; if a stage seems to need one, say so and stop rather than inventing it: authentication, user accounts, roles, real-time updates, file attachments ([../features/Attachments.md](../features/Attachments.md)), email notification, multi-tenancy, `PUT` alongside `PATCH`, soft delete, cursor paging, FTS5 search.

## Related

- [ARCHITECTURE.md](../engineering/ARCHITECTURE.md) — the layer boundaries every stage must respect
- [TESTING.md](../engineering/TESTING.md) — the required-coverage lists the gates refer to
- [DATABASE.md](../engineering/DATABASE.md) — schema, indexes, SQLite caveats
- [../AGENTS.md](../AGENTS.md) — doc routing and required practices
- [../../instructions.md](./instructions.md) — the original brief
