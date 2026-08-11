# Docker

Bonus item 3 of the brief. Target: a reviewer clones the repo and runs one command.

```bash
docker compose up --build
```

→ web at `http://localhost:5173`, API at `http://localhost:4000`, Swagger UI at `http://localhost:4000/docs`, database migrated and seeded.

## Files

| File | Purpose |
| ---- | ------- |
| `apps/api/Dockerfile` | Multi-stage: deps → build → runtime |
| `apps/web/Dockerfile` | Multi-stage: deps → build (Vite) → nginx serving static files |
| `apps/web/nginx.conf` | SPA fallback (`try_files … /index.html`) |
| `docker-compose.yml` | Both services, the volume, healthchecks |
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
      ALLOWED_ORIGINS: http://localhost:5173,http://127.0.0.1:5173
      NODE_ENV: production
      SEED_ON_START: "true"      # demo data; see "Seeding" below
    volumes: ["helpdesk-db:/data"]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:4000/health"]
      interval: 5s
      retries: 10

  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
      args:
        VITE_API_BASE_URL: http://localhost:4000/api/v1
    ports: ["5173:80"]
    depends_on:
      api: { condition: service_healthy }

volumes:
  helpdesk-db:
```

## Things that bite

**`VITE_API_BASE_URL` is a build arg, not a runtime env var.** Vite inlines it at build time. Setting it under `environment:` does nothing — the built bundle already contains whatever was baked in.

**It must be `http://localhost:4000`, not `http://api:4000`.** The request is made by the *browser*, which resolves nothing on the compose network. `api` as a hostname is only valid for container-to-container calls, and there are none here.

**Build context is the repo root**, not the app folder — the Dockerfiles need `packages/contracts` and the workspace lockfile. Hence `context: .` with an explicit `dockerfile:` path.

**Migrations run at container start**, not at build: the entrypoint runs `prisma migrate deploy` then starts the server. Building them in would bake a database into the image layer, which the volume then shadows.

**The SQLite file lives on the volume at `/data`**, not inside the image. Without the volume every `docker compose up` starts empty; with it, data survives `down`. Reset with `docker compose down -v`.

## Seeding

The seed guard keys off **`SEED_ON_START` / `ALLOW_SEED`, not `NODE_ENV`.**

That distinction is the whole point: the container runs `NODE_ENV=production` (it serves a production build), but a reviewer opening an empty ticket list has been handed a broken-looking app. Gating the seed on `NODE_ENV` would have made the advertised "up and seeded" impossible, and the documented escape hatch impossible too.

So:

- The entrypoint runs `prisma migrate deploy`, then runs the seed **only if `SEED_ON_START=true` and the ticket table is empty**. Restarting the stack never wipes data you added.
- `pnpm --filter @helpdesk/api db:seed` refuses unless `ALLOW_SEED=true` or `NODE_ENV !== "production"`, so it cannot be pointed at a real database by accident.
- Nothing in the container calls `db:reset`. That script prompts, has no `--force`, and exists for a human at a terminal — the container path is `migrate deploy` plus the guarded seed.

Reseed from scratch:

```bash
docker compose down -v && docker compose up          # cleanest
docker compose exec -e ALLOW_SEED=true api node dist/seed/index.js    # in place, wipes tickets
```

## Image notes

- Base `node:20-alpine`. Prisma needs `openssl` on Alpine — install it in the runtime stage or the client fails to initialize with an unhelpful engine error.
- `pnpm` via `corepack enable`.
- Runtime stage copies `dist/` (including the **compiled** `dist/seed/index.js`), production `node_modules`, `prisma/` (schema + migrations), and `package.json`.
- The seed source lives at `apps/api/src/seed/`, not `apps/api/prisma/`, precisely so it lands in `dist/`: `tsconfig.build.json` has `rootDir: "src"` and will not compile a file outside it. `prisma/` holds the schema and migrations only.
- **`prisma` (the CLI) must be a production dependency**, not a devDependency. The entrypoint runs `prisma migrate deploy`; a runtime image with only `@prisma/client` fails to start on a clean volume. The seed is compiled during the build stage for the same reason — `tsx` is not present at runtime.
- Runs as a non-root user; the `/data` volume mount is chowned to it, otherwise SQLite cannot create the `-wal` file and every write fails with `SQLITE_READONLY`.
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
