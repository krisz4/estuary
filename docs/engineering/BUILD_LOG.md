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

## Deferred work

| # | Item | Raised in | Reason deferred | Lands in |
| - | ---- | --------- | --------------- | -------- |
| D1 | `pnpm test:e2e` has no runner — `@playwright/test` is not installed | Stage 1 review #4 | Playwright pulls browser binaries; nothing before stage 15 uses it, and it is not in any earlier gate | Stage 15 |
| D2 | `packages/tsconfig/react-app.json` is unexercised — `types: ["vite/client"]` needs Vite present | Stage 1 review | No React app exists yet; option-set correctness was verified with `tsc`, resolution cannot be | Stage 10 |
| ~~D3~~ | ~~`pnpm test` is a turbo passthrough with no package implementing `test`~~ | Stage 1 | — | **Resolved in stage 2** — vitest is in the graph; `test:coverage` wired too |
| D4 | pnpm pinned at `11.1.2` while `11.21.0` is available | Stage 1 | A version bump wants CI to agree with the pin; both should move together | Stage 16 |
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

## Performance ledger

Candidates are recorded when observed and only actioned when a stage's gate or a measurement
justifies it — the project is a graded take-home on SQLite, not a system under load.

| # | Observation | Impact | Action |
| - | ----------- | ------ | ------ |
| P1 | Cold `pnpm install` 13.8s / warm 0.5s, ~215 packages across 2 workspaces | Baseline | Re-measure after stage 3 (Prisma engines) and stage 15 (Playwright browsers) — those two dominate the final install size |
| P2 | `build.inputs` excludes `**/*.test.ts(x)` | Editing a test does not invalidate a package's build cache, and therefore not `^build` for everything downstream | Done in stage 1; matters most for `packages/contracts`, which every workspace depends on |
| P3 | Turborepo remote caching is off; `globalDependencies` is deliberately narrow | CI wall time at stage 16 | Leave off. Revisit only if CI is slow — enabling it is a one-line change |
| P4 | `lint` is a single root `eslint .` pass rather than a turbo fan-out | One process instead of N; also keeps the ruleset in one file | Intentional. It is also why `lint` declares `dependsOn: []` — it must never serialize behind builds |
| P5 | `@helpdesk/contracts` costs `apps/web` 14.3 kB raw / 5.3 kB gzip; **with zod bundled it is 144.6 kB / 30.4 kB gzip** | zod is ~82% of the contracts import cost — it is the number to watch, not the schemas | `sideEffects: false` is set so unused exports tree-shake. Re-measure at stage 10; if the web bundle needs trimming, the lever is importing fewer schemas into the browser, not shrinking them |
| P6 | Schema parse cost, warmed, 20k iterations: `ticketListQuerySchema` 5.4 µs, `createTicketInputSchema` 2.3 µs | Negligible next to a SQLite round-trip. The query schema is ~2.3× the body schema (preprocess wrapper + three `repeatable()` preprocessors) | None. Recorded so it is not re-measured |
| P7 | `test` declares `outputs: []`; coverage moved to a separate `test:coverage` task | `pnpm test` no longer warns "no output files found" on every run, and coverage output is still cached when asked for | Done in stage 2 |
