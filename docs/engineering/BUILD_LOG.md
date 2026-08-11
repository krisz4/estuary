# Build log — deferred work & performance

Companion to [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md). The plan says what to build and in
what order; this file records what each stage actually left behind.

Three things are tracked, and nothing else:

1. **Stage ledger** — one row per stage: gate result, review verdict, commit.
2. **Deferred work** — anything a stage did not finish, with the reason and where it lands.
3. **Performance** — observations and improvement candidates, so they accumulate in one place
   instead of being rediscovered per stage.

An item leaves this file only when it is done (or explicitly rejected with a reason).

## Stage ledger

| Stage | Gate | Review | Commit |
| ----- | ---- | ------ | ------ |
| 1 · Monorepo shell | pass — `pnpm install`, `typecheck`, `lint` clean; gates verified non-vacuous with throwaway probes | 10 findings, 8 fixed in-stage, 2 deferred (D1, D2) | `Scaffold monorepo shell` |
| 2 · `packages/contracts` | pass — 155 tests green, builds, and imports cleanly from both a real `node` ESM scratch file and a real `vite build` (no `node:*` in the browser bundle) | 5 findings, all 5 fixed in-stage | `Add packages/contracts` |
| 3 · Prisma schema + first migration | pass — `db:migrate` applies to an empty file, `prisma generate` succeeds, a scratch script round-trips a ticket, repo-wide `typecheck`/`lint`/`build`/`test` clean | 5 findings, all 5 fixed in-stage | `Add Prisma schema, first migration, and env parsing` |
| 4 · App skeleton, middleware, error envelope | pass — 12 supertest assertions green (all five gate cases plus requestId and CORS); verified non-vacuous by breaking the parse-failure branch and the generic-500 message and watching 3 tests fail; `pnpm dev:api` boots and serves `/health` | 7 findings, all 7 fixed in-stage | `Add app factory, middleware chain, and error envelope` |
| 5 · Test harness | pass — 25 tests green; `apps/api/prisma/data/helpdesk.db` byte-identical and mtime-unchanged across a full run; two DB-writing files proven concurrent in different processes (pids 82090/82092, workers 0/2, separate temp files); verified non-vacuous by moving the `DATABASE_URL` assignment into a `beforeAll`, which deleted two hand-planted rows from the dev database and wrote its own row into it (backup restored, checksum verified) | 5 findings, all 5 fixed in-stage | `Add the API test harness` |
| 6 · Ticket service — CRUD, status lifecycle, ranks | pass — 110 tests over 5 files; every ticket + lifecycle case in TESTING.md covered at the service level; dev DB sha256 `f59f2d43…518554` and mtime unchanged across every run; repo-wide `typecheck`/`lint`/`test`/`format:check` clean. Verified non-vacuous by five deliberate breaks: bypassing `applyTicketRanks` (4 tests fired), making the same-status PATCH write (1), narrowing the reopen clear to `closed` only (4), dropping the `[...allowed]` copy in `invalidStatusTransition` (1), and dereferencing `ALLOWED_TRANSITIONS[from]` unguarded (2) | 5 findings, all 5 fixed in-stage | `Add the ticket service, status lifecycle, and rank derivation` |

## Deferred work

