# Environment variables

Keep this file in sync with `apps/api/env.example`, `apps/web/env.example`, and `apps/mcp/env.example`. A new variable is added here and in its workspace's `env.example` in the same change set.

## `apps/api`

| Variable | Required | Default | Read by | Purpose |
| -------- | -------- | ------- | ------- | ------- |
| `DATABASE_URL` | yes | **none** | Prisma | SQLite file path. Relative paths resolve from `apps/api/prisma/`, so `file:./data/helpdesk.db` (the `env.example` value) lands at `apps/api/prisma/data/helpdesk.db`. **Deliberately has no default:** a default is what turns a missing or misordered test `setupFiles` entry into a truncated dev database instead of a boot error |
| `PORT` | no | `4000` | `src/server.ts` | API listen port |
| `HOST` | no | `0.0.0.0` | `src/server.ts` | The code default suits the container, which is where `0.0.0.0` is actually required. `env.example` ships `127.0.0.1` instead: without `API_TOKEN` the API has no access control at all, so binding every interface on a laptop publishes full task CRUD to the LAN |
| `NODE_ENV` | no | `development` | app-wide | `production` disables verbose errors. It does **not** control seeding — see `ALLOW_SEED` |
| `ALLOWED_ORIGINS` | no | `http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173` | cors middleware | Comma-separated. **Four origins, because a browser sees four:** `localhost` and `127.0.0.1` are different origins, and so are port `5173` (`vite dev`) and `4173` (`vite preview` — the production build). Listing fewer is what left the preview build unable to reach the API (D21), as an opaque network error naming nothing. Not on the request path in Docker: nginx proxies `/api/` on the same origin, and **Swagger UI is same-origin too** — the OpenAPI document declares `servers: [{ url: "/" }]`, so "try it out" resolves against whichever origin served `/docs`, on both `:4000` and the proxied `:5173`. What it still covers is `vite preview` on `:4173` and a web image rebuilt with an absolute `VITE_API_BASE_URL`. **The E2E suite is not one of the four** — it runs its own API on its own port and sets this variable itself |
| `ALLOW_SEED` | no | `false` | `src/seed/index.ts` | `true` permits seeding even under `NODE_ENV=production`; outside production no flag is needed. The switch is this variable and not `NODE_ENV`, so the Docker image can ship demo data while still running a production build — keying the refusal on `NODE_ENV` alone would make the container unable to seed at all, and the workaround would be lying about `NODE_ENV`, which turns off verbose errors as a side effect. Seeding **deletes every task and comment first** |
| `SEED_ON_START` | no | `false` | `apps/api/docker-entrypoint.sh` | Seeds after `migrate deploy`, but only when the task table is empty. **The variable is declared in `env.ts`'s schema, but nothing reads `env.SEED_ON_START`** — the actor is the entrypoint shell, which reads the raw variable before node starts. It is in the schema anyway so that it is validated and documented in one place rather than being an undeclared string the container happens to pass; the entrypoint accepts the same four spellings (`true` \| `1` \| `yes` \| `on`) the zod parser does, so the two cannot disagree |
| `LOG_LEVEL` | no | `info` | logger | `debug` \| `info` \| `warn` \| `error` |
| `DOCS_ENABLED` | no | `true` | `src/app.ts` | Set `false` to hide Swagger UI. When false the `/docs` router is never mounted and the OpenAPI document is never generated, so `/docs` and `/docs/openapi.json` are ordinary 404 `NOT_FOUND` responses |
| `BODY_LIMIT` | no | `1mb` | json parser | Over-limit bodies become `PAYLOAD_TOO_LARGE` |
| `API_TOKEN` | no | unset (no gate) | `src/app.ts` → `middleware/apiToken.ts` | Optional shared secret for self-hosted deployments. When set, every `/api/v1` request must carry `Authorization: Bearer <API_TOKEN>` or gets `UNAUTHORIZED` (401); `/health` and `/docs` stay open, and CORS preflights pass. Unset means no check at all — right for localhost, wrong for anything reachable from a network you do not control. **At least 16 characters**, so a placeholder like `changeme` fails boot instead of protecting nothing. One token for every caller, humans and agents alike: it is a gate, not accounts — who did what is still the self-declared `X-Actor` header. Compared with `timingSafeEqual`. Read once, when `createApp()` builds the app |
| `AGENTS_MAY_COMPLETE` | no | `false` | `services/task-workflow.service.ts` | Whether an `agent:` actor may transition a task to `done`. Off by default: agents hand finished work to `needs_qa` and a human closes it, and an agent trying gets `ACTOR_NOT_PERMITTED` (403). Turn it on for a fully autonomous setup where a QA agent does the closing. Same four truthy spellings as the other booleans (`true` \| `1` \| `yes` \| `on`) |
| `CLAIM_LEASE_MINUTES` | no | `30` | `services/task-guards.ts` (`leaseExpiry`) | How long a claim lasts without a heartbeat or a write from its holder, 1–1440. Short enough that a crashed agent's task comes back to `POST /tasks/next` within the working session, long enough that an agent deep in a build does not lose its task. An expired lease serializes as `claim: null` and the task is claimable by anyone |
| `GITHUB_TOKEN` | no | unset | `services/github.service.ts` | The optional GitHub integration ([../features/GitHub_Integration.md](../features/GitHub_Integration.md)) is **enabled** when this or `GITHUB_WEBHOOK_SECRET` is set. A fine-grained PAT or GitHub App token, **read-only** (pull requests, issues, commit statuses), used for link status (`GET /tasks/:id/github`) and issue import. Without it, calls are anonymous — public repos only, 60 req/hour. Never logged, never echoed on a response |
| `GITHUB_WEBHOOK_SECRET` | no | unset | `services/github.service.ts` | Enables `POST /integrations/github/webhook`. GitHub signs each delivery with this secret (`X-Hub-Signature-256`, HMAC-SHA256 over the raw body); a missing or wrong signature is `INVALID_WEBHOOK_SIGNATURE` (401). **At least 16 characters** |
| `GITHUB_API_URL` | no | `https://api.github.com` | `lib/github-client.ts` | GitHub Enterprise base URL. Leave at the default for github.com |

