# Docker

Bonus item 3 of the brief. Target: a reviewer clones the repo and runs one command.

```bash
docker compose up --build
```

→ web at `http://localhost:5173`, API at `http://localhost:4000`, Swagger UI at `http://localhost:4000/docs` (also proxied at `http://localhost:5173/docs`), database migrated and seeded.

## Files

| File | Purpose |
| ---- | ------- |
| `apps/api/Dockerfile` | Multi-stage: base → deps → build → runtime |
| `apps/api/docker-entrypoint.sh` | `migrate deploy` → drift check → guarded seed → `exec` the server |
| `apps/web/Dockerfile` | Multi-stage: deps → build (Vite) → nginx serving static files |
| `apps/web/nginx.conf` | SPA fallback **and** the same-origin reverse proxy for `/api/`, `/docs`, `/health` |
| `docker-compose.yml` | Both services, the named volume, healthchecks |
| `.dockerignore` | Excludes `node_modules`, `dist`, `.git`, `*.db`, `.env` |

## Compose shape

```yaml
services:
  api:
    build: { context: ., dockerfile: apps/api/Dockerfile }
    ports: ["4000:4000"]
    environment:
      DATABASE_URL: file:/data/helpdesk.db
      HOST: 0.0.0.0
      ALLOWED_ORIGINS: http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173
      NODE_ENV: production
      SEED_ON_START: "true"      # demo data; see "Seeding" below
    volumes: ["helpdesk-db:/data"]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:4000/health"]
      interval: 5s
      retries: 10
      start_period: 30s          # migrate + seed run before the port is bound

  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
      args:
        VITE_API_BASE_URL: /api/v1     # relative — nginx proxies it. See below.
    ports: ["5173:80"]
    depends_on:
      api: { condition: service_healthy }

volumes:
  helpdesk-db:
```

## The API is reached through nginx, on one origin

The web container serves the SPA **and** reverse-proxies `/api/`, `/docs`, and `/health` to the `api` service. So the browser loads the app from `http://localhost:5173` and calls `http://localhost:5173/api/v1/...` — one origin.

Two consequences, both of them the reason for the design:

- **No CORS preflight on any request.** P41 measured one extra round trip per write against the cross-origin dev setup; same-origin removes all of them. The API's `ALLOWED_ORIGINS` is not on the container's request path at all.
- **`VITE_API_BASE_URL` is `/api/v1`, a relative path** — not `http://localhost:4000/api/v1`. An absolute URL still works (compose publishes 4000) but reintroduces the preflights.

Port 4000 stays published for `curl` and for Swagger UI's "try it out", which *is* cross-origin — that, plus a web image someone rebuilds with an absolute base URL, is why `ALLOWED_ORIGINS` is still set.

nginx resolves `api` through Docker's embedded DNS **per request** (`resolver 127.0.0.11` + a `$upstream` variable), not once at startup. With a literal hostname in `proxy_pass`, nginx caches the resolution forever and an API container that restarts with a new IP is unreachable until nginx restarts too.

## Things that bite

**`VITE_API_BASE_URL` is a build arg, not a runtime env var.** Vite inlines it at build time. Setting it under `environment:` does nothing — the built bundle already contains whatever was baked in. Re-pointing the app at a different API means rebuilding the web image.

**It must never be `http://api:4000`.** `api` is a compose network alias. The request is made by the *browser*, which resolves nothing on the compose network. A service name is correct in exactly one place here: inside `nginx.conf`, where the caller is nginx.

**Build context is the repo root**, not the app folder — the Dockerfiles need `packages/contracts` and the workspace lockfile. Hence `context: .` with an explicit `dockerfile:` path.

**Migrations run at container start**, not at build: the entrypoint runs `prisma migrate deploy` then starts the server. Building them in would bake a database into the image layer, which the volume then shadows.

**The SQLite file lives on the volume at `/data`**, not inside the image. `DATABASE_URL` is the **absolute** `file:/data/helpdesk.db` — a relative `file:./…` resolves from `prisma/` inside the image and lands on a layer the volume then shadows. Without the volume every `docker compose up` starts empty; with it, data survives `down`. Reset with `docker compose down -v`.