| # | Item | Raised in | Reason deferred | Lands in |
| - | ---- | --------- | --------------- | -------- |
| D1 | `pnpm test:e2e` has no runner — `@playwright/test` is not installed | Stage 1 review #4 | Playwright pulls browser binaries; nothing before stage 15 uses it, and it is not in any earlier gate | Stage 15 |
| D2 | `packages/tsconfig/react-app.json` is unexercised — `types: ["vite/client"]` needs Vite present | Stage 1 review | No React app exists yet; option-set correctness was verified with `tsc`, resolution cannot be | Stage 10 |
| ~~D3~~ | ~~`pnpm test` is a turbo passthrough with no package implementing `test`~~ | Stage 1 | — | **Resolved in stage 2** — vitest is in the graph; `test:coverage` wired too |
| D4 | pnpm pinned at `11.1.2` while `11.21.0` is available | Stage 1 | A version bump wants CI to agree with the pin; both should move together | Stage 16 |
| ~~D6~~ | ~~`@helpdesk/api` has no `dev` script, so `pnpm dev:api` is a no-op~~ | Stage 3 | — | **Resolved in stage 4** — `dev: tsx watch --clear-screen=false src/server.ts`; verified booting and serving `/health` |
| ~~D7~~ | ~~`@helpdesk/api` has no `test` script~~ | Stage 3 | — | **Partly resolved in stage 4.** A minimal `test` script exists (`vitest run`, no config file) so the stage 4 gate is executable. It is deliberately not the harness — see D9 |
| ~~D9~~ | ~~`apps/api` has no `vitest.config.ts` / `setupFiles`, and its `test` script inlines a placeholder `DATABASE_URL`~~ | Stage 4 | — | **Resolved in stage 5.** The script is a plain `vitest run`; `vitest.setup.ts` assigns the per-worker URL. `NODE_ENV=test` moved into `vitest.config.ts`'s `test.env` plus the setup file, so an exported `NODE_ENV=development` no longer unmounts the diagnostic routes — verified by running the suite with it exported |
| ~~D10~~ | ~~The two forced-500 tests print a full stack to stderr~~ | Stage 4 | — | **Resolved in stage 5.** `vitest.setup.ts` filters `process.stderr.write`, dropping a line only when it parses as the logger's `"Unhandled error"` for a `/__test__/` path. Verified non-vacuous: an identically-shaped line for `/api/v1/tickets` and an unrelated `logger.error` both still print |
| D8 | `db:seed` and the `prisma.seed` hook are absent, so `db:reset` migrates but does not re-seed | Stage 3 | `prisma/seed.ts` is stage 9's deliverable. `CLAUDE.md` and `DATABASE.md` both describe `db:reset` as re-seeding — that becomes true when the hook lands | Stage 9 |
| D11 | Route-level assertions in TESTING.md § Tickets are unproven: 201 + `Location`, non-numeric `/tickets/abc` → 404, `{}` → 422 `AT_LEAST_ONE_FIELD`, per-field 422 `details` | Stage 6 | They are HTTP concerns and there are no routes yet. Their service-side halves are covered (`hasAtLeastOneField({}) === false`, "empty patch performs no write", `.strict()` rejection of `id`/`createdAt`) | Stage 8 |
| D12 | `assigneeIsNull=true` is asserted through a proxy — a raw `where: { assignee: null }` read after patching `assignee: ""` — rather than through the query param | Stage 6 | The param is parsed by `ticketListQuerySchema` and consumed by `buildWhere`, neither of which exists yet | Stage 7 |
| D13 | The read-then-write race in `updateTicket`/`deleteTicket` is closed by `prisma.$transaction` but **has no test**. Two concurrent PATCHes racing a status guard cannot be scheduled deterministically from vitest; a timing-based test would be flaky in CI and would fail for the wrong reason | Stage 6 review #1 | SQLite's own behaviour (a deferred transaction that reads then writes aborts with `SQLITE_BUSY_SNAPSHOT` if the snapshot moved) is what provides the guarantee, and it is not ours to assert | Not planned. Revisit only if the API ever runs multi-process against one file — noted here so the gap is known rather than assumed covered |
| D5 | Schemas carry no `.openapi()` metadata | Stage 2 | `@asteasolutions/zod-to-openapi` would be a second runtime dependency in a package whose hard constraint is "zod and nothing else". Its v9 peers `zod ^4`, so it can extend these schemas from `apps/api` without touching this package | Stage 9 |

### Constraints established for later stages

- **`packages/contracts` must extend `@helpdesk/tsconfig/library.json`, not `base.json`.** That base
  sets `NodeNext` resolution so emitted `.d.ts` files carry explicit `.js` extensions. `base.json`'s
  `Bundler` resolution emits extensionless specifiers, which `apps/api` (NodeNext) cannot resolve —
  it fails as `TS2307` on the first cross-package import. Source imports in contracts are therefore
  written `from "./ticket.js"`. Raised as Stage 1 review finding #5, fixed before it could bite.
