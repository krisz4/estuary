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
| 1 · Monorepo shell | pass — `pnpm install`, `typecheck`, `lint` clean; gates verified non-vacuous with throwaway probes | 10 findings, 8 fixed in-stage, 2 deferred (D1, D2) | `chore: scaffold monorepo shell` |

## Deferred work

| # | Item | Raised in | Reason deferred | Lands in |
| - | ---- | --------- | --------------- | -------- |
| D1 | `pnpm test:e2e` has no runner — `@playwright/test` is not installed | Stage 1 review #4 | Playwright pulls browser binaries; nothing before stage 15 uses it, and it is not in any earlier gate | Stage 15 |
| D2 | `packages/tsconfig/react-app.json` is unexercised — `types: ["vite/client"]` needs Vite present | Stage 1 review | No React app exists yet; option-set correctness was verified with `tsc`, resolution cannot be | Stage 10 |
| D3 | `pnpm test` is a turbo passthrough with no package implementing `test` | Stage 1 | vitest arrives with the first workspace that has tests | Stage 2 |
| D4 | pnpm pinned at `11.1.2` while `11.21.0` is available | Stage 1 | A version bump wants CI to agree with the pin; both should move together | Stage 16 |

### Constraints established for later stages

- **`packages/contracts` must extend `@helpdesk/tsconfig/library.json`, not `base.json`.** That base
  sets `NodeNext` resolution so emitted `.d.ts` files carry explicit `.js` extensions. `base.json`'s
  `Bundler` resolution emits extensionless specifiers, which `apps/api` (NodeNext) cannot resolve —
  it fails as `TS2307` on the first cross-package import. Source imports in contracts are therefore
  written `from "./ticket.js"`. Raised as Stage 1 review finding #5, fixed before it could bite.

## Performance ledger

Candidates are recorded when observed and only actioned when a stage's gate or a measurement
justifies it — the project is a graded take-home on SQLite, not a system under load.

| # | Observation | Impact | Action |
| - | ----------- | ------ | ------ |
| P1 | Cold `pnpm install` 13.8s / warm 0.5s, ~215 packages across 2 workspaces | Baseline | Re-measure after stage 3 (Prisma engines) and stage 15 (Playwright browsers) — those two dominate the final install size |
| P2 | `build.inputs` excludes `**/*.test.ts(x)` | Editing a test does not invalidate a package's build cache, and therefore not `^build` for everything downstream | Done in stage 1; matters most for `packages/contracts`, which every workspace depends on |
| P3 | Turborepo remote caching is off; `globalDependencies` is deliberately narrow | CI wall time at stage 16 | Leave off. Revisit only if CI is slow — enabling it is a one-line change |
| P4 | `lint` is a single root `eslint .` pass rather than a turbo fan-out | One process instead of N; also keeps the ruleset in one file | Intentional. It is also why `lint` declares `dependsOn: []` — it must never serialize behind builds |