## `apps/web`

Vite only exposes variables prefixed `VITE_` to client code. Anything else is silently undefined in the browser — a very quiet failure mode.

| Variable | Required | Default | Read by | Purpose |
| -------- | -------- | ------- | ------- | ------- |
| `VITE_API_BASE_URL` | yes | `http://localhost:4000/api/v1` | `src/api/http.ts` | API root. Whatever it is, it must be **browser-reachable** and never the compose service name (`http://api:4000/...`) — the request is made by the user's browser, which cannot resolve a compose network alias. In Docker it is the **relative** `/api/v1`, passed as a build arg: nginx serves the app and proxies `/api/` to the API, so nothing is cross-origin. Vite inlines this at **build** time, so setting it under compose's `environment:` does nothing |
| `WEB_SOURCEMAP` | no | unset (source maps **on**) | `vite.config.ts` | Set to the exact string `false` to build without source maps. `apps/web/Dockerfile` sets it, because the runtime stage copies `dist/` into nginx and serves it publicly under `/assets/` with a one-year cache — every `.map` would publish the original TypeScript and roughly double the asset bytes in the image. **Not in `apps/web/env.example`, deliberately:** it is read by the node process running Vite, not by browser code, and Vite loads `.env` files *after* the config module has already been evaluated — a value in `.env` would be silently ignored. Set it in the shell or in a build stage |

## `apps/mcp`

The MCP server is spawned by Claude Code, so these come from the MCP configuration that launches it — the `env` block of the root `.mcp.json`, a `claude mcp add -e KEY=value`, or the plugin's options (`integrations/claude-code`) — not from a `.env` file. The server does not load one; `apps/mcp/env.example` documents the values and works with `node --env-file=apps/mcp/.env apps/mcp/dist/index.js` for a manual run. Parsed once at startup by `src/config.ts`; a malformed value exits with a message naming the variable. Blank counts as unset, because `${VAR:-}` and an unset plugin option both arrive as `""`. See [../features/Agent_Integration.md](../features/Agent_Integration.md).

| Variable | Required | Default | Read by | Purpose |
| -------- | -------- | ------- | ------- | ------- |
| `TASKS_API_URL` | no | `http://localhost:4000/api/v1` | `src/config.ts` | API root **including `/api/v1`**. For a self-hosted server, its public URL (`https://tasks.example.com/api/v1`); in the Docker stack the web origin also works, since nginx proxies `/api/` |
| `TASKS_ACTOR` | no | derived per checkout | `src/config.ts` | Sent as `X-Actor` on every request. Validated with the contract's `actorSchema` (`agent:<name>` or `human:<name>`), so a typo fails at startup instead of on the first write. Unset: `agent:claude-code@<project>`, or `agent:claude-code@<project>/<worktree>` inside a linked git worktree (plain `agent:claude-code` if no project resolves) — stable per checkout, distinct per worktree. Two sessions in the same checkout share it; set it per session if you run that way — claims and the audit trail key off it |
| `TASKS_API_TOKEN` | no | unset | `src/config.ts` | Sent as `Authorization: Bearer <token>`. Required only when the API runs with `API_TOKEN` set; must equal it |
| `TASKS_DEFAULT_PROJECT` | no | the repository's name | `src/config.ts` | What `task_create` and `task_next` use when a call names no project. Unset, the first valid slug of: the repo name of `git remote get-url origin`; the main checkout's directory (parent of `git rev-parse --git-common-dir`, the same from every worktree); `basename($CLAUDE_PROJECT_DIR)` (which Claude Code sets for every stdio server); else no project. Git runs in `CLAUDE_PROJECT_DIR` and every failure falls through. `task_list`, `task_stats`, and `task_events` never apply it — a read should not silently hide work |
| `TASKS_MCP_SERVER` | no | `<plugin>/../../apps/mcp/dist/index.js` | `integrations/claude-code/scripts/start-mcp.mjs` | Plugin only (the `server_path` option): where the built server is, when the plugin is not loaded in place from this repository |

