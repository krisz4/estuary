# Environment variables

Keep this file in sync with `apps/api/env.example` and `apps/web/env.example`. A new variable is added in all three places in the same change set.

## `apps/api`

| Variable | Required | Default | Read by | Purpose |
| -------- | -------- | ------- | ------- | ------- |
| `DATABASE_URL` | yes | **none** | Prisma | SQLite file path. Relative paths resolve from `apps/api/prisma/`, so `file:./data/helpdesk.db` (the `env.example` value) lands at `apps/api/prisma/data/helpdesk.db`. **Deliberately has no default:** a default is what turns a missing or misordered test `setupFiles` entry into a truncated dev database instead of a boot error |
| `PORT` | no | `4000` | `src/server.ts` | API listen port |
| `HOST` | no | `0.0.0.0` | `src/server.ts` | The code default suits the container, which is where `0.0.0.0` is actually required. `env.example` ships `127.0.0.1` instead: the app has no authentication by design, so binding every interface on a laptop publishes full ticket CRUD to the LAN |
| `NODE_ENV` | no | `development` | app-wide | `production` disables verbose errors. It does **not** control seeding — see `ALLOW_SEED` |
| `ALLOWED_ORIGINS` | no | `http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173` | cors middleware | Comma-separated. **Four origins, because a browser sees four:** `localhost` and `127.0.0.1` are different origins, and so are port `5173` (`vite dev`) and `4173` (`vite preview` — the production build). Listing fewer is what left the preview build unable to reach the API (D21), as an opaque network error naming nothing. Not on the request path in Docker: nginx proxies `/api/` on the same origin. It still covers Swagger UI's "try it out" against the published `:4000` and a web image rebuilt with an absolute `VITE_API_BASE_URL`. **The E2E suite is not one of the four** — it runs its own API on its own port and sets this variable itself |
| `ALLOW_SEED` | no | `false` | `src/seed/index.ts` | `true` permits seeding even under `NODE_ENV=production`; outside production no flag is needed. The switch is this variable and not `NODE_ENV`, so the Docker image can ship demo data while still running a production build — keying the refusal on `NODE_ENV` alone would make the container unable to seed at all, and the workaround would be lying about `NODE_ENV`, which turns off verbose errors as a side effect. Seeding **deletes every ticket and comment first** |
| `SEED_ON_START` | no | `false` | `apps/api/docker-entrypoint.sh` | Seeds after `migrate deploy`, but only when the ticket table is empty. Read by the shell, not by `env.ts` — the entrypoint accepts the same four spellings (`true` \| `1` \| `yes` \| `on`) the zod parser does, so the two cannot disagree |
| `LOG_LEVEL` | no | `info` | logger | `debug` \| `info` \| `warn` \| `error` |
| `DOCS_ENABLED` | no | `true` | `src/app.ts` | Set `false` to hide Swagger UI. When false the `/docs` router is never mounted and the OpenAPI document is never generated, so `/docs` and `/docs/openapi.json` are ordinary 404 `NOT_FOUND` responses |
| `BODY_LIMIT` | no | `1mb` | json parser | Over-limit bodies become `PAYLOAD_TOO_LARGE` |

## `apps/web`

Vite only exposes variables prefixed `VITE_` to client code. Anything else is silently undefined in the browser — a very quiet failure mode.

| Variable | Required | Default | Read by | Purpose |
| -------- | -------- | ------- | ------- | ------- |
| `VITE_API_BASE_URL` | yes | `http://localhost:4000/api/v1` | `src/api/http.ts` | API root. Whatever it is, it must be **browser-reachable** and never the compose service name (`http://api:4000/...`) — the request is made by the user's browser, which cannot resolve a compose network alias. In Docker it is the **relative** `/api/v1`, passed as a build arg: nginx serves the app and proxies `/api/` to the API, so nothing is cross-origin. Vite inlines this at **build** time, so setting it under compose's `environment:` does nothing |

## Tests

| Variable | Set by | Purpose |
| -------- | ------ | ------- |
| `DATABASE_URL` | `apps/api/vitest.setup.ts` (a `setupFiles` entry, which runs **before** test modules import `lib/prisma.ts`) | Points each vitest worker at its own temp file; never the dev DB |
| `PLAYWRIGHT_BASE_URL` | read by `e2e/env.ts`, defaults to `http://127.0.0.1:5183` | The E2E web origin. **Deliberately not `5173`/`4000`:** on the development ports, a `pnpm dev` already running would be picked up and the mutating specs would create and delete tickets in the developer's own database. Set it only to point the suite at a web server you started yourself. One spelling — `127.0.0.1`, never `localhost`, because Vite binds the IPv4 address and `localhost` also resolves to `::1` |
| `DATABASE_URL` | `playwright.config.ts` (API `webServer`) and `e2e/globalSetup.ts` | `file:<repo>/e2e/helpdesk-e2e.db` — the **third** database: not the dev file, not the vitest temp files. Gitignored with its `-wal`/`-shm` siblings |
| `PORT` / `HOST` / `ALLOWED_ORIGINS` / `LOG_LEVEL` / `DOCS_ENABLED` | `playwright.config.ts` (API `webServer`) | `4010` on `127.0.0.1`, CORS limited to the two spellings of the E2E web origin, quiet logs, no Swagger. Set per-process, so the API's own defaults are untouched |
| `VITE_API_BASE_URL` | `playwright.config.ts` (web `webServer`) | `http://127.0.0.1:4010/api/v1`. Vite reads `VITE_`-prefixed variables from `process.env` in dev, so no `.env` file is involved |
| `ALLOW_SEED` | `e2e/globalSetup.ts` | Not strictly required — the E2E run is not `NODE_ENV=production` — but set explicitly, because the seed **deletes every ticket and comment first** and a switch saying so belongs at the call site |

## Rules

- `.env` files are gitignored. `env.example` files are committed with safe placeholder values.
- No secrets exist in this project (no auth, no third-party APIs). If that changes, the secret goes in `.env` and a placeholder in `env.example` — never a real value in git.
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
