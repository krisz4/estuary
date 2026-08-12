# syntax=docker/dockerfile:1
#
# Helpdesk API image — Node 24 + Express 5 + Prisma (SQLite).
#
# **Node 24, not 20**, and that is forced rather than chosen: the repo pins
# `pnpm@11.1.2` via `packageManager`, and pnpm 11 imports `node:sqlite`, which
# does not exist before Node 22.5 — on `node:20-alpine` every install dies with
# `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` before resolving a single package.
# 24 is the active LTS and satisfies the root `engines` (`>=20.11.0`).
#
# Build from the **repo root**: the image needs `pnpm-workspace.yaml`, the
# lockfile, and `packages/contracts`, none of which are reachable from
# `apps/api/`.
#
#     docker build -f apps/api/Dockerfile -t helpdesk-api .
#
# Four stages: base → deps → build → runtime. Only `runtime` ships.
#
# Layer order is deliberate. Manifests are copied before source in every stage
# that installs, so editing a route does not re-resolve the dependency graph.

# ------------------------------------------------------------------ #
# base — the toolchain every stage shares
# ------------------------------------------------------------------ #
FROM node:24-alpine AS base

# Prisma's engines are dynamically linked against OpenSSL on Alpine. Without it
# the client fails to initialize at the *first query* with an engine error that
# names neither OpenSSL nor this line — so it is installed in every stage that
# runs Prisma, including runtime.
RUN apk add --no-cache openssl

# `packageManager` in the root package.json pins the exact pnpm version; corepack
# honours it, so the container and the developer resolve the same lockfile.
RUN corepack enable

WORKDIR /app
ENV CI=1

# ------------------------------------------------------------------ #
# deps — full install (dev included) for the API and what it depends on
# ------------------------------------------------------------------ #
FROM base AS deps

# `--filter "@helpdesk/api..."` includes @helpdesk/api and its workspace
# dependencies (contracts, tsconfig) and skips apps/web entirely — the web image
# builds in its own Dockerfile, and React + Vite + Playwright-adjacent devDeps
# are a large fraction of the tree (P35: 625 MB / 590 packages installed whole).
#
# Every workspace package.json is copied even though only three are installed:
# pnpm reads the whole workspace to validate the lockfile, and a missing importer
# turns `--frozen-lockfile` into an error about the lockfile rather than about
# the missing file.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/contracts/package.json packages/contracts/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/

# `apps/api`'s postinstall is `prisma generate`, which reads the schema. Copying
# `prisma/` before the install is what makes the generated client part of this
# cached layer instead of a step someone has to remember.
COPY apps/api/prisma apps/api/prisma

RUN pnpm install --frozen-lockfile --filter "@helpdesk/api..."

# ------------------------------------------------------------------ #
# build — compile contracts, then the API
# ------------------------------------------------------------------ #
FROM deps AS build

COPY packages/tsconfig packages/tsconfig
COPY packages/contracts packages/contracts
COPY apps/api apps/api

# `^build` ordering by hand: the API's tsconfig resolves @helpdesk/contracts
# through its `types` entry, which does not exist until contracts is built.
RUN pnpm --filter @helpdesk/contracts build \
 && pnpm --filter @helpdesk/api build

# P37: a failed build can leave a plausible-looking `dist/` behind, so the
# presence of the directory proves nothing. `RUN` already fails the image on a
# non-zero exit; this asserts the two entrypoints the runtime stage actually
# invokes are present, which is the failure a bad `rootDir` would produce
# *without* a non-zero exit — `dist/seed/index.js` is the one that vanishes if
# the seed is ever moved back under `prisma/`.
RUN test -s apps/api/dist/server.js \
 && test -s apps/api/dist/seed/index.js \
 && test -s packages/contracts/dist/index.js

# ------------------------------------------------------------------ #
# runtime — production install + compiled output
# ------------------------------------------------------------------ #
FROM base AS runtime

ENV NODE_ENV=production

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/contracts/package.json packages/contracts/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY apps/api/prisma apps/api/prisma

# `--prod` drops tsx, vitest, supertest and the type packages (P11). It keeps
# `prisma` (the CLI), which is a production dependency **on purpose**: the
# entrypoint runs `prisma migrate deploy` and `prisma migrate diff`, and an image
# carrying only `@prisma/client` cannot start on a clean volume at all. That is a
# deliberate reversal of P1's "keep prisma and @prisma/engines out of the runtime
# layer": P1 predates the entrypoint needing the CLI, and the weight is not a
# cost this image can trade away. See docs/operations/DOCKER.md § Image notes.
#
# The install also re-runs `prisma generate`, so the client in this image is
# generated against the schema in this image rather than copied from a stage
# that might have had a different one.
RUN pnpm install --frozen-lockfile --prod --filter "@helpdesk/api..." \
 && pnpm store prune

COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/apps/api/dist apps/api/dist

COPY apps/api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# The database lives on a named volume mounted here. Creating the directory in
# the image and chowning it is load-bearing: Docker initialises a *new* named
# volume from the image's directory, ownership included, so without this the
# mount lands root-owned and SQLite cannot create the `-wal`/`-shm` siblings —
# every write fails with SQLITE_READONLY while reads keep working, which reads
# as a much stranger bug than a permission error.
# Only /data is chowned. A `chown -R … /app` would rewrite every file in the
# tree and so duplicate the entire node_modules layer in the image — measured at
# +160 MB for nothing, since the runtime user only ever *reads* /app.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
WORKDIR /app/apps/api

EXPOSE 4000

# Healthcheck lives in compose so it can be tuned without a rebuild, but is
# repeated here so `docker run` (no compose) reports health too. `/health` sits
# outside /api/v1 and touches no database — it answers "is the process up".
HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=10 \
  CMD wget -qO- http://127.0.0.1:4000/health || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
