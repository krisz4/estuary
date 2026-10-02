#!/bin/sh
#
# Container entrypoint: migrate, maybe seed, then exec the server.
#
# Runs as PID 1's child until the final `exec`, which replaces this shell with
# node so that SIGTERM reaches the process that installed the handler. Without
# `exec`, `docker compose down` would signal /bin/sh, node would never shut down
# gracefully, and every stop would take the full 10 s until SIGKILL.
#
# Three rules from docs/operations/DOCKER.md and the implementation plan:
#
#   1. `prisma migrate deploy`, never `db push`. `deploy` replays the committed
#      migration files and records them; `db push` diffs the schema straight
#      onto the database, which silently papers over a schema change that
#      shipped without its migration — the exact failure the clean-volume start
#      exists to catch.
#   2. Seed only when SEED_ON_START is truthy **and the task table is empty**.
#      The seed deletes every task and comment first, so an unconditional seed
#      would wipe a reviewer's data on every restart.
#   3. Never `db:reset`. It has no `--force`, prompts, and drops the database
#      before ALLOW_SEED is ever consulted. Its only caller is a human.

set -eu

log() { echo "entrypoint: $*"; }

# The env parser in src/lib/env.ts accepts these four spellings; the shell has
# to agree with it, or SEED_ON_START=1 would seed the app but not the API.
is_true() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    true | 1 | yes | on) return 0 ;;
    *) return 1 ;;
  esac
}

cd /app/apps/api

log "applying migrations (prisma migrate deploy)"
./node_modules/.bin/prisma migrate deploy

# Drift check: is the database the migrations produced actually the database the
# generated client expects?
#
# `migrate deploy` only replays the migration *files*. It cannot tell that
# `schema.prisma` grew a column nobody wrote a migration for — it reports "all
# migrations have been successfully applied" and the container comes up healthy,
# because /health touches no database. **Measured**: with a nullable column
# added to `model Task` and no migration, a clean-volume start migrated, then
# seeded 63 tasks (the seed never writes the new column), then answered every
# read with a 500 — `The column main.Task.slaBreachedAt does not exist in the
# current database`. Healthy container, dead app.
#
# `migrate diff` compares the live database against the datamodel and exits 2
# when they differ, so the drift becomes a refusal to start with the missing
# column named. Exit 0 means in sync; anything else is a real failure.
log "checking the database matches the schema (prisma migrate diff)"
if ./node_modules/.bin/prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --exit-code >/tmp/drift.txt 2>&1; then
  log "schema and database agree"
else
  status=$?
  if [ "$status" -eq 2 ]; then
    log "FATAL: the database does not match prisma/schema.prisma."
    log "A schema change shipped without its migration. Run:"
    log "  pnpm --filter @estuary/api db:migrate --name <descriptive_snake_case>"
    log "and commit the generated SQL. The difference:"
    sed 's/^/  /' /tmp/drift.txt
  else
    log "FATAL: could not compare the schema against the database (exit $status)"
    sed 's/^/  /' /tmp/drift.txt
  fi
  exit 1
fi

if is_true "${SEED_ON_START:-false}"; then
  # Counted through @prisma/client rather than the sqlite3 CLI, which is not in
  # the image, and rather than `prisma db execute`, which cannot return a value.
  # A failure here must not be read as "empty" — `set -e` aborts the container
  # instead, because seeding a database whose state is unknown is destructive.
  task_count=$(
    node -e '
      const { PrismaClient } = require("@prisma/client");
      const prisma = new PrismaClient();
      prisma.task
        .count()
        .then((n) => { process.stdout.write(String(n)); })
        .catch((err) => { console.error(err); process.exit(1); })
        .finally(() => prisma.$disconnect());
    '
  )

  if [ "$task_count" = "0" ]; then
    log "SEED_ON_START is set and the task table is empty — seeding"
    # ALLOW_SEED is set here and nowhere else: the guard exists so that seeding
    # is an explicit act, and this line is that act. NODE_ENV stays `production`
    # (the image serves a production build), which is precisely why the guard
    # keys off ALLOW_SEED and not NODE_ENV.
    ALLOW_SEED=true node dist/seed/index.js
  else
    log "SEED_ON_START is set but the task table holds $task_count rows — skipping seed"
  fi
else
  log "SEED_ON_START is not set — skipping seed"
fi

log "starting: $*"
exec "$@"