## Tests

| Variable | Set by | Purpose |
| -------- | ------ | ------- |
| `DATABASE_URL` | `apps/api/vitest.setup.ts` (a `setupFiles` entry, which runs **before** test modules import `lib/prisma.ts`) | Points each vitest worker at its own temp file; never the dev DB |
| `PLAYWRIGHT_BASE_URL` | read by `e2e/env.ts`, defaults to `http://127.0.0.1:5183` | The E2E web origin. **Deliberately not `5173`/`4000`:** on the development ports, a `pnpm dev` already running would be picked up and the mutating specs would create and delete tasks in the developer's own database. Set it only to point the suite at a web server you started yourself. One spelling — `127.0.0.1`, never `localhost`, because Vite is started with `--host 127.0.0.1` and `localhost` may resolve to `::1` only, depending on the machine |
| `DATABASE_URL` | `playwright.config.ts` (API `webServer`) and `e2e/prepareDatabase.ts` | `file:<repo>/e2e/helpdesk-e2e.db` — the **third** database: not the dev file, not the vitest temp files. Gitignored with its `-wal`/`-shm` siblings. Built by `e2e/prepareDatabase.ts` (delete, `migrate deploy`, seed), run as the **first half of the API's `webServer` command** — before the API process exists, and before `globalSetup.ts`, since Playwright starts `webServer` entries first and the API opens the SQLite file at boot to switch it to WAL. `globalSetup.ts` only checks, over HTTP, that the running API is reading the database `prepareDatabase.ts` just built |
| `PORT` / `HOST` / `ALLOWED_ORIGINS` / `LOG_LEVEL` / `DOCS_ENABLED` | `playwright.config.ts` (API `webServer`) | `4010` on `127.0.0.1`, CORS limited to the two spellings of the E2E web origin, quiet logs, no Swagger. Set per-process, so the API's own defaults are untouched |
| `VITE_API_BASE_URL` | `playwright.config.ts` (web `webServer`) | `http://127.0.0.1:4010/api/v1`. Vite reads `VITE_`-prefixed variables from `process.env` in dev, so no `.env` file is involved |
| `API_TOKEN` / `AGENTS_MAY_COMPLETE` / `CLAIM_LEASE_MINUTES` | `apps/api/vitest.setup.ts` | Pinned to `""` (→ their defaults) before `lib/env.ts` loads, so a value in a developer's `apps/api/.env` cannot gate every route test behind a 401 or flip the agent-completion rule. Tests that need another value assign it on the `env` object and restore it afterwards |
| `ALLOW_SEED` | `e2e/globalSetup.ts` | Not strictly required — the E2E run is not `NODE_ENV=production` — but set explicitly, because the seed **deletes every task and comment first** and a switch saying so belongs at the call site |

## Rules

- `.env` files are gitignored. `env.example` files are committed with safe placeholder values.
- The one secret is `API_TOKEN`, and it is optional. It goes in `.env` (or the deployment's environment) and never into git: `env.example` ships it commented out, and `docker-compose.yml` passes it through from the shell (`${API_TOKEN:-}`) rather than carrying a value.
- API env vars are parsed **once** at boot through a zod schema in `src/lib/env.ts`. A missing or malformed required variable exits with a clear message instead of failing later as `undefined`.
- No `process.env` access outside `src/lib/env.ts`.
- `src/lib/env.ts` loads `apps/api/.env` itself. Without that, the Prisma CLI reads `.env` but the
  server does not, and `db:migrate` and `pnpm dev:api` end up talking to different databases with no
  warning. It loads with `override: false`, so a value already in `process.env` wins — that is what
  keeps a vitest worker's `DATABASE_URL` from being replaced by the developer's `.env`.
- A blank value is treated as absent, so `PORT=` in a compose file falls back to the default rather
  than aborting boot. zod's `.default()` only fires on `undefined`, and `z.coerce.number("")` is `0`.

## Related

- [../operations/DOCKER.md](../operations/DOCKER.md) — how these are set in compose
- [ARCHITECTURE.md](./ARCHITECTURE.md)
