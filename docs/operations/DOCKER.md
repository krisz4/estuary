# Docker

There are two ways to run Estuary in Docker:

- **From source:** the repo-root `docker-compose.yml` builds both images and seeds 62 demo tasks. That's the rest of this page.
- **From the published images:** [`deploy/docker-compose.yml`](../../deploy/docker-compose.yml) pulls `ghcr.io/krisz4/estuary-api` and `estuary-web` (built for amd64 and arm64 on each release, see [RELEASING.md](./RELEASING.md)). Nothing to clone or build, and it starts empty with Swagger UI off. Pin a version with `ESTUARY_VERSION=0.1.0`, and read [Self-hosting](#self-hosting-agents-against-this-stack) before exposing it.

  ```bash
  curl -fsSLO https://raw.githubusercontent.com/krisz4/estuary/main/deploy/docker-compose.yml
  API_TOKEN="$(openssl rand -hex 32)" docker compose up -d   # → http://localhost:5173
  ```

The from-source target (originally bonus item 3 of the code-challenge brief) is a reviewer cloning the repo and running one command.

```bash
docker compose up --build
```

→ web at `http://localhost:5173`, API at `http://localhost:4000`, Swagger UI at `http://localhost:4000/docs` (also proxied at `http://localhost:5173/docs`), database migrated and seeded.

## Files

| File | Purpose |
| ---- | ------- |
| `apps/api/Dockerfile` | Multi-stage: base → deps → build → runtime. Copies every workspace `package.json`, including `apps/mcp/package.json`, so `pnpm install` can validate the lockfile even though `apps/mcp` itself is not installed or shipped in this image |
| `apps/api/docker-entrypoint.sh` | `migrate deploy` → drift check → guarded seed → `exec` the server |
| `apps/web/Dockerfile` | Multi-stage: deps → build (Vite) → nginx serving static files. Also copies `apps/mcp/package.json` for the same lockfile-validation reason |
| `apps/web/nginx.conf` | SPA fallback **and** the same-origin reverse proxy for `/api/`, `/docs`, `/health` |
| `docker-compose.yml` | Both services, the named volume, healthchecks |
| `.dockerignore` | Excludes `node_modules`, `dist`, `.git`, `*.db`, `.env` |

## Compose shape

```yaml
services:
  api:
    build: { context: ., dockerfile: apps/api/Dockerfile }
    ports: ["127.0.0.1:4000:4000"]   # loopback only — see "Both ports are bound to loopback"
    environment:
      DATABASE_URL: file:/data/estuary.db
      HOST: 0.0.0.0
      ALLOWED_ORIGINS: http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173
      NODE_ENV: production
      SEED_ON_START: "true"      # demo data; see "Seeding" below
      # Passed through from the shell, empty by default. See "Self-hosting agents" below.
      API_TOKEN: ${API_TOKEN:-}
      AGENTS_MAY_COMPLETE: ${AGENTS_MAY_COMPLETE:-}
      CLAIM_LEASE_MINUTES: ${CLAIM_LEASE_MINUTES:-}
      DONE_RETENTION_DAYS: ${DONE_RETENTION_DAYS:-}
    volumes: ["estuary-db:/data"]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:4000/health"]
      interval: 5s
      retries: 10
      start_period: 30s          # migrate + seed run before the port is bound
    stop_grace_period: 15s       # the server's own 10s force-exit timer fits inside it

  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
      args:
        VITE_API_BASE_URL: /api/v1     # relative — nginx proxies it. See below.
    ports: ["127.0.0.1:5173:80"]
    depends_on:
      api: { condition: service_healthy }

volumes:
  estuary-db:
```

## The API is reached through nginx, on one origin

The web container serves the SPA **and** reverse-proxies `/api/`, `/docs`, and `/health` to the `api` service. So the browser loads the app from `http://localhost:5173` and calls `http://localhost:5173/api/v1/...` — one origin.

Two consequences, both of them the reason for the design:

- **No CORS preflight on any request.** P41 measured one extra round trip per write against the cross-origin dev setup; same-origin removes all of them. The API's `ALLOWED_ORIGINS` is not on the container's request path at all.
- **`VITE_API_BASE_URL` is `/api/v1`, a relative path** — not `http://localhost:4000/api/v1`. An absolute URL still works (compose publishes 4000) but reintroduces the preflights.

Port 4000 stays published for `curl` and for using Swagger UI directly. Note that Swagger UI is **not** a CORS case: the OpenAPI document declares `servers: [{ url: "/" }]`, so "try it out" resolves against whichever origin served `/docs` — same-origin on `:4000` and same-origin through the proxy on `:5173`. `ALLOWED_ORIGINS` is set for `vite preview` on `:4173` and for a web image someone rebuilds with an absolute base URL, and for nothing in this stack.

nginx resolves `api` through Docker's embedded DNS **per request** (`resolver 127.0.0.11` + a `$upstream` variable), not once at startup. With a literal hostname in `proxy_pass`, nginx caches the resolution forever and an API container that restarts with a new IP is unreachable until nginx restarts too.

### The rest of `nginx.conf`, and the two traps in it

- **`gzip_types` must list `text/javascript`.** nginx has mapped `.js` to `text/javascript` in its `mime.types` since 1.21.3, so a config listing only the older `application/javascript` compresses the CSS and quietly ships the JS bundle — the largest asset in the build — raw. Both spellings are listed now, so the config does not depend on which `mime.types` the base image carries.
- **`add_header` does not merge across levels.** A location that declares an `add_header` of its own inherits *none* of the server-level ones. Two locations do (`/assets/` for its immutable `Cache-Control`, `= /index.html` for `no-cache`), and both repeat the three security headers for exactly that reason — the duplication is the nginx rule, not an oversight. `expires` is a different directive and does not trigger it, which is why the proxied locations need no copy.
- `server_tokens off` and `X-Content-Type-Options` / `Referrer-Policy` / `X-Frame-Options`. The API disables `x-powered-by` deliberately; leaking the nginx version in front of it would give the same information back. **No CSP** — Tailwind v4 injects styles and Swagger UI runs its own bundle, so a policy written without a browser in front of it is a white screen with a console error (D24).
- `/assets/` carries one `Cache-Control`, written out in full rather than `expires 1y` plus an `add_header`, which emitted two of the header on every asset response.
- Swagger UI is proxied by `location = /docs` plus `location ^~ /docs/`. A bare `location /docs` is a prefix match and would also proxy `/docsomething`.
- `try_files … /index.html` is an internal *redirect*, so it re-enters location matching and the `= /index.html` no-cache header does apply to SPA routes. `/assets/` ends in `=404` so a missing bundle is not answered with HTML, which would surface as a JS syntax error instead of a missing file.

## Things that bite

**`VITE_API_BASE_URL` is a build arg, not a runtime env var.** Vite inlines it at build time. Setting it under `environment:` does nothing — the built bundle already contains whatever was baked in. Re-pointing the app at a different API means rebuilding the web image.

**It must never be `http://api:4000`.** `api` is a compose network alias. The request is made by the *browser*, which resolves nothing on the compose network. A service name is correct in exactly one place here: inside `nginx.conf`, where the caller is nginx.

**Build context is the repo root**, not the app folder — the Dockerfiles need `packages/contracts` and the workspace lockfile. Hence `context: .` with an explicit `dockerfile:` path.

**Migrations run at container start**, not at build: the entrypoint runs `prisma migrate deploy` then starts the server. Building them in would bake a database into the image layer, which the volume then shadows.

**The SQLite file lives on the volume at `/data`**, not inside the image. `DATABASE_URL` is the **absolute** `file:/data/estuary.db` — a relative `file:./…` resolves from `prisma/` inside the image and lands on a layer the volume then shadows. Without the volume every `docker compose up` starts empty; with it, data survives `down`. Reset with `docker compose down -v`.

**`HOST=0.0.0.0` is required in the container.** The default `127.0.0.1` binds the loopback interface *inside* the network namespace, and the published port connects to nothing.

**Both ports are bound to loopback on the host** — `127.0.0.1:5173:80` and `127.0.0.1:4000:4000`, not the bare `5173:80` / `4000:4000` that publishes on every interface. This app has no authentication by design, which is the same reason `apps/api/env.example` ships `HOST=127.0.0.1` for local development: on a shared network, an all-interfaces publish hands full task CRUD, `DELETE` included, to anyone who can reach the machine. Note that the two settings are independent — `HOST` controls the bind *inside* the container's namespace and still has to be `0.0.0.0`; the `127.0.0.1:` prefix is what constrains the *host* side. Every documented use is local: the browser, `curl`, Swagger UI. Reaching the stack from a phone or another laptop means dropping the prefix knowingly.

**nginx is a second place a limit is enforced, and `client_max_body_size` has to stay above `BODY_LIMIT`.** nginx's default is exactly `1m` — the same threshold as the API's `BODY_LIMIT=1mb` — so an over-limit body was refused by the proxy as an HTML 413 and never reached Express. That silently voided the error contract on the only path the app uses: `src/app.ts` mounts `cors` before the JSON parser specifically so `PAYLOAD_TOO_LARGE` arrives readable, with a `code` and an `x-request-id`, and a long task description is the realistic way a user gets there. `location /api/` now sets `client_max_body_size 2m`, deliberately above the API's limit so the API is the component that refuses. **Raise both together.**

## The entrypoint checks for schema drift, and refuses to start on it

`migrate deploy` only replays the migration *files*. It cannot tell that `schema.prisma` grew a column nobody wrote a migration for: it reports "all migrations have been successfully applied", and the container comes up **healthy**, because `/health` touches no database.

Measured, with a nullable column added to `model Task` and no migration: a clean-volume start migrated, seeded (the seed never writes the new column), then answered every read with a 500 — `The column main.Task.slaBreachedAt does not exist in the current database`. Healthy container, dead app.

So the entrypoint runs `prisma migrate diff --from-schema-datasource --to-schema-datamodel --exit-code` after deploying. Exit 2 means the live database and the datamodel disagree; the container prints the difference, names the `db:migrate` command, and exits 1 rather than serving.

This is what makes the clean-volume start in the gate worth running — it is the check that catches a schema change that shipped without its migration, which is checklist rule #2 in [../../CLAUDE.md](../../CLAUDE.md).

## Seeding

The seed guard keys off **`SEED_ON_START` / `ALLOW_SEED`, not `NODE_ENV`.**

That distinction is the whole point: the container runs `NODE_ENV=production` (it serves a production build), but a reviewer opening an empty task list has been handed a broken-looking app. Gating the seed on `NODE_ENV` would have made the advertised "up and seeded" impossible, and the documented escape hatch impossible too.

So:

- The entrypoint runs `prisma migrate deploy`, then runs the seed **only if `SEED_ON_START` is truthy and the task table is empty**. Restarting the stack never wipes data you added. The count is taken through `@prisma/client` (`node -e`), because the sqlite3 CLI is not in the image and `prisma db execute` cannot return a value; a failed count aborts the container rather than being read as "empty".
- `SEED_ON_START` accepts `true` / `1` / `yes` / `on`, the same four spellings `src/lib/env.ts` accepts. The shell has to agree with the parser, or `SEED_ON_START=1` would seed the app but not the API.
- `pnpm --filter @estuary/api db:seed` refuses unless `ALLOW_SEED=true` or `NODE_ENV !== "production"`, so it cannot be pointed at a real database by accident.
- Nothing in the container calls `db:reset`. That script prompts, has no `--force`, and drops the database before `ALLOW_SEED` is ever consulted — it exists for a human at a terminal. The container path is `migrate deploy` plus the guarded seed.

Reseed from scratch:

```bash
docker compose down -v && docker compose up          # cleanest
docker compose exec -e ALLOW_SEED=true api node dist/seed/index.js    # in place, wipes tasks
```

## Image notes

- Base **`node:24.11-alpine`, not 20**, and that is forced rather than chosen: the repo pins `pnpm@11.1.2` via `packageManager`, and pnpm 11 imports `node:sqlite`, which does not exist before Node 22.5 — on `node:20-alpine` every install dies with `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` before resolving a single package. 24 is the active LTS and satisfies the root `engines` (`^22.18.0 || >=24.11.0`, whose upper floor is `@babel/core` 8 in the web build — see CI.md).
- Prisma needs `openssl` on Alpine — its engines are dynamically linked against it. Install it in every stage that runs Prisma, **including runtime**, or the client fails to initialize at the *first query* with an engine error that names neither OpenSSL nor the missing package.
- **The tag is pinned to a minor**, not left as the floating `24-alpine`. pnpm refuses to install a project whose `engines` the running node does not satisfy, and the floor here is `>=24.11.0` — a tag that ever resolves below it fails the install with a message naming neither the tag nor the `FROM` line.
- `pnpm` via `corepack enable`, so the container resolves the same lockfile the developer does. The `ENV CI=1` above it also keeps corepack from prompting before it downloads the pinned pnpm.
- **`CHECKPOINT_DISABLE=1` in the runtime stage.** The Prisma CLI otherwise pings `checkpoint-api.prisma.io` for a version check on each of the entrypoint's two `migrate` invocations. It has a timeout, so an offline host degrades rather than fails — but this is a local-first SQLite app and there is no reason for an outbound HTTPS round trip to sit on the critical path of every start.
- **The web image ships no source maps.** `vite.config.ts` builds them by default, because that is what makes a stack trace from `pnpm build` or `vite preview` readable; the Dockerfile sets `WEB_SOURCEMAP=false`, because the runtime stage copies `dist/` into nginx and serves it publicly under `/assets/` with a one-year cache, so every `.map` would publish the app's original TypeScript and roughly double the asset bytes in the image.
- Each image installs only its own half of the workspace: `--filter "@estuary/api..."` skips `apps/web`, and `--filter "@estuary/web..."` skips `apps/api` and therefore Prisma, which is ~57% of the tree (P1). Every workspace `package.json` is still copied in first — pnpm reads the whole workspace to validate the lockfile, and a missing importer turns `--frozen-lockfile` into an error about the lockfile rather than about the missing file.
- Runtime stage copies `dist/` (including the **compiled** `dist/seed/index.js`), production `node_modules`, `prisma/` (schema + migrations), and `package.json`.
- The seed source lives at `apps/api/src/seed/`, not `apps/api/prisma/`, precisely so it lands in `dist/`: `tsconfig.build.json` has `rootDir: "src"` and will not compile a file outside it. `prisma/` holds the schema and migrations only.
- **`prisma` (the CLI) must be a production dependency**, not a devDependency. The entrypoint runs `prisma migrate deploy` and `prisma migrate diff`; a runtime image with only `@prisma/client` cannot start on a clean volume at all. This is a deliberate reversal of P1's "keep `prisma` and `@prisma/engines` out of the runtime layer" — that recommendation predates the entrypoint needing the CLI, and it is not a cost the image can trade away. The seed is compiled during the build stage for the same reason: `tsx` is not present at runtime.
- Both builds **assert their output after the build step** (`test -s dist/server.js`, `test -s apps/web/dist/index.html`, …). `RUN` already fails the image on a non-zero exit; the assertions cover P37, where a failed `vite build` leaves a plausible-looking, ~70 kB short `dist/` behind. `dist/seed/index.js` is the one that vanishes if the seed is ever moved back under `prisma/`.
- Runs as a non-root user. `/data` is created **and chowned in the image**: Docker initialises a new named volume from the image's directory, ownership included, so without it the mount lands root-owned and SQLite cannot create the `-wal`/`-shm` siblings — every write fails with `SQLITE_READONLY` while reads keep working, which reads as a much stranger bug than a permission error. Only `/data` is chowned; a `chown -R /app` would rewrite every file and duplicate the whole `node_modules` layer for nothing, since the runtime user only reads `/app`.
- The entrypoint ends in `exec "$@"`, so SIGTERM reaches node rather than `/bin/sh`. Without it every `docker compose down` takes the full 10 s to SIGKILL.
- Web image is nginx serving static output — no Node at runtime.

## Useful commands

```bash
docker compose up --build            # start everything
docker compose down                  # stop, keep the database
docker compose down -v               # stop and wipe the database
docker compose logs -f api           # follow API logs
docker compose exec api sh           # shell into the API container
```

## Self-hosting agents against this stack

Agents (via `apps/mcp`, see [../features/Agent_Integration.md](../features/Agent_Integration.md)) can point at this stack over a network instead of `localhost`. Two things change from the reviewer-on-one-machine setup above:

- **Set `API_TOKEN` on the `api` service** (`API_TOKEN=<32+ random chars> docker compose up -d`, or in a `.env` beside `docker-compose.yml`). Without it, anyone who can reach the port has full task CRUD — there is no other access control. `AGENTS_MAY_COMPLETE`, `CLAIM_LEASE_MINUTES`, and `DONE_RETENTION_DAYS` (done tasks are deleted after 90 days unless you set it; `0` keeps them) pass through the same way if you want to change their defaults; see [../engineering/ENVIRONMENT_VARIABLES.md](../engineering/ENVIRONMENT_VARIABLES.md).
- **Put it behind HTTPS.** The bearer token travels in a plain `Authorization` header on every request; do not expose `api` (or the proxied port on `web`) to a network you do not control without TLS in front of it (a reverse proxy, a tunnel, or a platform load balancer). This compose file has no TLS termination of its own — see "Not included" below.
- Each agent/machine then gets `TASKS_API_URL=https://<host>/api/v1`, `TASKS_API_TOKEN=<the same API_TOKEN>`, and its own `TASKS_ACTOR` — see [../features/Agent_Integration.md § Self-hosted server](../features/Agent_Integration.md#self-hosted-server).

**The optional GitHub integration** ([../features/GitHub_Integration.md](../features/GitHub_Integration.md)) is passed through the same way: set `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, and/or `GITHUB_API_URL` in the shell or `.env` next to `docker-compose.yml`, exactly like `API_TOKEN` above; left blank, the integration stays off. The webhook additionally needs the API reachable from GitHub's servers, which behind this compose file means TLS and a public hostname or a tunnel, not `localhost`.

## Not included

No production orchestration, no reverse proxy with TLS, no multi-replica setup. SQLite on a single volume is a single-writer, single-node design — appropriate for this project's scale, and the first thing to replace if it needed to serve people who should not trust each other.

## Related

- [../engineering/ENVIRONMENT_VARIABLES.md](../engineering/ENVIRONMENT_VARIABLES.md)
- [../engineering/DATABASE.md](../engineering/DATABASE.md)
