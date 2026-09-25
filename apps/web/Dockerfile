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
# Pinned to a minor, not the floating `24-alpine`. The root `engines` floor is
# `^22.18.0 || >=24.11.0` and pnpm refuses to install a project whose engines the
# running node does not satisfy, so a tag that ever resolves below 24.11 turns
# into an install error that names neither the tag nor this line.
FROM node:24.11-alpine AS deps

RUN corepack enable
WORKDIR /app
ENV CI=1

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/mcp/package.json apps/mcp/

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

# No source maps in the image. `vite.config.ts` builds them by default so a
# stack trace from `pnpm build` or `vite preview` is readable locally, but the
# runtime stage copies `dist/` wholesale into nginx and serves it publicly under
# /assets/ with a one-year cache — which would publish the entire TypeScript
# source of the app and roughly double the asset bytes in the image.
ENV WEB_SOURCEMAP=false

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
