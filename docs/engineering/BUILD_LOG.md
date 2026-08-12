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
| 7 · List query service | pass — 155 API tests over 6 files (45 in `ticket-query.test.ts`); every "List query" bullet in TESTING.md covered; all four named traps proven to fire a named test when injected; dev DB sha256 unchanged; repo-wide `typecheck`/`lint`/`test`/`format:check` clean, verified independently of the implementing agent. Escape behaviour proven non-vacuous **in both directions** — the three escape tests fire when the fast path swallows everything, and survive when the raw path swallows everything, so they test the escape rather than the branch | 4 findings, all 4 fixed in-stage (one a real bug: `?q=%` returned the whole table) | `Add the list query service, pagination, and LIKE escaping` |
| 8 · Routes | pass — 244 API + 190 contracts tests; **every code in `API_ERROR_CONTRACT.md` has a named producer**, enforced by a `PRODUCERS` table asserted to equal `API_ERROR_CODES` exactly; layer rule asserted mechanically (no Prisma under `routes/`, no `req`/`res` under `services/`, `express-async-handler` absent), with a guard against the file list being empty; D11 closed; dev DB sha256 unchanged; gate re-run independently of the implementing agent. Non-vacuous by five breaks — facets/`:ticketId` order swapped (3 tests), comment parent guard dropped (1, with `P2003` → 500 confirmed in the log), comment DELETE's `ticketId` scope removed (2), `hasAtLeastOneField` removed (2), `Location` dropped (1) | 4 findings, all 4 fixed in-stage | `Add the ticket and comment routes` |
| 9 · Seed + OpenAPI | pass **with one step outstanding** — seed verified against a real running API on :4000: 63 tickets paging 20/20/20/3 across four pages with disjoint ids covering exactly 1–63, status filters summing to 63, `priority:desc` putting all 7 `urgent` first, `sort=status:asc` monotonic by lifecycle rank, inclusive `createdTo`, 19 unassigned (30.2%), 10 same-millisecond comment threads ordering by id, and a full CRUD round trip returning the total to 63. `/docs` serves 7 paths / 10 operations; `DOCS_ENABLED=false` 404s the whole subtree while the API stays up. 301 API + 190 contracts tests. **`db:reset` itself is unverified** — see D17 | 8 findings, all 8 fixed in-stage (2 medium: `DOCS_ENABLED=false` still built the spec at boot; the seed was never compiled despite DOCKER.md depending on it) | `Add the seed, OpenAPI generation, and the docs UI` |
| 10 · Web shell + API client | pass — `pnpm dev` serves 5173 against 4000 with no CORS error and the browser renders **63** from the real seeded API; a cross-origin 422 arrives readable with `code`, `requestId`, and per-field `details` (the stage-4 cors-before-parser ordering holding from the client side); route ordering verified live (`/tickets/new` matches before `/tickets/:ticketId`). 569 tests (301 API, 190 contracts, 78 web). D2 closed — `react-app.json` proven to resolve `vite/client` for real, non-vacuously. **Dark mode re-verified through CDP against the running page in both themes, not from the source** — see the note below | 9 findings, all 9 fixed in-stage (1 high/medium: dark mode was broken for every toast) | `Add the web shell, API client, and UI primitives` |
| 11 · Tickets list page | pass — full URL round trip verified in a real browser against the seeded API: page 3 → filter → sort → next page → reload → back → forward, each landing exactly where specified. `?utm_source=slack&status=open` renders correctly, is never forwarded to the API, and stays in the address bar. Seven keystrokes = **1** request. DOM (not CSS) verified at 360/768/1280 with `scrollWidth === viewport` at each, plus sheet, empty, no-match, past-end, error, and dark states. 630 tests (301 API, 190 contracts, 139 web) | 6 findings, all 6 fixed in-stage — **plus 3 defects found by looking at screenshots that every test passed through** | `Add the tickets list page` |
| 12 · Detail → Create → Edit | pass — **full CRUD end to end in a real browser** against the seeded API: create HD-000064 (email lowercased on write, blank assignee/category → `null`) → comment (body cleared, author kept, `updatedAt` unmoved) → status open → in_progress → closed with timestamps appearing → **`closed → resolved` rejected**, value rolled back, allowed transitions rendered inline from `details.allowed` → edit (empty submit = zero API calls; PATCH carried only changed fields; timestamps cleared) → reload persisted → delete with confirm → back to a 63-row list, `/tickets/64` then rendering the not-found state. XSS check: a description containing `<img src=x onerror=…>` renders as text. 715 tests (301 API, 190 contracts, 224 web); build exit 0 | 6 findings, all 6 fixed post-review — plus 5 found and fixed in-stage, **one of which was the implementing agent catching its own vacuous probe** | `Add ticket detail, create, and edit` |
| 14 · Docker | **gate not run — see D22, and do not read this row as a pass.** The five artefacts are complete (`apps/api/Dockerfile`, `apps/web/Dockerfile`, `apps/web/nginx.conf`, `docker-entrypoint.sh`, `docker-compose.yml`, `.dockerignore`) and their comments carry measurements from the session that built them — the drift-check 500 (`slaBreachedAt does not exist`), P37's short `dist`, the `SQLITE_READONLY` chown. **None of that was re-verified here, and the clean-volume `up` / `down && up` gate was never executed**: the Colima VM backing Docker on this machine had corrupted its own filesystem (every read inside it, including `/bin/sh`, returned `EIO`), and it was deleted without being recreated at the user's instruction. What *was* verified: `pnpm install --frozen-lockfile`, `typecheck`, `lint`, and the full suite clean with `prisma` moved to `dependencies`; docs reconciled against the implementation | not reviewed | `Add the Docker images, compose stack, and container entrypoint` |
| 13 · Web component tests | pass — MSW swapped in at the existing seam; 755 tests (301 API, 190 contracts, 264 web); `typecheck`/`lint`/`format:check` clean, build exit 0. **The stage's value was the audit, not the count**: 34 behaviour reverts run against the existing suite, finding three tests that did not discriminate, plus a real bug in `http.ts` that only a real network layer could expose | 5 findings, all 5 fixed post-review — two of them in the harness this stage built | `Add MSW and the web component test suite` |
| 16 · Docs reconciliation + README | **pass on the local half, and the Docker half is unrun for D22's reason.** The full CI sequence was executed locally in the workflow's own order and is green: `typecheck`, `lint`, `format:check`, `build` + the five output assertions, OpenAPI freshness (regenerate → tree clean), migration drift, `pnpm test --force` (**755** cold in 11.5 s), `pnpm test:e2e` (5 specs, 9.2 s). Both CI-only checks proven **non-vacuous**: the migration-drift check exits 2 and names the column when a field is added to `model Ticket` without a migration (`[+] Added column slaBreachedAt`), and exits 0 restored. The README's local path was run against fresh database files rather than read: `migrate deploy` + seed and `migrate dev` both produce 63 tickets / 180 comments, and `migrate dev` on an empty file **seeds through the `prisma.seed` hook by itself** — which is why the README no longer lists `db:seed` as a required second step. Dev DB sha256 `6945a0ad…ca32bc` and mtime unchanged across all of it. **Not verified: `docker compose up` (D22 — no container runtime on this machine), and the workflow has never been executed by GitHub Actions, there being no remote (D23).** Docs reconciled by walking every `pages/` and `features/` file against the code: all 18 `resource:` paths resolve, `status: plan` is on `Attachments.md` alone, all 112 code paths cited across `docs/` exist, and every relative doc link resolves. Both `env.example` files checked variable-by-variable against `ENVIRONMENT_VARIABLES.md` **and** against `env.ts`'s schema — all ten API variables and the one web variable present in all three, no extras in any of them | self-reviewed; 7 doc defects found and fixed | *this change set* |
| 15 · E2E | pass — 5 Playwright specs green **twice from cold** and green under three spec orderings (reverse-alphabetical, delete-first/create-last, mutating-first), each a single run sharing one database. Verified non-vacuous by six implementation breaks, each firing exactly the intended spec: `priorityRank` → `priority` in the API sort map, the comment composer clearing the author, the list always rendering the desktop table, the create mutation not invalidating, the delete mutation not invalidating `lists()`, and `data.status` never written. Both branches of `globalSetup`'s API check proven to fire. Repo-wide `typecheck`/`lint`/`format:check` clean, 755 unit tests green. **The stage's finding was that three of its own assertions did not discriminate on first writing** — see below | self-reviewed; findings fixed in-stage | `Add the Playwright E2E suite` |