- **Stage 7 must import `parseReference` from `@helpdesk/contracts`, not reimplement it.** The plan
  lists it under stage 7's `services/ticket-query.ts`, but `Validation_And_Contracts.md` and
  `Ticket_Numbering.md` both place `reference.ts` in contracts — and the web app needs it too. Built
  in stage 2 per the "spec wins over plan" rule.
- **`ticketIdParamSchema` and `parseReference` must agree.** Both turn user input into a ticket id;
  the param schema is decimal-digits-only (not `z.coerce.number()`, which resolves `"0x2a"`, `"1e3"`,
  and `" 12 "` all to 42). A test asserts the two parsers agree. Stage 8 should not loosen it.
- **`updateTicketInputSchema` accepts `{}` on purpose.** `AT_LEAST_ONE_FIELD` is its own 422 code
  with no field details; a zod `.refine()` would collapse it into `VALIDATION_ERROR`. Stage 8's route
  calls the exported `hasAtLeastOneField()` after parsing.

- **`prisma generate` must run before build/typecheck/test.** `@prisma/client`'s own postinstall
  `chdir`s to `INIT_CWD` (the repo root, which has no schema), fails, and is swallowed — leaving a
  throw-stub whose types are `any`. `typecheck` and `build` then pass green with every Prisma call
  silently untyped, and the first runtime import throws. `apps/api` therefore has its own
  `postinstall: prisma generate`, which pnpm runs with the correct cwd.
- **pnpm 11 renamed the build allow-list.** `pnpm.onlyBuiltDependencies` in `package.json` is inert
  under pnpm 11; the setting is `allowBuilds` in `pnpm-workspace.yaml`. Left unmigrated, install
  fails with `ERR_PNPM_IGNORED_BUILDS` for the Prisma packages — meaning no engine binaries and a
  client that cannot connect.
- **`errorHandler` is the only writer of an error body, and it duck-types Prisma.** The `P2025`
  backstop checks `typeof err.code === "string" && typeof err.clientVersion === "string"` rather than
  `instanceof PrismaClientKnownRequestError`, so `middleware/` does not import the generated client —
  the layer table in `ARCHITECTURE.md` allows middleware only contracts and `lib/errors`. Stages 6–8
  must keep throwing specific errors from services; the backstop is not a route to a 404.

- **`app.ts` is a factory taking no arguments, and stage 8 mounts `/api/v1` at the marked line.**
  Everything before that line (`requestId` → json → cors) and after it (`notFound` → `errorHandler`)
  is fixed by the ordering rule; a router mounted outside that window loses either its request id or
  its error envelope.

- **The forced-500 gate is served by `GET /__test__/boom` and `/__test__/boom-async`, mounted only
  under `NODE_ENV=test`.** Documented in `Error_Handling.md`. Do not promote them to always-on and do
  not delete them — they are the only non-invasive way to assert that a 500 leaks no stack.

- **`serialize.ts` types its input structurally (`TicketRow`, `CommentRow`), not from
  `@prisma/client`.** Prisma's own row types satisfy the interfaces, so services pass rows straight
  in. It casts `status`/`priority`/`category` to their contract enums rather than re-parsing: a
  `.parse()` on a read path would turn a data problem into a 422 on a `GET`. That is safe **only**
  while every write path goes through the zod enums — stage 6 owns keeping it true.

- **`DATABASE_URL` has no default, and `lib/env.ts` loads `.env` with `override: false`.** Both
  matter for stage 5: a default would let a missing `setupFiles` entry truncate the dev database
  instead of failing, and an overriding loader would replace a worker's temp-file URL with the
  developer's `.env`.

