import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";

import { API_DIR, E2E_DATABASE_URL, E2E_DB_PATH } from "./env";

/**
 * Builds the database the E2E suite runs against: delete, migrate, seed.
 *
 * Run as the **first half of the API's `webServer` command**
 * (`playwright.config.ts`), so it finishes before the API process exists.
 *
 * ## Why here and not in `globalSetup`
 *
 * Playwright starts the `webServer` entries **before** `globalSetup` runs. This
 * used to live in `globalSetup` anyway, on the strength of one property: the
 * API touched no database until the first request, so replacing the file under
 * a running server was safe. That property is gone — the server now switches
 * SQLite to WAL at boot (`enableWal()` in `apps/api/src/server.ts`), which
 * opens the file, *creating an empty one* if it is missing. Deleting it
 * afterwards left the API holding a handle on an unlinked inode, and every
 * request answered `The table main.Task does not exist`.
 *
 * Building the file before the process starts removes the ordering question
 * rather than depending on the API's boot staying lazy. `globalSetup` still asks
 * the API for a count, so a regression here fails at setup with a sentence
 * rather than in the middle of an unrelated spec.
 *
 * ## Why the file is deleted rather than just re-seeded
 *
 * The seed already wipes every row and resets `sqlite_sequence`, so re-seeding
 * alone would give reproducible ids. What it would not give is a schema:
 * `migrate deploy` against a file left behind by an older branch replays only
 * *pending* migrations, and a table dropped or edited by hand outside the
 * migration history stays that way. Starting from nothing costs ~2 s and makes
 * the run's schema exactly the migration folder's.
 *
 * ## Why seeded data is legitimate here, having been banned in vitest
 *
 * `docs/engineering/TESTING.md` forbids the vitest suites from touching the seed
 * — a unit test coupled to seed output breaks whenever the seed changes. The
 * filter/sort/page spec is the opposite case: it is *about* a list large enough
 * to have a second page, and that is precisely what the seed exists to produce.
 * It still asserts on *relationships* (every row open, priorities
 * non-increasing across a page boundary, page 2 disjoint from page 1) rather
 * than on particular seeded task numbers.
 */

const SQLITE_SIBLINGS = ["", "-journal", "-wal", "-shm"];

const bin = (name: string): string => {
  const local = path.join(API_DIR, "node_modules", ".bin", name);
  if (!existsSync(local)) {
    throw new Error(
      `${name} not found at ${local}. Run \`pnpm install\` — the E2E suite migrates and seeds ` +
        `its own database with the API workspace's own CLIs.`,
    );
  }
  return local;
};

/**
 * A stray `-wal` is worse than a stray `.db`: SQLite replays it into the next
 * connection, so a crashed run's half-written transaction would land in a
 * database this function believes it created empty.
 */
const removeDatabase = (): void => {
  for (const suffix of SQLITE_SIBLINGS) rmSync(`${E2E_DB_PATH}${suffix}`, { force: true });
};

const run = (command: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): void => {
  try {
    execFileSync(command, args, {
      cwd: API_DIR,
      env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL, ...extraEnv },
      stdio: "pipe",
    });
  } catch (error) {
    // Piped rather than inherited so Prisma's deprecation chatter stays out of
    // a passing run — and re-thrown with it, so a failing one says *why*
    // instead of only "command failed" in the `[WebServer]` output.
    const { stderr } = error as { stderr?: Buffer };
    throw new Error(
      `${path.basename(command)} ${args.join(" ")} failed:\n${stderr?.toString() ?? String(error)}`,
      { cause: error },
    );
  }
};

export const prepareDatabase = (): void => {
  removeDatabase();

  run(bin("prisma"), ["migrate", "deploy"]);

  /*
    `ALLOW_SEED` is not strictly required — this run is not `NODE_ENV=production`
    — but the seed deletes every task and comment before writing, and a switch
    that says so belongs at the call site rather than being implied by an absent
    variable. `LOG_LEVEL=warn` keeps its progress lines out of the reporter.
  */
  run(bin("tsx"), ["src/seed/index.ts"], { ALLOW_SEED: "true", LOG_LEVEL: "warn" });
};

prepareDatabase();
