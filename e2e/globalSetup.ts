import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";

import { API_DIR, API_ORIGIN, E2E_DATABASE_URL, E2E_DB_PATH } from "./env";

/**
 * Playwright **global** setup: builds the database the suite runs against.
 *
 * ## The ordering, which is the opposite of what it looks like
 *
 * Playwright starts the `webServer` entries **before** `globalSetup` runs —
 * measured, not assumed: a probe here found `GET /health` already answering
 * `200`. So by the time this function deletes the database file, the API process
 * is already up.
 *
 * That is safe because of one property the API states explicitly: **`/health`
 * touches no database** (`apps/api/src/app.ts`), and Prisma opens SQLite lazily
 * on the first query. The API therefore holds no file handle when the file is
 * replaced, and opens the *new* one when the first spec asks it for something.
 *
 * It is safe, but it is not obviously safe, which is why the last step below
 * asks the API to count tickets. If that invariant ever changes — anything that
 * queries during boot — the API would be holding a handle on a deleted inode,
 * and the check turns what would otherwise surface as `no such table: Ticket`
 * in the middle of an unrelated spec into a failure at setup with a sentence
 * explaining it.
 *
 * ## Why the file is deleted rather than just re-seeded
 *
 * The seed already wipes every row and resets `sqlite_sequence`, so re-seeding
 * alone would give reproducible ids. What it would not give is a schema:
 * `migrate deploy` against a file left behind by an older branch replays only
 * *pending* migrations, and a table dropped or edited by hand outside the
 * migration history stays that way. Starting from nothing costs ~2 s and makes
 * the run's schema exactly the migration folder's — which is also what the
 * Docker gate checks, for the same reason.
 *
 * ## Why seeded data is legitimate here, having been banned in vitest
 *
 * `docs/engineering/TESTING.md` forbids the vitest suites from touching the seed
 * — a unit test coupled to seed output breaks whenever the seed changes. Spec 2
 * is the opposite case: it is *about* filtering, sorting, and paging a list
 * large enough to have a second page, and 63 rows of that is precisely what the
 * seed exists to produce. It still asserts on *relationships* (every row open,
 * priorities non-increasing across a page boundary, page 2 disjoint from page 1)
 * rather than on particular seeded ticket numbers.
 */

const SQLITE_SIBLINGS = ["", "-journal", "-wal", "-shm"];

const bin = (name: string): string => {
  const local = path.join(API_DIR, "node_modules", ".bin", name);
  if (!existsSync(local)) {
    throw new Error(
      `${name} not found at ${local}. Run \`pnpm install\` — the E2E global setup migrates and ` +
        `seeds its own database with the API workspace's own CLIs.`,
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
  execFileSync(command, args, {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL, ...extraEnv },
    stdio: "pipe",
  });
};

/**
 * Ask the API — not Prisma — how many tickets it can see.
 *
 * Going through HTTP is the point: it is the only way to learn whether the
 * *server process the specs will talk to* is reading the file this function
 * just wrote.
 */
const assertApiSeesSeededData = async (): Promise<void> => {
  const response = await fetch(`${API_ORIGIN}/api/v1/tickets?pageSize=1`).catch(
    (error: unknown) => error as Error,
  );

  if (response instanceof Error) {
    throw new Error(
      `The E2E API at ${API_ORIGIN} is not answering after the database was seeded ` +
        `(${response.message}).`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `The E2E API answered ${response.status} for a seeded list. If this is a missing table, the ` +
        `API opened ${E2E_DB_PATH} before globalSetup replaced it — see the note at the top of ` +
        `e2e/globalSetup.ts.`,
    );
  }

  const { meta } = (await response.json()) as { meta: { total: number } };
  if (meta.total === 0) {
    throw new Error(
      `The E2E API reports 0 tickets immediately after seeding. It is reading a different ` +
        `database than ${E2E_DB_PATH}.`,
    );
  }
};

export default async function globalSetup(): Promise<void> {
  removeDatabase();

  run(bin("prisma"), ["migrate", "deploy"]);

  /*
    `ALLOW_SEED` is not strictly required — this run is not `NODE_ENV=production`
    — but the seed deletes every ticket and comment before writing, and a switch
    that says so belongs at the call site rather than being implied by an absent
    variable.

    `LOG_LEVEL=warn` because the seed's progress lines otherwise land in the
    middle of Playwright's reporter output.
  */
  run(bin("tsx"), ["src/seed/index.ts"], { ALLOW_SEED: "true", LOG_LEVEL: "warn" });

  await assertApiSeesSeededData();
}
