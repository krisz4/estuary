import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Vitest **global** setup: runs once per `vitest run`, in the main process,
 * before any worker starts.
 *
 * Its only job is to produce a migrated, empty SQLite file that every worker
 * copies from. See `docs/engineering/TESTING.md` § Database isolation for why
 * the per-worker layout exists at all; this file owns the schema half of it and
 * `vitest.setup.ts` owns the per-worker half.
 *
 * The path helpers are exported because `vitest.setup.ts` needs exactly the same
 * names, and two copies of a filesystem convention drift the first time one of
 * them is edited.
 */

const API_ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * Databases live in the OS temp directory, never anywhere under the repo, and
 * every run gets its **own subdirectory**.
 *
 * The per-run scoping is not tidiness. Teardown removes a whole directory, and
 * an earlier version globbed a shared prefix inside `os.tmpdir()` instead — so
 * starting a second `pnpm test` while the first was running made *both* fail
 * with `no such table: Comment`, because run B's startup cleanup deleted run
 * A's live worker files. `pnpm test:watch` in one terminal plus `pnpm test` in
 * another is an ordinary thing to do, and so is a pre-commit hook firing during
 * a watch session.
 *
 * The directory name is passed to workers through `HELPDESK_TEST_DB_DIR`.
 * `globalSetup` runs in the main process before any worker is forked, so a
 * worker inherits it; the fallback keeps the helpers usable if a worker is ever
 * started without it.
 */
const TEST_DB_ROOT = os.tmpdir();
const RUN_DIR_PREFIX = "helpdesk-test-";
const RUN_DIR_ENV = "HELPDESK_TEST_DB_DIR";

export const testDbDir = (): string =>
  process.env[RUN_DIR_ENV] ?? path.join(TEST_DB_ROOT, `${RUN_DIR_PREFIX}${process.pid}`);

/** One database per vitest worker — SQLite has a single writer, workers are parallel. */
export const testDbPath = (workerId: string): string =>
  path.join(testDbDir(), `worker-${workerId}.db`);

/**
 * The migrated, empty original. Workers copy it rather than each running
 * `migrate deploy`, which costs ~1s of CLI startup per worker for a schema that
 * is identical every time.
 */
export const templateDbPath = (): string => path.join(testDbDir(), "template.db");

/** Prisma wants a connection string, not a path. Absolute, so nothing resolves it relative to `prisma/`. */
export const dbFileUrl = (filePath: string): string => `file:${filePath}`;

/**
 * Remove **this run's** directory, and with it every worker database plus the
 * SQLite `-wal` / `-shm` / `-journal` siblings. A surviving sibling is worse
 * than a stale `.db`: it replays a transaction into the next run's fresh copy.
 */
const removeRunDir = (dir: string): void => {
  rmSync(dir, { recursive: true, force: true });
};

/**
 * Sweep directories left behind by runs that crashed before teardown, so tmp
 * does not accumulate them forever. A directory is only removed when no process
 * holds its pid — never one belonging to a run happening right now.
 */
const removeAbandonedRunDirs = (currentDir: string): void => {
  let entries: string[];
  try {
    entries = readdirSync(TEST_DB_ROOT);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.startsWith(RUN_DIR_PREFIX)) continue;

    const dir = path.join(TEST_DB_ROOT, entry);
    if (dir === currentDir) continue;

    const pid = Number(entry.slice(RUN_DIR_PREFIX.length));
    if (!Number.isInteger(pid) || pid <= 0) continue;

    try {
      // Signal 0 tests for existence without delivering anything.
      process.kill(pid, 0);
      continue; // Still running — not ours to delete.
    } catch (err) {
      // EPERM means the pid exists but belongs to another user: also not ours.
      if ((err as NodeJS.ErrnoException).code === "EPERM") continue;
    }

    rmSync(dir, { recursive: true, force: true });
  }
};

const prismaBin = (): string => {
  const local = path.join(API_ROOT, "node_modules", ".bin", "prisma");
  if (!existsSync(local)) {
    throw new Error(
      `Prisma CLI not found at ${local}. Run \`pnpm install\` — the test harness migrates its ` +
        `temp databases with \`prisma migrate deploy\`.`,
    );
  }
  return local;
};

export async function setup(): Promise<void> {
  const runDir = path.join(TEST_DB_ROOT, `${RUN_DIR_PREFIX}${process.pid}`);

  // Published before any worker is forked, so every worker inherits it.
  process.env[RUN_DIR_ENV] = runDir;

  removeRunDir(runDir);
  removeAbandonedRunDirs(runDir);
  mkdirSync(runDir, { recursive: true });

  execFileSync(prismaBin(), ["migrate", "deploy"], {
    cwd: API_ROOT,
    // `migrate deploy` reads DATABASE_URL from the environment via the datasource
    // block. This is the one place the template URL is set; workers never run the CLI.
    env: { ...process.env, DATABASE_URL: dbFileUrl(templateDbPath()) },
    stdio: "pipe",
  });
}

export async function teardown(): Promise<void> {
  removeRunDir(testDbDir());
}
