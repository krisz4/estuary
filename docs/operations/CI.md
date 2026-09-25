# CI

`.github/workflows/ci.yml`. Runs on pushes to `main`, on every pull request, and on manual dispatch.

> **This workflow has never been run by GitHub Actions** — the repository has no remote (D23 in
> [../engineering/BUILD_LOG.md](../engineering/BUILD_LOG.md)). Every step below was executed locally,
> in this order, and is green; what is unproven is the workflow *as a workflow*. Expect the first real
> run to be where the runner-only parts get their first test.

Two jobs in parallel:

| Job | Steps |
| --- | ----- |
| `verify` | install → `typecheck` → `lint` → `format:check` → `build` (+ output assertions) → OpenAPI freshness → migration drift → `test` |
| `e2e` | install → `build` → Playwright chromium → `test:e2e` |

The gate order inside `verify` is the one [../engineering/TESTING.md](../engineering/TESTING.md#conventions) states: `typecheck` → `lint` → `test`, with `test:e2e` last. Cheap and broad first, so a formatting slip does not wait behind the Playwright download.

## Why two jobs and not one

`e2e` pays a Playwright browser download that `verify` does not need, and `verify` runs three test suites `e2e` does not. Splitting them means a unit-test failure surfaces without waiting on chromium. The cost is paying `pnpm install` twice — accepted, because the pnpm store is cached and the install is mostly hardlinks (P1 in [../engineering/BUILD_LOG.md](../engineering/BUILD_LOG.md)).

## The four checks that exist only in CI

Everything else in the workflow is a script a developer already runs. These four are not:

**Build output is asserted, not assumed.** `test -s` on each expected artifact (`packages/contracts/dist/index.js`, `apps/api/dist/server.js`, `apps/api/dist/seed/index.js`, `apps/web/dist/index.html`). A non-zero exit already fails the step; the assertions cover P37, where a *failed* `vite build` leaves a plausible-looking `dist/` behind that is ~70 kB short. The Dockerfiles make the same assertions for the same reason. Never infer a successful build from a directory existing.

**`openapi.json` must be current.** The job regenerates the spec and fails if the working tree is then dirty. The spec is a committed artefact derived from the zod contracts, so it goes stale silently — a contract change that shipped without `pnpm --filter @helpdesk/api openapi:gen` fails here. Promised by [../features/API_Documentation.md](../features/API_Documentation.md#rules).

**`schema.prisma` must match its migrations.** `migrate deploy` replays the migration *files* and reports success, so it cannot detect a schema change nobody wrote a migration for. The job replays the migrations onto an empty database and then runs `prisma migrate diff --from-schema-datasource --to-schema-datamodel --exit-code`; exit 2 means the two disagree. This is checklist rule #2 in [../../CLAUDE.md](../../CLAUDE.md) enforced mechanically, and it is the same check the container entrypoint runs before serving ([DOCKER.md](./DOCKER.md)) — which matters, because the stage 14 Docker gate has still never been executed (D22).

**`format:check`.** Not in the plan's stated gate order, but every stage from 6 onward gated on it, so CI does too.

## Three settings that are load-bearing

**Node 24, not 20.** The root `engines` field says `^22.18.0 || >=24.11.0`, and both halves are load-bearing. The repo pins `pnpm@11.1.2`, pnpm 11 imports `node:sqlite`, and that builtin does not exist before Node 22.5 — on Node 20 every install dies with `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` before resolving a single package. The upper floor comes from `@babel/core` 8, which the web build takes on for the React Compiler (P45) and which itself declares `^22.18.0 || >=24.11.0`. 24 is the active LTS, satisfies both, and is what the images use.

The `engines` range used to read `>=20.11.0`, which was already fiction — no install had worked on Node 20 since the pnpm pin. It was corrected when the compiler made a *second* tool disagree with it.

**pnpm's version appears nowhere in the workflow.** `pnpm/action-setup` reads `packageManager` from the root `package.json`, so CI cannot disagree with the pin. That coupling is the whole reason D4's pnpm bump was deferred to stage 16: it is now a one-line change in one file, not two that have to move together.

**No build cache is restored.** `actions/setup-node`'s `cache: pnpm` caches the pnpm *store* — downloaded tarballs — and nothing else. `node_modules`, `.turbo`, and `node_modules/.cache/tsc` are always built fresh. P44 is why: a restored `dist` that disagrees with a surviving `tsbuildinfo` makes `tsc` exit 0 and emit nothing, so a build cache can carry a broken tree to green. **Do not add an `actions/cache` step for `.turbo` without reading P44 first.** Turborepo remote caching is off for the same reason plus P3.

## `apps/mcp` is covered without a dedicated step

`pnpm build`, `pnpm typecheck`, and `pnpm test` all run through `turbo run <task>`, and Turborepo runs a task for every workspace that defines it. `apps/mcp` has `build`, `typecheck`, and `test` scripts (`apps/mcp/package.json`), so it is built and tested by the same three steps every other workspace is, with no `apps/mcp`-specific line in the workflow. **The one gap:** "Assert build output" checks `packages/contracts/dist/index.js`, `apps/api/dist/server.js`, `apps/api/dist/seed/index.js`, and `apps/web/dist/index.html`, but not `apps/mcp/dist/index.js` — a silently-empty MCP build would still pass CI. Worth adding the same `test -s` line if `apps/mcp`'s build ever needs the same guarantee as the others.

## What CI does not do

- **No Docker build.** The compose stack is not exercised here; its gate is a human running `docker compose up --build` on a clean volume (D22). A `docker build` step would prove the images build, not that the app comes up seeded and survives a `down`, which is the part that has never been verified.
- **No coverage gate.** `test:coverage` exists as a script; no threshold is enforced. A coverage number is not the property the suite is trying to have — see TESTING.md's opening line.
- **No deployment.** There is nowhere to deploy to; see [DOCKER.md](./DOCKER.md) § Not included.
- **No retries anywhere.** `playwright.config.ts` sets `retries: 0` including in CI. An intermittent failure a retry turns green is exactly the signal the suite exists to produce.

## Related

- [../engineering/TESTING.md](../engineering/TESTING.md) — what each layer covers
- [../engineering/BUILD_LOG.md](../engineering/BUILD_LOG.md) — P3, P37, P43, P44, D4, D22, D23
- [DOCKER.md](./DOCKER.md)