**`HOST=0.0.0.0` is required in the container.** The default `127.0.0.1` binds the loopback interface *inside* the network namespace, and the published port connects to nothing.

## The entrypoint checks for schema drift, and refuses to start on it

`migrate deploy` only replays the migration *files*. It cannot tell that `schema.prisma` grew a column nobody wrote a migration for: it reports "all migrations have been successfully applied", and the container comes up **healthy**, because `/health` touches no database.

Measured, with a nullable column added to `model Ticket` and no migration: a clean-volume start migrated, seeded 63 tickets (the seed never writes the new column), then answered every read with a 500 — `The column main.Ticket.slaBreachedAt does not exist in the current database`. Healthy container, dead app.

So the entrypoint runs `prisma migrate diff --from-schema-datasource --to-schema-datamodel --exit-code` after deploying. Exit 2 means the live database and the datamodel disagree; the container prints the difference, names the `db:migrate` command, and exits 1 rather than serving.

This is what makes the clean-volume start in the gate worth running — it is the check that catches a schema change that shipped without its migration, which is checklist rule #2 in [../../CLAUDE.md](../../CLAUDE.md).

## Seeding

The seed guard keys off **`SEED_ON_START` / `ALLOW_SEED`, not `NODE_ENV`.**

That distinction is the whole point: the container runs `NODE_ENV=production` (it serves a production build), but a reviewer opening an empty ticket list has been handed a broken-looking app. Gating the seed on `NODE_ENV` would have made the advertised "up and seeded" impossible, and the documented escape hatch impossible too.

So:

- The entrypoint runs `prisma migrate deploy`, then runs the seed **only if `SEED_ON_START` is truthy and the ticket table is empty**. Restarting the stack never wipes data you added. The count is taken through `@prisma/client` (`node -e`), because the sqlite3 CLI is not in the image and `prisma db execute` cannot return a value; a failed count aborts the container rather than being read as "empty".
- `SEED_ON_START` accepts `true` / `1` / `yes` / `on`, the same four spellings `src/lib/env.ts` accepts. The shell has to agree with the parser, or `SEED_ON_START=1` would seed the app but not the API.
- `pnpm --filter @helpdesk/api db:seed` refuses unless `ALLOW_SEED=true` or `NODE_ENV !== "production"`, so it cannot be pointed at a real database by accident.
- Nothing in the container calls `db:reset`. That script prompts, has no `--force`, and drops the database before `ALLOW_SEED` is ever consulted — it exists for a human at a terminal. The container path is `migrate deploy` plus the guarded seed.

Reseed from scratch:

```bash
docker compose down -v && docker compose up          # cleanest
docker compose exec -e ALLOW_SEED=true api node dist/seed/index.js    # in place, wipes tickets
```

## Image notes

- Base **`node:24-alpine`, not 20**, and that is forced rather than chosen: the repo pins `pnpm@11.1.2` via `packageManager`, and pnpm 11 imports `node:sqlite`, which does not exist before Node 22.5 — on `node:20-alpine` every install dies with `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` before resolving a single package. 24 is the active LTS and satisfies the root `engines` (`>=20.11.0`).
- Prisma needs `openssl` on Alpine — its engines are dynamically linked against it. Install it in every stage that runs Prisma, **including runtime**, or the client fails to initialize at the *first query* with an engine error that names neither OpenSSL nor the missing package.
- `pnpm` via `corepack enable`, so the container resolves the same lockfile the developer does.
- Each image installs only its own half of the workspace: `--filter "@helpdesk/api..."` skips `apps/web`, and `--filter "@helpdesk/web..."` skips `apps/api` and therefore Prisma, which is ~57% of the tree (P1). Every workspace `package.json` is still copied in first — pnpm reads the whole workspace to validate the lockfile, and a missing importer turns `--frozen-lockfile` into an error about the lockfile rather than about the missing file.
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

## Not included

No production orchestration, no reverse proxy with TLS, no multi-replica setup. SQLite on a single volume is a single-writer, single-node design — appropriate for this challenge, and the first thing to replace if the app were real.

## Related

- [../engineering/ENVIRONMENT_VARIABLES.md](../engineering/ENVIRONMENT_VARIABLES.md)
- [../engineering/DATABASE.md](../engineering/DATABASE.md)
