import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The one place the E2E run's ports, origins, and database path are spelled.
 *
 * `playwright.config.ts` (which starts the servers), `globalSetup.ts` (which
 * prepares the database they read) and the specs (which talk to the API
 * directly to build their own fixtures) all need the same values, and three
 * copies of a port number drift the first time one is changed.
 *
 * ## Why not 4000 / 5173
 *
 * Because `pnpm dev` uses those, and `reuseExistingServer` would then hand the
 * suite a developer's dev servers — pointed at `apps/api/prisma/data/estuary.db`.
 * Most specs create, transition, comment on, and **delete** tasks. Running
 * `pnpm test:e2e` with `pnpm dev` open in another terminal is an ordinary thing
 * to do, and on the shared ports it would quietly mutate the developer's local
 * data — the exact failure `docs/engineering/TESTING.md` calls non-negotiable
 * for the vitest suite ("a developer losing local data to a test run is
 * unacceptable"). Dedicated ports make the collision impossible rather than
 * unlikely, and `reuseExistingServer: false` in the config means a stale process
 * on one of them is an error rather than a silent substitution.
 *
 * ## Why 127.0.0.1 everywhere and not `localhost`
 *
 * `localhost` resolves to both `::1` and `127.0.0.1`, and which one Vite's
 * dev server binds when told `localhost` depends on the machine — on some it is
 * only `::1`. A base URL spelled `localhost` therefore depends on the
 * resolver's preference order, which differs between macOS, Linux, and CI
 * images — and fails as a bare `ECONNREFUSED` naming nothing. So Vite is
 * started with `--host 127.0.0.1` (`WEB_HOST`), and that one spelling is used
 * by the config, the specs, and `ALLOWED_ORIGINS` alike.
 */

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(E2E_DIR, "..");

export const API_PORT = 4010;
export const WEB_PORT = 5183;

export const API_HOST = "127.0.0.1";
/** Passed to Vite as `--host`: left to itself it binds `localhost`, which may be `::1` only. */
export const WEB_HOST = "127.0.0.1";
export const WEB_ORIGIN = `http://${WEB_HOST}:${WEB_PORT}`;
export const API_ORIGIN = `http://${API_HOST}:${API_PORT}`;

/** What the browser is pointed at, and what the specs `page.goto()` against. */
export const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? WEB_ORIGIN;

/** Includes the `/api/v1` prefix, exactly as `VITE_API_BASE_URL` must. */
export const API_BASE_URL = `${API_ORIGIN}/api/v1`;

/**
 * The **third** database: not `apps/api/prisma/data/estuary.db` (the dev file)
 * and not the per-worker files in `os.tmpdir()` that vitest uses. Gitignored,
 * together with its `-wal` / `-shm` siblings.
 */
export const E2E_DB_PATH = path.join(E2E_DIR, "estuary-e2e.db");

/** Prisma wants a connection string. Absolute, so nothing resolves it from `prisma/`. */
export const E2E_DATABASE_URL = `file:${E2E_DB_PATH}`;

export const API_DIR = path.join(REPO_ROOT, "apps", "api");
export const WEB_DIR = path.join(REPO_ROOT, "apps", "web");

/**
 * Both spellings of the web origin, because a browser treats them as different
 * origins and a hand-typed `localhost:5183` in a debugging session should not
 * fail preflight. This does **not** widen the API's default list (D21): it is
 * set on the E2E API process only, and the four development origins the default
 * carries are not part of it.
 */
export const ALLOWED_ORIGINS = [WEB_ORIGIN, `http://localhost:${WEB_PORT}`].join(",");