- **Stage 8 must write a local `asyncHandler()`.** `docs/features/Error_Handling.md` calls for it and
  gives a reason that survives scrutiny — "Express 5 forwards rejected promises, but the wrapper keeps
  the behavior explicit and survives a downgrade". It is a one-line local helper, **not**
  `express-async-handler`; do not add that package. A stage-4 test proves unaided propagation works,
  so the wrapper is belt-and-braces, not load-bearing.
- **`cors` is mounted before `express.json()`**, contradicting what `ARCHITECTURE.md` and the plan
  originally said. Both were corrected in stage 4. `apps/api/src/app.test.ts` pins it with a test that
  fails when the order is swapped back — verified by actually swapping it.
- **`/__test__/boom` and `/__test__/boom-async` are mounted only under `NODE_ENV=test`.** They are how
  the forced-500 path is proven without monkey-patching a real route. Confirmed absent in dev.
- **`serializeTicketSummary` requires `_count`**, with no default. A default would turn a forgotten
  `_count: { select: { comments: true } }` into every ticket in the list reporting 0 comments.
- **`errorHandler` detects `ZodError` structurally, not with `instanceof`.** The schemas that throw
  are compiled against the contracts package's `zod`; pnpm dedupes to one copy today, but if the
  ranges ever drift, `instanceof` fails and every 422 becomes a 500.
- **Test databases are copied from a migrated template, not migrated per worker.** `TESTING.md` says
  each worker's file is "migrated with `prisma migrate deploy` in `globalSetup`". `globalSetup` cannot
  know how many workers vitest will spawn, and the CLI costs ~0.63 s per invocation, so it migrates
  **one** template (`$TMPDIR/helpdesk-test-template.db`) and each worker copies it — 57 kB, sub-millisecond.
  The schema still comes from `migrate deploy` in `globalSetup`; only the fan-out changed.
- **`vitest.setup.ts` uses `await import()` for every application module.** A static
  `import { prisma }` is hoisted above the `process.env.DATABASE_URL` assignment in the same file and
  reintroduces exactly the bug the setup file exists to prevent. Stages 6–8 must not "tidy" it into a
  static import.
- **`beforeEach` truncates and resets `sqlite_sequence`, so ids start at 1 in every test.** A test may
  therefore arrange a specific reference (`HD-000042`) by creating rows in order — but no test should
  *assume* an id it did not create.
- **Factories write through Prisma directly, never through a service.** Arranging a service test with
  the same call it asserts on cannot fail when that call is wrong. `src/test/factories.ts` mirrors the
  rank derivation (`TICKET_STATUSES.indexOf`) for the same reason; it is a test-side mirror, not a
  second writer, and the `applyTicketRanks()` invariant is still asserted by sorting.
- **`docs/features/Ticket_Numbering.md` still says `:ticketId` is parsed with `z.coerce.number()`.**
  It is not, deliberately (see the stage-2 constraint above). Stage 16 should correct the doc.

### Constraints established in stage 6 (binding on 7–9)

- **`TicketWriteData` deliberately has no `statusRank`/`priorityRank` fields.** The write type in
  `ticket.service.ts` is hand-declared rather than taken from `Prisma.TicketUncheckedUpdateInput`, so
  the *only* way a rank reaches Prisma is `applyTicketRanks()` adding it. The invariant is enforced
  by the type checker, not by discipline. Stage 7's query service and stage 9's seed must write
  through the same helper.
- **`updateTicket` and `deleteTicket` read and write inside `prisma.$transaction`.** The status guard
  is a read-then-write decision: without a transaction, two concurrent PATCHes both read `open`, one
  writes `closed`, and the other — holding a stale `from` — passes `assertTransition("open",
  "resolved")` and produces the `closed → resolved` row the module exists to forbid. Do not "simplify"
  either back into a bare read followed by a bare write.
- **The `updateTicket` pre-read selects `{ id, status, resolvedAt }`, not the comment thread.** The
  `update` returns the thread anyway; including it in the pre-read read every comment twice on every
  field patch. Only the no-write branch goes back for the thread.
