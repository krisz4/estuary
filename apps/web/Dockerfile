# syntax=docker/dockerfile:1
#
# Helpdesk web image — Vite build served by nginx. No Node at runtime.
#
# Build from the **repo root** (needs the workspace lockfile and
# `packages/contracts`):
#
#     docker build -f apps/web/Dockerfile -t helpdesk-web .

# ------------------------------------------------------------------ #
# deps
# ------------------------------------------------------------------ #
FROM node:24-alpine AS deps

RUN corepack enable
WORKDIR /app
ENV CI=1

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# `@helpdesk/web...` pulls in contracts and tsconfig and skips apps/api — which
# also means Prisma never installs here, and Prisma is ~57% of the tree (P1).
RUN pnpm install --frozen-lockfile --filter "@helpdesk/web..."

# ------------------------------------------------------------------ #
# build
# ------------------------------------------------------------------ #
FROM deps AS build

# The API root, inlined into the bundle by Vite at build time. It is **not**
# readable from the container's environment afterwards: re-pointing the app at a
# different API means rebuilding this image.
#
# The default is a *relative* path on purpose. nginx (see nginx.conf) proxies
# /api/ to the API service, so the browser talks to the origin it loaded the app
# from and no request is cross-origin. An absolute
# `http://localhost:4000/api/v1` also works — compose publishes that port — but
# it reintroduces a CORS preflight on every write.
#
# It must never be `http://api:4000/...`: `api` is a compose network alias, and
# the request is issued by the user's browser, which cannot resolve it.
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

COPY packages/tsconfig packages/tsconfig
COPY packages/contracts packages/contracts
COPY apps/web apps/web

RUN pnpm --filter @helpdesk/contracts build \
 && pnpm --filter @helpdesk/web build

# P37: with `packages/contracts/dist` missing, `vite build` exits 1 **after**
# writing a dist/ that looks complete and is ~70 kB short. `RUN` fails the image
# on the non-zero exit — this only asserts the entry document exists, so a
# silently truncated output cannot ship as a 200 that renders nothing.
RUN test -s apps/web/dist/index.html

# ------------------------------------------------------------------ #
# runtime — static files only
# ------------------------------------------------------------------ #
FROM nginx:1.29-alpine AS runtime

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1/index.html >/dev/null || exit 1