### A note on what these gates are actually worth

Every stage from 6 onward has produced at least one test that could not fail:

- Stage 6: a rank-ordering test whose fixtures happened to sort correctly by insertion order anyway.
- Stage 6 review: `expect(error.details).not.toBe(ALLOWED_TRANSITIONS.closed)` — an object compared
  against an array, so never equal, so never failing.
- Stage 8: an `it.each` of non-numeric ids that passes under `z.coerce.number()`, because `0x2a`
  coerces to 42 and *that ticket does not exist in those cases*, so the request 404s for the wrong
  reason. The one real guard is an alias test that creates 42 tickets first.
- Stage 8 review: an "agreement" test that compared two of the **three** parsers, which is how
  `/tickets/0000000000000000042` came to serve ticket 42 while `?q=0000000000000000042` matched
  nothing — in code and a doc written the same stage, by the author of the test meant to prevent it.
- Stage 9: a query-parameter test that compared the documented names against
  `unwrapPreprocessedObject(ticketListQuerySchema)` — **the same call the production code makes**.
  Breaking the unwrap degraded both sides to `[]` together and nothing fired.

None were caught by reading. All were caught by **breaking the implementation and watching which
tests fired** — and in each case the count was lower than expected, which is the signal. Keep doing
it, and treat "fewer tests fired than I expected" as a finding rather than a relief.

- Stage 15: **three of the five specs' key assertions could not fail when first written.** Ordered by how
  quietly each would have gone unnoticed:
  1. *"Priorities descend"* checked page 1 only. With the seeded data the open subset is 3 urgent / 6 high /
     11 medium / 6 low, so a **text** sort fills page 1 with urgent, medium, low — already non-increasing by
     rank — and pushes every `high` row onto page 2. Swapping `priorityRank` for `priority` in the API's sort
     map passed. Fixed by asserting across the page boundary.
  2. *"The deleted ticket is gone from the list"* was written as an unscoped `getByText(reference)`, which also
     matched the **success toast** naming the ticket. It passed after ~4.5 s — the toast's own timer — and
     reported that as the list updating. The 4.5 s in an otherwise 1.7 s spec was the tell.
  3. The same assertion reached the detail page by `page.goto`, so no list was ever cached and removing the
     delete mutation's invalidation changed nothing. Fixed by arriving at the ticket *through* the list.

  All three were found by breaking the implementation, and in each case the probe script's own guard was the
  second problem: `grep -qF 'priority: "priority",'` matches `priority: "priorityRank",` as a substring, so it
  reported a patch as applied that had not been. **A check that the break landed must be a diff, not a grep.**

Two recurring shapes, worth naming because they are predictable:

1. **The test and the code share a helper.** Then both sides degrade together and the assertion
   cannot fail. Compare against an independent literal, even when that means writing the list twice.
2. **The test covers a subset of the invariant it claims.** "These two parsers agree" is not "the
   parsers agree" when there are three. Enumerate what the claim quantifies over.

A single-purpose guard firing exactly one test is *not* an instance of this — stage 9's registry
guard and mount guard each fire once because only one assertion can observe the hole they cover.
Distinguish "one test fired because the coverage is thin" from "one test fired because there is one
test for a thing nothing else can see", and record which, so neither gets "simplified" later.

### Stage 10 added two shapes that are not vacuous tests at all

Worth separating, because the remedy is different.

**3. A gate that measures the right thing and still misses what it stands for.** Stage 10's dark-mode
gate was genuinely rigorous — 36 tokens, `identicalInBothThemes: []`, enforced by a test proven
non-vacuous three ways. **And dark mode was broken for every toast.** Sonner injects its stylesheet
*unlayered* at runtime, and unlayered CSS beats `@layer` regardless of specificity, so the toast read
`--normal-bg` from a sheet the app's CSS could not reach. The proof was a true statement about
`index.css` that said nothing about whether any element consumed those variables. A hand-written
override block meant to cover this was itself dead code, inside `@layer`, with a comment asserting it
worked.

> A test that reads the source can only prove the source is consistent. Only the rendered document
> proves the page is right.

Stage 10's fixes were therefore verified through CDP against the running app, in both themes, reading
`getComputedStyle` — and each was reverted afterwards to confirm the check could fail. **Stages 11–13
must hold that standard: for anything visual, assert against the rendered document.**

Two corollaries found the same stage:

- **Two fixes can mask each other.** With the `theme` prop missing but the CSS override in place, the
  neutral toast still looked right and only richColors toasts stayed light. Either fix alone looked
  half-convincing. When two changes address one symptom, verify them independently.
- **The only toast reachable from the UI was one the app's CSS does not paint.** `richColors` meant
  the manual check exercised Sonner's palette, not ours. Make sure the thing you can click is the
  thing you are testing.

**5. A comment asserting a guarantee the dependency does not provide.** (Stage 11.)
`useTicketListParams` documented that `setSearchParams`'s functional updater reads the URL at commit
time, protecting two rapid filter changes from clobbering each other. In `react-router@7.18.2` the
updater receives the `searchParams` captured **in the render that created the callback** — the
protection never existed. It reads as verified reasoning, and nothing tests a comment. The fix is a
ref advanced synchronously on write; the check is a test that dispatches two writes in one frame.
**When a comment claims a library guarantees something, read the library's source.** Two earlier
findings had the same root: the stage-9 `unwrapPreprocessedObject` reliance on zod internals, and the
stage-10 assumption that an `@layer` rule could override Sonner's injected stylesheet.

**6. `instanceof` across realms.** Three instances now, and the third was a live bug:

- `errorHandler` detects `ZodError` structurally, because the throwing schemas are compiled against
  the contracts package's `zod` and `instanceof` fails the day the ranges drift (stage 4, pre-empted).
- Stage 10: an `@layer` rule cannot override a stylesheet injected unlayered by a library.
- **Stage 13: `http.ts` detected cancelled requests with `cause instanceof DOMException`.** A genuine
  abort rejects with the `DOMException` from *fetch's own realm*, so `instanceof` is `false`, the
  guard falls through, and a cancelled request became "can't reach the server" — on a healthy
  fast-typing search box, which is verbatim what the code comment said must not happen.

The stage-13 case is the sharpest illustration of shape 1 in this build: the existing test threw a
jsdom `DOMException` **from its own stub**, so the guard matched the object the test constructed.
Nothing short of a real network layer could see it. Check `.name`, not the constructor.

**4. A vacuous *probe* — the verification, not the test.** Checking the finding-4 fix (the pre-paint
theme script) showed no difference between broken and fixed, because React's `applyTheme` effect
re-applies the class on mount and hides the flash entirely. Only after blocking `main.tsx` at the
network layer, so the inline script ran alone, did the two diverge (`darkClass: false` vs `true`).
Stopping at the first probe would have reported a fix as verified on evidence that could not
distinguish it from the bug. **Ask what your probe would show if the fix were absent — and if the
answer is "the same thing", the probe is measuring something else.**

### What stage 16's reconciliation actually found

The mechanical checks — `resource:` frontmatter, cited code paths, inter-doc links — were all clean,
which is what the per-stage doc discipline was supposed to buy. Every defect was instead a **claim
that was true when written and quietly stopped being true**, or a count nobody recomputed:

| Doc | Was | Is |
| --- | --- | -- |
| `API_ERROR_CONTRACT.md` | Client mapping described `ApiClientError` but not the two codes the client **synthesizes** (`NETWORK_ERROR`, `MALFORMED_RESPONSE`, exported as `CLIENT_ERROR_CODES`) | Documented, with why they are deliberately absent from `API_ERROR_CODES` — `errorCopy()` keys off eleven codes, not nine |
| `API_Documentation.md` | "All **five** ticket endpoints" | Six. The spec's 7 paths / 10 operations / 6 components were re-counted from `openapi.json` and are correct |
| `Ticket_Query_Filter_Sort_Page.md` | `page` documented as "≥ 1" | 1–1,000,000. `MAX_PAGE` exists so `(MAX_PAGE-1) * MAX_PAGE_SIZE` stays inside Int32, the width of Prisma's `skip` — without it `?page=99999999999` 500s instead of returning an empty page |
| `Ticket_Query_Filter_Sort_Page.md` | Error table omitted the inverted date range | The schema rejects `createdFrom > createdTo` on `createdTo`. Reachable only by hand-edited URL, since the client clamps |
| `ARCHITECTURE.md` | Workspace tree showed `prisma/seed.ts` | No such file — the seed is at `src/seed/`, moved in stage 9 for the `rootDir` constraint. The tree had never been updated |
| `UI_DESIGN_GUIDELINES.md` | Primitive list omitted `Field` | Listed. It is the one primitive every form depends on for ARIA wiring |
| `ENVIRONMENT_VARIABLES.md` | `SEED_ON_START` "read by the shell, **not** by `env.ts`" | It *is* in `env.ts`'s schema — nothing reads `env.SEED_ON_START`, which is a different claim. Corrected, with why it is declared anyway |