- **Facets use `groupBy`, never `findMany` + `distinct`.** Prisma applies `distinct` in the client and
  emits `SELECT id, assignee …` — one row per assigned ticket, and the `id` in the projection makes an
  index-only plan impossible. `groupBy` emits a real `GROUP BY` and plans as
  `SEARCH Ticket USING COVERING INDEX Ticket_assignee_idx`. Both the emitted SQL and the plan were
  logged in stage 6; `DATABASE.md` now records it.
- **`isTransitionAllowed` guards the `ALLOWED_TRANSITIONS[from]` lookup.** `status` is an
  unconstrained `String` column, so a row from direct SQL or a `db push` experiment can hold a value
  outside the enum; an unguarded dereference turns a PATCH into a `TypeError` → 500. An unknown
  current status now means "nothing is legal from here" and surfaces as the documented 409 with the
  bad value in `details.from`.
- **`services/ticket.service.ts` returns serialized contract types**, not Prisma rows — stage 8's
  routes send what the service returns and cannot forget `serialize.ts`.

### What stages 6–8 need to know about the harness

- **Never make `vitest.setup.ts`'s `await import()` static.** A static import is hoisted above the
  `DATABASE_URL` assignment in the same file, which reintroduces exactly the bug the stage exists to
  prevent. A post-import guard now compares `lib/env.ts`'s resolved value against the worker's temp
  path and refuses to run if they differ — the earlier guard compared the assignment to itself and
  could never fire.
- **Ids start at 1 in every test.** `sqlite_sequence` is reset alongside the truncation, so a test
  needing `HD-000042` can arrange it by creating rows in order. Never assume an id you did not create.
- **Factories write through Prisma directly, not through a service.** Arranging a service test with
  the call it asserts on cannot fail. `factories.ts` mirrors the rank derivation, so it is a
  test-side mirror rather than a second writer — keep asserting the `applyTicketRanks()` invariant
  **by sorting**, per TESTING.md.
- **`makeTicket` derives `resolvedAt`/`closedAt` from `status`**, so a `closed` fixture is not
  silently missing its own invariants. Opting out is by key presence (`{ resolvedAt: null }`), which
  now genuinely works — `??` made the documented opt-out a no-op.
- **A genuine 500 from a real route still prints its stack.** The stderr filter matches only
  `"Unhandled error"` plus a `/__test__/` path. A stage-8 test wanting a quiet expected 500 must go
  through the diagnostic routes, or widen the filter deliberately.
- **`pool: "forks"` is load-bearing.** Under `threads` all workers share one `process.env` and would
  fight over one file.

## Performance ledger

Candidates are recorded when observed and only actioned when a stage's gate or a measurement
justifies it — the project is a graded take-home on SQLite, not a system under load.

