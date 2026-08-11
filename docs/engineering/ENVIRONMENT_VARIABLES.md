# Environment variables

Keep this file in sync with `apps/api/env.example` and `apps/web/env.example`. A new variable is added in all three places in the same change set.

## `apps/api`

| Variable | Required | Default | Read by | Purpose |
| -------- | -------- | ------- | ------- | ------- |
| `DATABASE_URL` | yes | **none** | Prisma | SQLite file path. Relative paths resolve from `apps/api/prisma/`, so `file:./data/helpdesk.db` (the `env.example` value) lands at `apps/api/prisma/data/helpdesk.db`. **Deliberately has no default:** a default is what turns a missing or misordered test `setupFiles` entry into a truncated dev database instead of a boot error |
| `PORT` | no | `4000` | `src/server.ts` | API listen port |
| `HOST` | no | `0.0.0.0` | `src/server.ts` | The code default suits the container, which is where `0.0.0.0` is actually required. `env.example` ships `127.0.0.1` instead: the app has no authentication by design, so binding every interface on a laptop publishes full ticket CRUD to the LAN |
| `NODE_ENV` | no | `development` | app-wide | `production` disables verbose errors. It does **not** control seeding — see `ALLOW_SEED` |
| `ALLOWED_ORIGINS` | no | `http://localhost:5173,http://127.0.0.1:5173` | cors middleware | Comma-separated. **Both spellings of loopback are listed on purpose:** `localhost` and `127.0.0.1` are different origins to a browser, and Playwright drives one while the dev server prints the other. Listing only one makes every E2E request fail preflight |
| `ALLOW_SEED` | no | unset | `prisma/seed.ts` | `true` permits seeding even under `NODE_ENV=production`. The guard is this variable, not `NODE_ENV`, so the Docker image can ship demo data while still running a production build |
| `SEED_ON_START` | no | `false` | container entrypoint | Seeds after `migrate deploy`, but only when the ticket table is empty |
| `LOG_LEVEL` | no | `info` | logger | `debug` \| `info` \| `warn` \| `error` |
| `DOCS_ENABLED` | no | `true` | `/docs` route | Set `false` to hide Swagger UI |
| `BODY_LIMIT` | no | `1mb` | json parser | Over-limit bodies become `PAYLOAD_TOO_LARGE` |

## `apps/web`

Vite only exposes variables prefixed `VITE_` to client code. Anything else is silently undefined in the browser — a very quiet failure mode.

| Variable | Required | Default | Read by | Purpose |
| -------- | -------- | ------- | ------- | ------- |
| `VITE_API_BASE_URL` | yes | `http://localhost:4000/api/v1` | `src/api/http.ts` | API root. In Docker this is the browser-reachable URL, **not** the compose service name — the request is made by the user's browser, not by the container |

## Tests

| Variable | Set by | Purpose |
| -------- | ------ | ------- |
| `DATABASE_URL` | `apps/api/vitest.setup.ts` (a `setupFiles` entry, which runs **before** test modules import `lib/prisma.ts`) | Points each vitest worker at its own temp file; never the dev DB |
| `PLAYWRIGHT_BASE_URL` | `playwright.config.ts` | `http://localhost:5173` — the same spelling the dev server and `ALLOWED_ORIGINS` use |
| `ALLOW_SEED` | `playwright.config.ts` globalSetup | Lets the E2E database be seeded |

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