Two prose counts ("a five-endpoint API") were corrected to eight in `ARCHITECTURE.md` and `TESTING.md`.

The pattern worth keeping: **the stale claims were all numbers and paths, and none of them were in a
doc anyone had reason to reopen.** A doc gets corrected when a stage touches its subject; a count in a
sentence has no subject, so nothing brings a reader back to it. That is what a final reconciliation
pass is for, and it is why the checks above are worth re-running rather than trusted.

## Deferred work

| # | Item | Raised in | Reason deferred | Lands in |
| - | ---- | --------- | --------------- | -------- |
| ~~D1~~ | ~~`pnpm test:e2e` has no runner — `@playwright/test` is not installed~~ | Stage 1 review #4 | — | **Resolved in stage 15** — `@playwright/test` at the root, chromium only, plus `playwright.config.ts`, `tsconfig.e2e.json` (the root files were previously typechecked by nothing; `pnpm typecheck` now runs `turbo run typecheck && tsc -p tsconfig.e2e.json`), and the five specs |
| ~~D2~~ | ~~`packages/tsconfig/react-app.json` is unexercised~~ | Stage 1 review | — | **Resolved in stage 10** — `tsc --listFiles` shows `vite/client.d.ts` and its five `vite/types/*.d.ts` dependencies in the program. Non-vacuous: `--types vite/client-typo` produces `TS2688`, so the entry is resolved rather than ignored, and a probe using `import.meta.hot` (declared only by `vite/client`) compiles clean |
| ~~D3~~ | ~~`pnpm test` is a turbo passthrough with no package implementing `test`~~ | Stage 1 | — | **Resolved in stage 2** — vitest is in the graph; `test:coverage` wired too |
| D4 | pnpm pinned at `11.1.2` while `11.21.0` is available | Stage 1 | A version bump wants CI to agree with the pin; both should move together | **Decoupled in stage 16, bump not taken.** The deferral reason is gone: `.github/workflows/ci.yml` writes no pnpm version at all — `pnpm/action-setup` reads `packageManager` from the root `package.json`, so CI cannot drift from the pin and the two no longer have to move together. The bump itself is now a one-line change in one file, and taking it at the end of the project would revalidate the whole toolchain against a lockfile that 755 tests and 5 specs currently pass on, for no behaviour anyone asked for. **Trigger to do it:** any pnpm-related failure, or the next dependency sweep |
| ~~D6~~ | ~~`@helpdesk/api` has no `dev` script, so `pnpm dev:api` is a no-op~~ | Stage 3 | — | **Resolved in stage 4** — `dev: tsx watch --clear-screen=false src/server.ts`; verified booting and serving `/health` |
| ~~D7~~ | ~~`@helpdesk/api` has no `test` script~~ | Stage 3 | — | **Partly resolved in stage 4.** A minimal `test` script exists (`vitest run`, no config file) so the stage 4 gate is executable. It is deliberately not the harness — see D9 |
| ~~D9~~ | ~~`apps/api` has no `vitest.config.ts` / `setupFiles`, and its `test` script inlines a placeholder `DATABASE_URL`~~ | Stage 4 | — | **Resolved in stage 5.** The script is a plain `vitest run`; `vitest.setup.ts` assigns the per-worker URL. `NODE_ENV=test` moved into `vitest.config.ts`'s `test.env` plus the setup file, so an exported `NODE_ENV=development` no longer unmounts the diagnostic routes — verified by running the suite with it exported |
| ~~D10~~ | ~~The two forced-500 tests print a full stack to stderr~~ | Stage 4 | — | **Resolved in stage 5.** `vitest.setup.ts` filters `process.stderr.write`, dropping a line only when it parses as the logger's `"Unhandled error"` for a `/__test__/` path. Verified non-vacuous: an identically-shaped line for `/api/v1/tickets` and an unrelated `logger.error` both still print |
| D17 | **`pnpm --filter @helpdesk/api db:reset` has never been run.** Prisma 6.19's CLI detects an AI agent and refuses `migrate reset` without `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` | Stage 9 | That guard exists to require a *human*, and an orchestrator instruction is not human consent — so neither the implementing agent nor the coordinator set it. The equivalent was run instead (`db:deploy` + `db:seed`), and `npx prisma db seed` was proven to invoke the hook `db:reset` uses, so the only untested step is Prisma's own drop-and-replay | **Needs one human run.** Asked of the user in stage 9; still open |
| D18 | An **unreproduced test failure**: `tickets.route.test.ts:245` ("applies a partial update…") failed once on `expect(res.status).toBe(200)` during a full repo run, and did not reproduce in 31 subsequent runs — including 8 under four saturating CPU hogs and 3 cold-cache sequences | Stage 9 | Not reproducible, and not attributable to stage 9: it did not reproduce on the pre-change tree either. The only plausible mechanism is two vitest forks briefly sharing a `VITEST_WORKER_ID` and therefore one SQLite file, which would be a pre-existing harness property (D16 territory) rather than seed-specific | Watch. If it recurs, it is a harness-isolation bug and the worker-id assignment is where to look. Recorded now so a second sighting is a pattern rather than a first sighting |
| D22 | **The stage 14 gate has never been executed.** `docker compose up` on a clean volume, and `down && up` preserving the database, are both unrun | Stage 14 | The Colima VM backing Docker on the development machine corrupted its own filesystem — every read inside it, `/bin/sh` included, returned `EIO`, and `docker images` failed on unreadable content blobs. It was deleted at the user's instruction and deliberately not recreated, so there is no container runtime here | **Needs one run on a machine with Docker.** Nothing in the artefacts is known-broken; what is missing is the evidence. Run `docker compose up --build` on a clean volume, confirm 63 seeded tickets through the browser at :5173, then `docker compose down && docker compose up` and confirm the data survived. It is also the gate that proves the entrypoint's drift check fires |
| ~~D21~~ | ~~**The production preview on :4173 cannot reach the API**~~ — `ALLOWED_ORIGINS` defaults to `http://localhost:5173` only, so `vite preview` gets a CORS failure | Stage 11 | Not a stage-11 defect: dev on 5173 works, and widening the default mid-stage would have been an unreviewed change to the API's CORS policy for a convenience the stage did not need | **Stage 14 and 15 both need it.** **Resolved in stage 14.** The list is now four exact origins — both loopback spellings × ports 5173 and 4173 — set once in `src/lib/env.ts`'s default, both `env.example` files, and `docker-compose.yml`. Stage 15 inherits it and must not widen it further. Note the container does **not** depend on it: nginx proxies `/api/` same-origin, so the list covers `vite preview`, Swagger UI's "try it out" on the published `:4000`, and a web image rebuilt with an absolute `VITE_API_BASE_URL` |
| D23 | **`.github/workflows/ci.yml` has never been executed by GitHub Actions.** Every step was run locally in the workflow's own order and is green, but nothing has exercised the workflow *as a workflow* — the `pnpm/action-setup` → `packageManager` coupling (no `version:` key), Node 24 on `ubuntu-latest`, the pnpm store cache, the two jobs running in parallel, and the `failure()`-guarded report upload are all unproven | Stage 16 | The repository has no remote, so there is nothing for Actions to run. The steps are verified; the runner is what is missing | **Needs a remote and one push.** Watch the first run for: install resolving `pnpm@11.1.2` from `packageManager`, `apps/api`'s postinstall firing `prisma generate` on a cold `node_modules`, and the `e2e` job's Playwright download. The OpenAPI-freshness and migration-drift checks are the two that would fail loudest on a clean checkout if anything was committed stale — which is exactly what a first run is for |
| D20 | The stage-9 seed's lifecycle math can place a timestamp seconds in the **future** when a ticket's drawn age is under ~75 s (`resolvedAt`) or ~5 min (comments, because `Math.max(…, 2*60_000)` floors the span above the ticket's own age) | Stage 10 review | **Unreachable with the shipped data**: `PRNG_SEED = 24_073` over a 90-day window never draws an age that small, and the seed tests bound the realised distribution. Changing a committed, deterministic, correct-for-its-data seed to fix an unreachable case is churn with a real risk of moving every id | Not planned. Fix only if the PRNG seed or the 90-day window changes — **that is the trigger**, and whoever changes either should read this row first |
| D19 | `package.json#prisma` (the `prisma.seed` hook) is deprecated — Prisma warns it is removed in Prisma 7 in favour of `prisma.config.ts` | Stage 9 | Works on 6.19; migrating it is a config change that wants to move with the dependency bump | **Still open after stage 16, deliberately.** It was tied to D4's bump, and D4 was decoupled rather than taken. The hook works on 6.19.3 and is load-bearing on two paths that are *both* thinly verified: `db:migrate` on a fresh database seeds through it (confirmed in stage 16 — `migrate dev` on an empty file ran the seed and produced 63 tickets), and `db:reset` calls it on a path that has never been run at all (D17). Moving it to `prisma.config.ts` would change the one behaviour the README now instructs a reviewer to rely on, with no way to test the second caller. **Trigger:** the Prisma 7 upgrade, and D17 wants a human run first |
| ~~D8~~ | ~~`db:seed` and the `prisma.seed` hook are absent~~ | Stage 3 | — | **Resolved in stage 9** — hook wired and proven to fire via `npx prisma db seed`; `db:reset` end-to-end still pending on D17 |
| ~~D11~~ | ~~Route-level assertions in TESTING.md § Tickets are unproven~~ | Stage 6 | — | **Resolved in stage 8** — 201 + `Location`, `/tickets/abc` → 404 across 7 spellings, `{}` → 422 `AT_LEAST_ONE_FIELD` with no details, per-field 422 `details`, and the list-query 422s (`pageSize=101` rejected not clamped, `page=0`, unknown sort field, `assignee`+`assigneeIsNull`, unknown param) |
| P43 | **D16 does not reproduce.** The API suite runs **1.86 s warm** at 301 tests / 13 files, against the 5.5–7.5 s recorded at stage 8. The web suite is 7.66 s at 264 tests; MSW cost ~0.1 s at constant test count | The stage-8 measurement was taken on a machine under load from the same session's parallel work. `setup` is still the dominant phase, but parallelism absorbs it | **Stage 16 must re-measure before spending `poolOptions.forks.isolate: false`.** The lever weakens the isolation stage 5 exists to provide, and the number that justified considering it appears to have been noise |
| ~~D16~~ | ~~The API suite has crossed the ~5 s mark P15 named as the trigger for `poolOptions.forks.isolate: false` or a `globalThis`-cached `PrismaClient`~~ | Stage 8 | — | **Closed in stage 16 as "do not spend it", which is a decision and not a deferral.** Re-measured as P43 required, on a **cold, uncached** run (`pnpm test --force`, which is what CI actually pays since no build cache is restored): API **4.08 s** at 301 tests / 13 files, contracts **0.37 s** / 190, web **9.15 s** / 264, **11.5 s wall for all 755**. The API suite is *below* the ~5 s trigger, and the whole repo's test wall time is a fraction of the Playwright browser download in the `e2e` job. There is nothing here worth trading stage 5's per-file isolation for. **Trigger to revisit:** the API suite over ~15 s cold, not "it feels slow" |
| D13 | The read-then-write race in `updateTicket`/`deleteTicket` is closed by `prisma.$transaction` but **has no test**. Two concurrent PATCHes racing a status guard cannot be scheduled deterministically from vitest; a timing-based test would be flaky in CI and would fail for the wrong reason | Stage 6 review #1 | SQLite's own behaviour (a deferred transaction that reads then writes aborts with `SQLITE_BUSY_SNAPSHOT` if the snapshot moved) is what provides the guarantee, and it is not ours to assert | Not planned. Revisit only if the API ever runs multi-process against one file — noted here so the gap is known rather than assumed covered |
| D14 | The `q` raw path has a hard ceiling, not just a slope: `id IN (…)` spends one bind parameter per match against `SQLITE_MAX_VARIABLE_NUMBER` (32766 modern, 999 pre-3.32), so a broad wildcard `q` over a large table would **fail**, not merely crawl. It also gives up the ordering index | Stage 7 | Only wildcard-bearing searches take that path, and the plan defers real search to FTS5 explicitly. At 63 seeded rows neither cost is observable | Not planned before FTS5. Recorded so the ceiling is known rather than discovered |
| D15 | `commentCount` compiles to a `LEFT JOIN` on a **materialized** `SELECT ticketId, COUNT(*) … GROUP BY ticketId` over the *whole* `Comment` table, plus a runtime `AUTOMATIC COVERING INDEX` — `O(all comments)` per list page rather than `O(pageSize)` | Stage 7 | Invisible at seed scale, and the lever is a query change, not a schema change | Not planned. If it ever matters, the fix is a second `groupBy` scoped to the 20 ids on the page |
| ~~D12~~ | ~~`assigneeIsNull=true` asserted through a proxy~~ | Stage 6 | — | **Resolved in stage 7** — exercised through the real query param, both directions |
| ~~D5~~ | ~~Schemas carry no `.openapi()` metadata~~ | Stage 2 | — | **Resolved in stage 9** — and resolved the way D5 predicted: `@asteasolutions/zod-to-openapi` extends the contract schemas **from `apps/api`**, so `packages/contracts` keeps its "zod and nothing else" constraint and was not touched. Metadata is `.meta()` applied at the API boundary; `docs/AGENTS.md` now tells agents explicitly *not* to put OpenAPI metadata on a contract schema |

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
- ~~**`docs/features/Ticket_Numbering.md` still says `:ticketId` is parsed with `z.coerce.number()`.**~~
  **Corrected.** The doc now states the rule the code implements — both schemas are
  `z.string().regex(/^\d{1,15}$/)` piped into `z.number().int().positive()`, deliberately *not*
  `z.coerce.number()` (see the stage-2 constraint above).

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

### Constraints established in stage 7 (binding on 8–16)

- **User input reaches `LIKE` as pattern syntax unless something stops it.** Prisma's `contains`
  compiles to `LIKE '%…%'` with **no `ESCAPE` clause**, so `%` and `_` in `q` are live wildcards:
  `?q=%` returned the entire table, `?q=50%` matched "500 errors". Prisma has no built-in escape and
  will not add one ([prisma#19506](https://github.com/prisma/prisma/issues/19506)). **Escaping the
  string before handing it to `contains` does not work** — with no `ESCAPE` clause SQLite has no
  escape character at all, so `\%` is a literal backslash followed by a wildcard; probed directly,
  `q="100\%"` returned zero rows. The only fix is raw SQL carrying its own `ESCAPE`.
- **`q` therefore has two paths, and the fast one is the default.** A term containing none of
  `%`, `_`, `!` is escaped to itself, so `contains` and the escaped raw `LIKE` are provably the same
  query — same rows, order, and paging. Only a term carrying a metacharacter takes
  `resolveTextSearch`. Do not "simplify" this into one path: the raw path resolves to `id IN (…)`,
  which gives up `Ticket_createdAt_idx` (`USE TEMP B-TREE FOR ORDER BY`) and spends one bind
  parameter per match against `SQLITE_MAX_VARIABLE_NUMBER`. `?q=printer` should pay neither.
- **`buildWhere` throws if given a `q` that needs escaping without its match set.** A missing argument
  would otherwise silently fall back and hand pattern syntax to `LIKE`. Fail loudly instead.
- **`status`/`priority` filters push both the rank predicate and the text predicate.** The rank term
  is what the index uses; the text term is what makes the answer *exact*. With rank columns defaulting
  to `0`/`1`, any insert that skips `applyTicketRanks()` (raw SQL, the stage-9 seed) would otherwise
  land under the wrong filter — and since stage 7 that is a wrong `meta.total`, not just a wrong order.
- **`listTickets` uses the interactive `$transaction`, not the plan's `$transaction([findMany, count])`
  array form.** The array form cannot feed the search prefilter's result into the next query, and the
  prefilter must share the snapshot with `findMany` and `count` or `meta.total` disagrees with the page
  it describes. Measured *faster* than the array form (1.11 ms vs 1.42 ms p50), so there is no no-`q`
  branch back to it. The plan is a schedule, not a source of truth.
- **`{ id: "desc" }` is the tiebreaker, and the direction is not arbitrary** — see P22.

### Constraints established in stage 8 (binding on 9–16)

- **`req.params` values are `string | string[] | undefined` in Express 5.** `parseTicketId` /
  `parseCommentId` therefore take `unknown` and let the schema reject. Casting to `string` turns a
  duplicated param into a `TypeError` inside zod instead of the documented 404.
- **`Location` is built from `req.baseUrl`, not a hard-coded `/api/v1`.** The prefix is chosen by the
  mount in `app.ts`; a second copy points at the old path the day that mount moves.
- **An unknown query param's `details` key is `_`, not the param name.** zod reports an unrecognised
  key with an empty path and names the key in the *message*; `errorHandler` files pathless issues
  under `_`. **The web client (stages 10–13) must not assume every `details` key is a form field.**
- **The body is validated before the parent ticket is looked up** on `POST /comments`, so a bad
  payload against a missing ticket is 422, not 404. Pinned by a test, so a handler reordering is
  visible rather than silent.
- **`routes/layers.test.ts` asserts the layer rule mechanically** — no Prisma import under `routes/`,
  no `req`/`res`/`express` under `services/`, and `express-async-handler` absent from both dependency
  blocks. It has a guard test that the file list is non-empty, so it cannot pass vacuously. Keep new
  files inside those directories rather than routing around the check.
- **`routes/error-codes.test.ts` holds a `PRODUCERS` table keyed by `ApiErrorCode`**, with an
  assertion that its keys equal `API_ERROR_CODES` exactly. Adding a code to the contract with no way
  to produce it fails the run. Stage 9 must add a producer if it adds a code.

### Constraints established in stage 9 (binding on 10–16)

- **`app.ts` exports `ROUTER_MOUNTS` (`{path, router}[]`) and `DOCS_PATH`.** Express 5 gives no way to
  recover a mounted router's prefix from `app.router.stack`, so route enumeration goes through that
  list. **Add new routers there, not with a bare `app.use`** — a test now asserts that exactly one
  router (`/docs`) is mounted outside it.
- **`routes/*.openapi.ts` is required per router.** `openapi.contract.test.ts` fails both on a route
  with no spec entry and on a documented path with no route.
- **`openapi.json` is committed and must be regenerated with any contract change.** The contract test
  compares it against a fresh build and names the fix in its failure message. CI (stage 16) should run
  `openapi:gen` and fail on a dirty tree.
- **OpenAPI metadata is `.meta()` applied from `apps/api`, never `.openapi()` on a contract schema.**
  `packages/contracts` keeps "zod and nothing else". `docs/AGENTS.md` says so explicitly now, because
  the old wording would have led an agent to `zodSchema.openapi is not a function`.
- **Registration happens inside `getOpenApiDocument()`, not at module scope.** Importing the docs
  router used to execute all three spec modules at boot, and one of them reads zod internals and
  throws by design — so a zod patch bump could have killed process startup on a deployment with docs
  switched *off*. Do not convert the registration calls back into import side effects.
- **The seed lives at `apps/api/src/seed/`, not `prisma/`.** `tsconfig.build.json` has
  `rootDir: "src"`, so a seed under `prisma/` is never compiled — while `DOCKER.md` requires the
  runtime image to run it as compiled JS with no `tsx` present. Verified: `node dist/seed/index.js`
  seeds 63/180 under plain node. `prisma/` holds schema and migrations only.
- **`db:reset` has no `--force`.** Its only caller is a human at a terminal; containers and CI use
  `db:deploy` + the guarded seed. `migrate reset` drops and recreates **before** `ALLOW_SEED` is ever
  consulted, so the prompt is the only confirmation protecting the dev database.
- **Seed ids are stable at 1–63**, oldest ticket `HD-000001`. Stage 15 may rely on 63 rows existing but
  must not edit or delete a seeded ticket, and must not assume an id maps to a particular title.

### Constraints established in stage 10 (binding on 11–16)

- **Use `splitValidationErrors(error, knownFields)` in `errorMessages.ts`, never map `details` onto
  fields directly.** Stage 8 established that an unknown query param's `details` key is `_`, not the
  param name — confirmed live: `?utm_source=slack` returns `details: { "_": [...] }`. Any key that is
  `_` *or* not a field the form renders goes to the form summary. **Stage 12 owns getting this right.**
- **`errorCopy()` is keyed off `code` with a generic fallback** and carries a `retryable` flag;
  `allowedTransitionsFrom()` extracts `details.allowed` for the status control. UI copy never renders
  raw server text for an unrecognised code.
- **Check `components/ui/index.ts` before writing a primitive.** Button, Input, Textarea, Select,
  Badge, Dialog, Skeleton, and `Field` (a render prop that does the label/control/error ARIA wiring
  once) already exist. Building a second one per page is what this stage existed to prevent.
- **`useTheme.ts` is the single source of the resolved theme** (a `useSyncExternalStore` store). The
  header toggle and the `<Toaster theme={…}>` both read it. Do not re-derive it locally.
- **Anything Sonner styles needs `!` or an unlayered rule.** Sonner injects its stylesheet unlayered
  at runtime, and unlayered CSS beats `@layer` regardless of specificity — it also injects *after*
  ours, so equal specificity loses too. The app's override is deliberately outside `@layer` at
  `:root [data-sonner-toaster][data-sonner-theme]`.
- **There is no `tailwind.config.ts`.** Tailwind v4 is CSS-first via `@theme inline` in `index.css`;
  `tests/design-tokens.test.ts` enforces light/dark key-set equality and the `@theme` mapping.
- **jsdom implements neither Pointer Capture nor `scrollIntoView`**, and Radix's Select calls both on
  the first pointer event. Stubs are in `apps/web/vitest.setup.ts` — **stage 13 would have hit this
  immediately**; do not remove them.
- **Query retry is a predicate (network + 5xx only), not a count.**
- **`StagePlaceholderPage` and `ShellPreviewPage` are stage-10 scaffolding**, marked in their doc
  comments. Stages 11–12 delete them.
- **`VITE_API_BASE_URL` is read with `||`, not `??`** — a present-but-empty value inlines `""`, which
  `??` passes through, sending every request to the Vite origin. Stage 14 sets this in a container, so
  a blank value is a realistic misconfiguration.

### Constraints established in stage 11 (binding on 12–16)

- **`useTicketListParams` picks known keys and preserves unknown ones on write.**
  `TICKET_LIST_PARAM_KEYS` is the ownership list. Bounds come from contract constants, but the
  per-field validators are hand-written **on purpose** — do not "simplify" them into
  `ticketListQuerySchema`, whose `.strict()` is what would reset every filter on a shared link.
- **Do not trust `setSearchParams`'s functional updater.** It closes over render-time
  `searchParams` (see shape 5 above). The hook keeps a `baseRef` advanced synchronously on write;
  `setFilters` takes a functional patch and `ChipGroup` reports *which value toggled*, not a whole
  array. Both halves are needed — with only the hook fixed, a stale `ChipGroup` still passes any test
  whose two writes touch different fields.
- **Assignee is one control.** `assignee` + `assigneeIsNull` are mutually exclusive on the wire and
  both the parser and `setFilters` enforce it, so the 422 is unrepresentable. Stage 12's forms keep
  that shape.
- **Date-only strings use `formatDateOnly()` (pinned to UTC), never `formatDate()`.** `new Date("2026-08-01")`
  parses as UTC midnight and formats in local time, so a chip west of UTC renders the previous day.
  `formatDate` keeps instant semantics. **Timezone-sensitive tests must set `TZ` and assert the
  timezone actually applied** before asserting anything else — a test run in UTC cannot see this class
  of bug at all.
- **`MD_BREAKPOINT_QUERY` renders one tree, not two.** `vitest.setup.ts` implements
  `(min-width:Npx)` against `window.innerWidth` and exports `setViewportWidth`; a constant-`false`
  stub would let a responsive test pass at the wrong width. Its resize handler is registered once over
  a registry — `useMediaQuery` calls `matchMedia()` on every render, so a per-call listener leaks.
- **Table column widths are tuned at 768px**, because `table-fixed` starves the flexible column
  exactly at the breakpoint. Retuning for 1280 alone collapsed the Title column to ~24px.
- **There is no page-level "New ticket" button** — `AppHeader` owns it.
- **Page tests stub `fetch`, not the hooks.** Stage 13 should swap MSW in at that same boundary.
- ~~**`StagePlaceholderPage` still backs the three stage-12 routes.**~~ Deleted in stage 12, as planned.
  Keeping it through stage 11 was deliberate: deleting it earlier would have sent `/tickets/new`
  (reachable from the empty-state CTA) to the 404.

### Constraints established in stage 12 (binding on 13–16)

- **The edit form diffs against the snapshot it was initialised from, not the live query data.**
  react-hook-form reads `defaultValues` once, so diffing against the current ticket lets a background
  refetch (`staleTime: 30_000` + `refetchOnMount`) make an untouched field look changed — and the
  PATCH then wipes a concurrent edit, which is the exact thing the diff exists to prevent.
  `TicketEditForm` holds the baseline in a ref, mounted on the same render that produced
  `defaultValues`. Do not "simplify" it back to the parent's `ticket`.
- **Server-error focus moves to the first `[aria-invalid="true"]` in DOM order**, not through
  `shouldFocus`. `status`/`priority`/`category` are unregistered Radix controls with no input ref, so
  `shouldFocus` is a silent no-op for them; the previous code moved focus nowhere at all. Falls back
  to the error summary, and deliberately does **not** move focus when nothing rendered (a 500).
- **The two halves of that fix mask each other.** With `serverErrors.ts` reverted, both page-level
  focus tests still pass, because the DOM-order effect is load-bearing. The `serverErrors` unit tests
  are the only thing pinning the `shouldFocus` half — if someone "restores" `shouldFocus: isFirst`,
  the page tests will not tell them. Same shape as stage 10's toast fixes.
- **Selects pass `shouldValidate: true` on change.** Nothing else re-runs the resolver for an
  unregistered control, so a server error under a select would never clear.
- **`status` is absent from create-mode form values, not empty.** `.strict()` makes a present key a
  client-side 422.
- **`TICKET_FORM_FIELDS` is the ownership list for `splitValidationErrors`.** A new field must be
  added there or its server message silently lands in the summary instead of under the input.
- **Deleting a ticket uses `refetchType: "none"` on the detail key.** The mutation's `onSuccess` runs
  while the detail page is still mounted, so a plain invalidation (or `removeQueries`) fires a
  guaranteed-404 `GET` for the row just deleted. Only visible in a production-build measurement.
- **Links into `/tickets/new` must carry `state={{ from: search }}`** — `listReturnState(location)` in
  `PageHeader.tsx`. `AppHeader` reads its own location, since it is not inside the list page.
- **`src/test/harness.tsx` is the test seam** — now MSW-backed: `mockApi(handlers)` keyed
  `"METHOD /path-suffix"`, exposing `requests`; handlers may be async; `renderRoute` returns the
  `router`. It uses `createMemoryRouter`, **not** `MemoryRouter` — the forms call `useBlocker`, which
  throws on a non-data router.
- **Tailwind v4 silently drops arbitrary variants it does not understand.** `[@media(hover:hover)]:`
  produced no CSS at all and left the comment delete button permanently visible; the app uses a
  `@custom-variant can-hover` instead. Third instance of this family (stage 10's `animate-in`, stage
  10's `@layer` override) — **check `document.styleSheets`, not the class list.**
- **Stage 15 can rely on**: `HD-0000NN` eyebrow text, `aria-label="Comment thread"`, per-comment
  `aria-label="Delete comment by <name>"`, dialog names `Delete HD-0000NN?` and `Discard this ticket?`,
  and the list query carried in `location.state.from`.

### Constraints established in stage 13 (binding on 14–16)

- **`mockApi` faults on an unmatched *or* ambiguous handler key**, and the fault is asserted in
  `afterEach` via `harnessFaults`. It does **not** throw from the resolver: a throw becomes a rejected
  request, the app turns it into `NETWORK_ERROR`, and a test asserting an error state then passes for
  the wrong reason. A mistyped key now fails at the point of the mistake — `mockApi: no handler for
  GET /api/v1/tickets/42. Declared: [GET /tickets/4]` — instead of one assertion later.
- **Suffix keys really can collide**, and the pair is `"POST /comments"` vs
  `"POST /tickets/42/comments"` — both match `POST /api/v1/tickets/42/comments`, and both spellings
  were already in use across the suite. (The *stated* collision, `/tickets` vs `/tickets/facets`, was
  false: `"/api/v1/tickets/facets".endsWith("/tickets")` is `false`.) The ambiguity check is what makes
  this safe, so it is enforced rather than documented — do not weaken it back into a comment.
- **With MSW listening in `error` mode, no test can reach a real server even if one is running on
  :4000.** That is the web-side equivalent of stage 5's dev-database protection, and it is worth the
  same care: do not add a passthrough.
- **Whether a navigation pushed or replaced is invisible from rendered output** — both spellings put
  the same screen on screen. Test it with `initialEntries` + `router.navigate(-1)`, which is why
  `renderRoute` returns the router.
- **`msw` is listed `false` in `pnpm-workspace.yaml`'s `allowBuilds`.** Leaving it out makes install
  exit non-zero with `ERR_PNPM_IGNORED_BUILDS`, same as `@scarf/scarf`. It is absent from `dist`.

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
| P8 | ~~The common view (`status` filter + `createdAt:desc`) plans as `SEARCH Ticket USING COVERING INDEX Ticket_statusRank_createdAt_idx` — covering, so no table row lookups~~ **Superseded by P23:** measured against a bare query in stage 3, not the query the list service actually issues | The composite index does pay off where it was designed to; the "covering" half was an artefact of the probe | Verified in stage 3, **corrected in stage 7** |
| P9 | Predicted non-covered paths, **two of the three predictions were wrong.** Correct: `q` is a full scan (leading-wildcard `LIKE` cannot use a B-tree — `DATABASE.md` says so deliberately). Wrong: ~~`priority:desc` + the `{id:"desc"}` tiebreaker falls back to a sort because `Ticket_priorityRank_idx` is single-column~~ — see P22. Wrong: ~~`facets` is an index-only scan~~ — see P19 | Irrelevant at 63 seeded rows | **Kept as a record of the failure mode, not as guidance.** Both wrong rows were predictions from reading the schema; both were corrected only when stage 6 and 7 logged the SQL Prisma actually emits and ran `EXPLAIN QUERY PLAN` on it. Predict the plan if you like, but do not write it down as measured |
| P22 | `priority:desc` does **not** fall back to a temp B-tree, contradicting P9. `Ticket_priorityRank_idx` is physically `(priorityRank, rowid)`, so a backwards walk already yields `priorityRank DESC, id DESC` and the tiebreaker rides along free: `SCAN Ticket USING INDEX Ticket_priorityRank_idx`, no `USE TEMP B-TREE` line | The tiebreaker direction is load-bearing and was nearly chosen by coin flip. `{ id: "asc" }` would have forced `USE TEMP B-TREE FOR LAST TERM OF ORDER BY` on every *descending* sort — including `createdAt:desc`, the default view | Keep `{ id: "desc" }`. Note the cost is symmetric, not free: measured, `ASC, id DESC` pairs *do* take the temp B-tree. `desc` is the right default because the default sort is descending, not because it is universally cheaper |
| P40 | Stage 12 costs **+59.25 kB raw / +18.57 kB gzip** (588.81 → 648.06 raw, 181.98 → 200.55 gzip): react-hook-form, `@hookform/resolvers`, and the zod parse paths `zodResolver` makes reachable | **P34 predicted this exactly** — it said the zod floor was the steady-state price of client and server enforcing one schema, and that stage 12 would bring zod back deliberately. It did. This is the cost of forms validating against the same rules the server does, and it is the right trade | None. It is also the last major dependency the web app takes on |
| P41 | Request counts against the **production** build: detail cold load **1**; add comment **2**; create submit → detail **2**; status change **2**; delete → list **3**; list cold **2**; list → detail client nav **1**; back to list within `staleTime` **0**. Cross-origin **preflights add one request to every write** | The write counts are one invalidation each, which is correct. The preflights are pure cross-origin overhead and **disappear when the app is served same-origin**, which is what the Docker compose setup does | Nothing to fix. Recorded because stage 14 will change these numbers for the better, and it should be able to show that |
| P42 | A guaranteed-404 `GET` fired after every ticket delete, because the mutation's `onSuccess` invalidates while the detail page is still mounted | One wasted round trip **and** a 404 in the server log for a perfectly normal user action — the kind of thing that trains people to ignore logs | Fixed in stage 12 with `refetchType: "none"` on the detail key plus normal invalidation of the list and facets keys. **Only visible in a production build** — StrictMode noise hides it in dev |
| P38 | The whole list screen costs **+24.6 kB raw / +6.9 kB gzip** over stage 10 (564.22 → 588.81 raw, 175.12 → 181.98 gzip) — filter bar, table, cards, pagination, badges, empty and error panels, and the URL-state hook | Cheap for the app's most complex screen, and it lands well inside any reasonable budget. The zod floor from P34 is still the single largest line item | None |
| P39 | Request counts, measured against the **production** build (dev doubles them via StrictMode): initial load **2** (`facets` + list), next page **1**, back to page 1 within `staleTime` **0**, seven keystrokes in the search box **1** | The debounce and `keepPreviousData` both do what they claim. The facets call is what makes case-sensitive assignee matching safe, and it is cached for 5 minutes | None. **Measure request counts against a production build** — StrictMode's double-mount makes a dev measurement wrong by 2× |
| P34 | **P5 re-measured at stage 10, and the ratio moved the way that matters.** Production bundle 564.22 kB raw / 175.12 kB gzip. The contracts import costs **17.88 kB gzip**, of which zod is **17.08 kB (95.5%)** and the schemas themselves are **0.80 kB** | P5 measured 30.4 kB gzip at ~82% zod. The absolute cost nearly halved *and* zod's share rose — which is tree-shaking working: the app imports four runtime symbols, so the schemas mostly vanish and what is left is almost purely the library. zod survives at all because `errors.ts` calls `z.enum(...)` at module scope and Rollup cannot prove a call pure | **No action, deliberately.** Dropping the last runtime import would remove zod entirely, but stage 12 wires `zodResolver` and brings it back on purpose. 17.9 kB gzip is the steady-state price of client and server enforcing the same schema — P5's "the lever is importing fewer schemas" is now spent |
| P35 | Install footprint: 496 MB / 433 packages → **625 MB / 590 packages** (+129 MB, +157) | Nearly all devDependencies; the runtime additions are React, Radix, TanStack Query, Sonner, and lucide | Does not reach any image: stage 14's web container ships a static `dist`, not `node_modules`. The API image is unaffected — P31's ~11.5 MB of Swagger is still the only runtime weight worth a decision |
| P36 | Web build 354–501 ms alone, 1.42–1.46 s through turbo with `^build` of contracts. Vite dev ready in **188–258 ms**. Three real dialog animations cost +0.9 kB raw / +0.19 kB gzip | Fast enough that stage 16's CI will be dominated by the API suite and Playwright, not the web build | None |
| P37 | **A failed `vite build` leaves a plausible-looking `dist/` behind.** With `packages/contracts/dist` absent, the build exits **1** with a clear Rolldown resolution error — but only after writing `dist/assets/*` that looks complete and is 70 kB smaller | Cost real time in stage 10: the truncated artifact was measured and briefly taken as evidence that zod had tree-shaken out. Same family as P10 — an artifact that disagrees with its inputs and looks fine | **Stage 14 must check the build's exit code, not the presence of `dist`.** So must stage 16's CI |
| P30 | Seed cost: **62–67 ms of database work** for 63 tickets + 180 comments in one transaction (29 ms on a warm run, 145 ms via compiled JS on a cold file), 1.69 s wall including `tsx` boot. `db:deploy` with no pending migrations is 2.17 s | The seed is not a cost worth optimising; the migration CLI around it is 30× larger and unavoidable | None |
| P31 | Install delta from stage 9: **478 MB → 496 MB, 423 → 433 packages.** `swagger-ui-dist` is **11 MB** of the 18; `@asteasolutions/zod-to-openapi` 336 kB, `swagger-ui-express` 32 kB. **Both the generator and `swagger-ui-express` are runtime dependencies**, unlike every prior delta | Stage 14's `--prod` image carries ~11.5 MB it would not otherwise need. P11 assumed the runtime image would be express + zod + dotenv + `@prisma/client`; that is no longer true | Stage 14 decides. Levers, in order: drop `/docs` from the production image while keeping the committed `openapi.json` (the spec is the artefact, the UI is a convenience), or serve the UI from a CDN (loses offline use). Do not reach for either before the image is actually measured |
| P32 | Route latency against **63 real seeded rows** (200 interleaved samples, p50/p95 ms): `/health` 0.34/0.59 · list default 1.63/2.49 · status + `createdAt:desc` 1.83/2.70 · `priority:desc` 1.61/2.45 · `q=printer` 1.78/2.51 · `pageSize=100` 2.53/3.65 · `page=4` 1.28/2.21 · `/tickets/42` 0.98/1.56 · `/tickets/facets` 0.82/1.33 | Uniformly **30–50% faster than P28's** fixture-based numbers, and `/health` again reproduces P13's baseline — so P28's service series was perturbed by its own interleaved sampling rather than stage 7 having regressed. Realistic data is *cheaper* than the fixtures, because the fixtures were adversarial | This is the number to quote for the API. Re-measure only if the seed size changes |
| P33 | **P29 is not reproducible against realistic data, and that is the escaping working.** A wildcard `q` now matches literally: `q=%e%` returns **0 rows**, `q=%` returns 1 (the one ticket whose description contains "100%"). There is no way to make the raw path match all 63 | P29's 16.75 ms p95 was an artefact of fixtures that contained bare metacharacters — exactly the inputs that used to mean "match everything" before stage 7 fixed the escaping. The D14 ceiling still stands in theory and is now unreachable in practice | Nothing. Recorded because a measurement that disappears when the bug it depended on is fixed is worth saying out loud |
| P27 | **P12's prediction confirmed in direction, wrong in magnitude.** Cold boot through `tsx` with `prisma.ts` and the route graph on the import path: min **369 ms** vs **188 ms** for stage 4's module set — roughly 2×, +180 ms at the floor. Split: ~76–84 ms is `lib/prisma.ts`, ~70–85 ms the routes/services graph | P12 expected a *sharp* rise from the native engine loading at import. It does not: the query-engine `.dylib` loads **lazily on the first query**, and that first query costs only 1.3–2.3 ms. The import cost is JavaScript, not the engine | Still nothing to do. If a Docker healthcheck flaps, `start_period` — as P12 said. Machine was noisy (188→772 ms spread); the minima are the signal |
| P28 | **The HTTP layer costs a flat ~1 ms**, independent of query cost: `GET /tickets` default view 2.34 ms p50 at the route vs 1.44 ms at the service; status filter 3.30 vs 2.20; `q=printer` 3.96 vs 2.87; wildcard `q` 4.43 vs 3.10. Also `GET /tickets/:id` 1.65, `/tickets/facets` 1.33, `POST /tickets` 3.39 | Flat overhead means routing and validation are not on the critical path — the database is, exactly as P13 predicted. Service numbers here run 1.5–2× above P24's, but `/health` reproduced P13's baseline at 0.26 ms, which says the interleaved-`fetch` harness perturbs the service series rather than stage 7 having regressed | Measured with service and HTTP samples **interleaved**, so machine drift lands on both series. Copy that method rather than comparing across sessions |
| P29 | Wildcard `q` is the worst number on the board: **p95 16.75 ms** at the route, against 5–7 ms for every other list shape | Consistent with D14's recorded cause — the raw path's `id IN (…)` gives up the ordering index and takes `USE TEMP B-TREE FOR ORDER BY`. At 63 rows. It is the only query whose p95 is an order of magnitude off its p50 | Nothing before FTS5. Recorded because it is the first measurement where the D14 tradeoff is visible rather than theoretical |
| P24 | `listTickets` p50 / p95 over 200 samples, 63 rows: default view **0.94 / 1.22 ms**; status filter + `createdAt:desc` **1.46 / 2.03**; `priority:desc` **0.81 / 1.03**; plain `q` matching all 63 **1.39 / 1.64**; wildcard `q` matching all 63 **1.85 / 2.27**; either `q` matching nothing ~0.8–0.9 | The whole list surface is comfortably inside 2 ms at seed scale, against P13's 0.28 ms zero-work baseline. Search is no longer the most expensive query in the app — a plain `q` is within noise of a plain filtered view | Baseline for stage 8's route-level numbers. Re-measure if the seed grows past 63 |
| P25 | Routing plain searches to `contains` and only wildcard searches to the raw prefilter is worth **~0.45 ms (~25%)** on identical 63-of-63 match sets | The raw path's `id IN (…)` gives up `Ticket_createdAt_idx` and takes `USE TEMP B-TREE FOR ORDER BY`; the fast path walks the index in order. Confirmed by plan, not inferred from timing | Done in stage 7. The equivalence that makes it safe is in `needsEscapedSearch`'s doc comment — do not collapse the two paths |
| P26 | The interactive `$transaction` is **not** slower than the `$transaction([findMany, count])` array form: the status-filter view was 1.42 ms p50 under the array form and 1.11 ms after the rework | The consistency guarantee now covers three queries instead of two, at no measured cost | Recorded because the plan specifies the array form; the deviation is a correctness requirement that turned out to be free |
| P23 | The status-filter view is `SEARCH Ticket USING INDEX Ticket_statusRank_createdAt_idx` — a search, **not covering**, contradicting P8. The list projects every column via `include: { _count }`, so each matched index entry still costs a table row lookup. Only the `count` half of the pair is covering | P8 measured a bare query in stage 3; the real list query has a different projection. The index is still doing its job — the ordering and the filter both come from it — but "covering" was never true for the actual query | None. Recorded because P8 is quoted as evidence that the composite index pays off, and it does, just not for the stated reason |
| P10 | **Turbo build caching was silently broken and is now fixed.** `incremental: true` writes its tsbuildinfo to `node_modules/.cache/tsc/`, which was not a declared `build` output. tsc decides whether to emit by comparing against that file, so a restored `dist` that disagreed with a surviving tsbuildinfo caused tsc to emit nothing — and the mismatch got re-cached | Severe: `packages/contracts/dist/index.js` was **absent entirely** while `pnpm build` reported success. It would have broken the runtime bundle, not just types | Fixed in stage 3 by caching the pair together: `outputs: ["dist/**", "node_modules/.cache/tsc/**"]` |
| P44 | **P10 recurs whenever `dist` is deleted without its tsbuildinfo, and it is silent.** Removing `packages/contracts/dist` by hand (a disk cleanup) left `node_modules/.cache/tsc/build.tsbuildinfo` behind; `tsc -p tsconfig.build.json` then **exits 0 and emits nothing**, `pnpm build` reports "3 successful", and every consumer fails at import with `Failed to resolve entry for package "@helpdesk/contracts"`. A `vite build` in that state produces P37's short bundle — **576.63 kB against the correct 649.10 kB** — and only fails on the unresolved import | The green exit code is the whole problem: build succeeds, tests fail somewhere unrelated-looking, and the cause is a file nobody deleted. It also briefly reads as a poisoned turbo cache — it is not, the entry is fine and re-executes correctly; the stale tsbuildinfo is the only cause | **Use the workspace `clean` scripts, never a bare `rm -rf dist`** — each one is `rm -rf dist .turbo node_modules/.cache` precisely because the pair must move together. Recovery is to delete both and rebuild. **Stage 16's CI must build from a genuinely clean tree** (no restored `node_modules/.cache`), or it can reproduce this against a cache and pass |
| P7 | `test` declares `outputs: []`; coverage moved to a separate `test:coverage` task | `pnpm test` no longer warns "no output files found" on every run, and coverage output is still cached when asked for | Done in stage 2 |
| P11 | Stage 4 install delta: **457 MB → 478 MB, 336 → 423 packages** for express + cors + tsx + vitest + supertest and their types. Express itself is ~1 MB; the delta is tsx/esbuild (~670 kB plus a platform binary) and vitest's vite tree (~2 MB per peer-resolved copy, four copies resolved across the workspace) | Dev-only weight. Both `tsx` and `vitest` are devDependencies, so stage 14's runtime image should install with `--prod` and carry only express, cors, zod, dotenv, and `@prisma/client` | Re-measure at stage 15 (Playwright browsers) |
| P12 | Cold boot of the API process, measured through `tsx`: **178 ms** to import `app.ts` (transitively `env.ts` + dotenv + express + cors), **1.4 ms** to run `createApp()`, **1.0 ms** to bind the port | The import is ~99% of boot, and almost all of it is module loading, not work. `prisma.ts` is *not* on this path yet — stage 8 will add the client import and this number will rise sharply (P1 notes the engine is a native `.dylib`) | Nothing now. Re-measure after stage 8; if the Docker healthcheck ever flaps on a cold start, this is the number to look at, and the answer is `start_period`, not code |
| P13 | `GET /health` latency over 200 sequential requests on a bound socket: **p50 0.28 ms, p99 1.77 ms** | The whole chain (requestId → json → cors → route) costs well under a millisecond, so any later latency is the database, not the middleware. `/health` deliberately touches no database, which is also why it is a fair baseline | Recorded as the "zero-work request" baseline for stages 7–8 |
| P14 | Stage 5 suite, 25 tests over 3 files on 8 cores: **1.5 s wall warm, ~5.3 s cold**, of which `globalSetup`'s single `prisma migrate deploy` is **0.63 s** and the per-worker template copy is sub-millisecond (57 kB) | The fixed cost is Prisma, not the tests: `tests` is 130–240 ms of the run. Cold-vs-warm is the query engine `.dylib` and vite's transform cache, both amortised | Nothing. The template-copy design is what keeps migrate off the per-worker path — do not "simplify" it into a per-worker `migrate deploy`, which would add ~0.6 s × workers |
| P15 | `setup` is the largest reported phase (200–500 ms aggregate warm, 12 s cold). With `isolate: true` (default) each **test file** re-runs `vitest.setup.ts` and therefore constructs its own `PrismaClient` | ~70–160 ms per file, paid once per file rather than once per worker. At the ~15 files stages 6–8 will add, that is 1–2 s of the run | Watch, do not act. If it dominates, the levers in order are: `poolOptions.forks.isolate: false` (risks cross-file module state), or a shared client behind `globalThis`. Neither is worth it below ~5 s |
| P16 | Truncation is 3 raw statements in one transaction per test, on an empty-ish file | Sub-millisecond; the 25-test run spends 130 ms in `tests` *including* every truncation | None. Truncating beats re-copying the file per test by an order of magnitude |
| P18 | Stage 6 suite: **~3.5 s wall warm / ~4.1 s cold**, 110 tests over 5 files (was 1.5 s / 25 tests at stage 5). 85 new tests cost ~2 s — **~19 ms/test** including a truncation each, so P16 still holds | Phase split warm: setup ~2.1 s, import ~1.5 s, tests ~1.6 s, transform ~1.0 s. **P15 is now confirmed as the dominant cost** — two new files added ~0.3 s of `setup` alone, and `setup` is ~60% of wall time while the tests themselves are ~46% | Watch. At stage 8's file count this crosses the ~5 s threshold P15 named as the point to try `poolOptions.forks.isolate: false` or a `globalThis`-cached client. Do not act before the number is actually there |
| P19 | **`GET /tickets/facets` was O(tickets), not O(distinct values).** Prisma's `distinct` is applied *in the client*: `findMany({ distinct: ["assignee"] })` emits `SELECT id, assignee FROM Ticket WHERE assignee IS NOT NULL ORDER BY assignee` and dedupes in memory. The `id` in the projection also makes an index-only plan impossible, so P9's "facets is an index-only scan" was wrong as written | Every facets request materialised one row per assigned ticket. Harmless at 63 rows, but the endpoint is called on every list-page load and the shape was wrong | **Fixed in stage 6.** Switched to `groupBy`, which emits a real `GROUP BY`; `EXPLAIN QUERY PLAN` now reports `SEARCH Ticket USING COVERING INDEX Ticket_assignee_idx`. Both the emitted SQL and the plan were logged, not assumed. `DATABASE.md` corrected |
| P20 | `updateTicket`'s pre-read loaded the full comment thread, which `prisma.ticket.update` then returned again | Every field patch read every comment on the ticket **twice**. Invisible on a 3-comment fixture, linear in thread length in production | **Fixed in stage 6.** The pre-read selects `{ id, status, resolvedAt }` — all the guard needs — and only the no-write branch goes back for the thread |
| P21 | Both writes now run inside `prisma.$transaction` (a correctness fix, logged here for its cost): one extra `BEGIN`/`COMMIT` round trip per PATCH and DELETE | Sub-millisecond on a local SQLite file; the suite wall time did not move measurably (3.50 s → 3.62 s, inside run-to-run noise) | None. The transaction is load-bearing — see the stage 6 constraints above |