| # | Observation | Impact | Action |
| - | ----------- | ------ | ------ |
| P1 | Install footprint. Before stage 3: 196 MB `node_modules`, ~215 packages. After: **457 MB, 336 packages** — Prisma is ~57% of the tree and essentially the whole delta (`@prisma/client` 95 MB, `prisma` CLI 69 MB, `@prisma/engines` 39 MB) | Native binaries, not JavaScript: one 21 MB schema-engine plus **three separate copies** of the 18–19 MB query-engine `.dylib`. Install *time* barely moved (13.9s cold / 0.28s warm) because pnpm hardlinks from its content-addressed store — disk is the cost, not wall clock | Nothing now. Stage 14 should keep `prisma` and `@prisma/engines` out of the runtime image layer. Re-measure after stage 15 (Playwright browsers) |
| P2 | `build.inputs` excludes `**/*.test.ts(x)` | Editing a test does not invalidate a package's build cache, and therefore not `^build` for everything downstream | Done in stage 1; matters most for `packages/contracts`, which every workspace depends on |
| P3 | Turborepo remote caching is off; `globalDependencies` is deliberately narrow | CI wall time at stage 16 | Leave off. Revisit only if CI is slow — enabling it is a one-line change |
| P4 | `lint` is a single root `eslint .` pass rather than a turbo fan-out | One process instead of N; also keeps the ruleset in one file | Intentional. It is also why `lint` declares `dependsOn: []` — it must never serialize behind builds |
| P5 | `@helpdesk/contracts` costs `apps/web` 14.3 kB raw / 5.3 kB gzip; **with zod bundled it is 144.6 kB / 30.4 kB gzip** | zod is ~82% of the contracts import cost — it is the number to watch, not the schemas | `sideEffects: false` is set so unused exports tree-shake. Re-measure at stage 10; if the web bundle needs trimming, the lever is importing fewer schemas into the browser, not shrinking them |
| P6 | Schema parse cost, warmed, 20k iterations: `ticketListQuerySchema` 5.4 µs, `createTicketInputSchema` 2.3 µs | Negligible next to a SQLite round-trip. The query schema is ~2.3× the body schema (preprocess wrapper + three `repeatable()` preprocessors) | None. Recorded so it is not re-measured |
| P8 | Index coverage vs the stage 7 query surface: the common view (`status` filter + `createdAt:desc`) plans as `SEARCH Ticket USING COVERING INDEX Ticket_statusRank_createdAt_idx` — covering, so no table row lookups | The composite index pays off exactly where it was designed to | Verified with `EXPLAIN QUERY PLAN` in stage 3 |
| P9 | Three known non-covered paths: `q` is a full scan (leading-wildcard `LIKE` cannot use a B-tree — `DATABASE.md` says so deliberately); `priority:desc` + the `{id:"desc"}` tiebreaker falls back to a sort because `Ticket_priorityRank_idx` is single-column; ~~`facets` is an index-only scan~~ (**wrong as written — see P19**; it was a full projection deduped in the client until stage 6 changed it to `groupBy`) | Irrelevant at 63 seeded rows | Stage 7 should expect these rather than treat them as bugs. If `q` ever matters, the answer is FTS5 — explicitly deferred by the plan. If priority sorting ever matters, it is a `(priorityRank, id)` composite, not a new query |
| P10 | **Turbo build caching was silently broken and is now fixed.** `incremental: true` writes its tsbuildinfo to `node_modules/.cache/tsc/`, which was not a declared `build` output. tsc decides whether to emit by comparing against that file, so a restored `dist` that disagreed with a surviving tsbuildinfo caused tsc to emit nothing — and the mismatch got re-cached | Severe: `packages/contracts/dist/index.js` was **absent entirely** while `pnpm build` reported success. It would have broken the runtime bundle, not just types | Fixed in stage 3 by caching the pair together: `outputs: ["dist/**", "node_modules/.cache/tsc/**"]` |
| P7 | `test` declares `outputs: []`; coverage moved to a separate `test:coverage` task | `pnpm test` no longer warns "no output files found" on every run, and coverage output is still cached when asked for | Done in stage 2 |
| P11 | Stage 4 install delta: **457 MB → 478 MB, 336 → 423 packages** for express + cors + tsx + vitest + supertest and their types. Express itself is ~1 MB; the delta is tsx/esbuild (~670 kB plus a platform binary) and vitest's vite tree (~2 MB per peer-resolved copy, four copies resolved across the workspace) | Dev-only weight. Both `tsx` and `vitest` are devDependencies, so stage 14's runtime image should install with `--prod` and carry only express, cors, zod, dotenv, and `@prisma/client` | Re-measure at stage 15 (Playwright browsers) |
| P12 | Cold boot of the API process, measured through `tsx`: **178 ms** to import `app.ts` (transitively `env.ts` + dotenv + express + cors), **1.4 ms** to run `createApp()`, **1.0 ms** to bind the port | The import is ~99% of boot, and almost all of it is module loading, not work. `prisma.ts` is *not* on this path yet — stage 8 will add the client import and this number will rise sharply (P1 notes the engine is a native `.dylib`) | Nothing now. Re-measure after stage 8; if the Docker healthcheck ever flaps on a cold start, this is the number to look at, and the answer is `start_period`, not code |
| P13 | `GET /health` latency over 200 sequential requests on a bound socket: **p50 0.28 ms, p99 1.77 ms** | The whole chain (requestId → json → cors → route) costs well under a millisecond, so any later latency is the database, not the middleware. `/health` deliberately touches no database, which is also why it is a fair baseline | Recorded as the "zero-work request" baseline for stages 7–8 |
| P14 | Stage 5 suite, 25 tests over 3 files on 8 cores: **1.5 s wall warm, ~5.3 s cold**, of which `globalSetup`'s single `prisma migrate deploy` is **0.63 s** and the per-worker template copy is sub-millisecond (57 kB) | The fixed cost is Prisma, not the tests: `tests` is 130–240 ms of the run. Cold-vs-warm is the query engine `.dylib` and vite's transform cache, both amortised | Nothing. The template-copy design is what keeps migrate off the per-worker path — do not "simplify" it into a per-worker `migrate deploy`, which would add ~0.6 s × workers |
| P15 | `setup` is the largest reported phase (200–500 ms aggregate warm, 12 s cold). With `isolate: true` (default) each **test file** re-runs `vitest.setup.ts` and therefore constructs its own `PrismaClient` | ~70–160 ms per file, paid once per file rather than once per worker. At the ~15 files stages 6–8 will add, that is 1–2 s of the run | Watch, do not act. If it dominates, the levers in order are: `poolOptions.forks.isolate: false` (risks cross-file module state), or a shared client behind `globalThis`. Neither is worth it below ~5 s |
| P17 | Truncation is 3 raw statements in one transaction per test, on an empty-ish file | Sub-millisecond; the 25-test run spends 130 ms in `tests` *including* every truncation | None. Truncating beats re-copying the file per test by an order of magnitude |
| P18 | Stage 6 suite: **~3.5 s wall warm / ~4.1 s cold**, 110 tests over 5 files (was 1.5 s / 25 tests at stage 5). 85 new tests cost ~2 s — **~19 ms/test** including a truncation each, so P17 still holds | Phase split warm: setup ~2.1 s, import ~1.5 s, tests ~1.6 s, transform ~1.0 s. **P15 is now confirmed as the dominant cost** — two new files added ~0.3 s of `setup` alone, and `setup` is ~60% of wall time while the tests themselves are ~46% | Watch. At stage 8's file count this crosses the ~5 s threshold P15 named as the point to try `poolOptions.forks.isolate: false` or a `globalThis`-cached client. Do not act before the number is actually there |
| P19 | **`GET /tickets/facets` was O(tickets), not O(distinct values).** Prisma's `distinct` is applied *in the client*: `findMany({ distinct: ["assignee"] })` emits `SELECT id, assignee FROM Ticket WHERE assignee IS NOT NULL ORDER BY assignee` and dedupes in memory. The `id` in the projection also makes an index-only plan impossible, so P9's "facets is an index-only scan" was wrong as written | Every facets request materialised one row per assigned ticket. Harmless at 63 rows, but the endpoint is called on every list-page load and the shape was wrong | **Fixed in stage 6.** Switched to `groupBy`, which emits a real `GROUP BY`; `EXPLAIN QUERY PLAN` now reports `SEARCH Ticket USING COVERING INDEX Ticket_assignee_idx`. Both the emitted SQL and the plan were logged, not assumed. `DATABASE.md` corrected |
| P20 | `updateTicket`'s pre-read loaded the full comment thread, which `prisma.ticket.update` then returned again | Every field patch read every comment on the ticket **twice**. Invisible on a 3-comment fixture, linear in thread length in production | **Fixed in stage 6.** The pre-read selects `{ id, status, resolvedAt }` — all the guard needs — and only the no-write branch goes back for the thread |
| P21 | Both writes now run inside `prisma.$transaction` (a correctness fix, logged here for its cost): one extra `BEGIN`/`COMMIT` round trip per PATCH and DELETE | Sub-millisecond on a local SQLite file; the suite wall time did not move measurably (3.50 s → 3.62 s, inside run-to-run noise) | None. The transaction is load-bearing — see the stage 6 constraints above |
