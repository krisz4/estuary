import { defineConfig, devices } from "@playwright/test";

import {
  ALLOWED_ORIGINS,
  API_BASE_URL,
  API_DIR,
  API_HOST,
  API_ORIGIN,
  API_PORT,
  BASE_URL,
  E2E_DATABASE_URL,
  WEB_DIR,
  WEB_PORT,
} from "./e2e/env";

/**
 * End-to-end suite — stage 15. The five scenarios are listed in
 * `docs/engineering/TESTING.md` § E2E; the ports, origins, and database path
 * they share live in `e2e/env.ts`, which explains why none of them are the
 * development ones.
 *
 * ## The three settings that are not defaults, and why
 *
 * **`workers: 1`.** The suite shares one SQLite database, and SQLite has one
 * writer. That alone would only make parallel runs slow rather than wrong — but
 * spec 1 asserts a newly created ticket is *at the top* of a list sorted newest
 * first, and a second worker creating its own ticket in the same second makes
 * that assertion race. The mutating specs already build their own tickets and
 * never touch a seeded one, which is what keeps them **order**-independent; one
 * worker is what keeps them independent of each other's *timing*.
 *
 * **`retries: 0`, including in CI.** The gate for this stage is the suite green
 * twice from cold and green when the specs are shuffled. A retry turns an
 * intermittent failure into a green run with a note nobody reads, which is
 * exactly the signal the gate is trying to produce.
 *
 * **`reuseExistingServer: false`, including locally.** With it on, a dev server
 * already listening on one of these ports would be used as-is — pointed at the
 * developer's database rather than the E2E one. A port conflict must be an
 * error, not a substitution.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,

  globalSetup: "./e2e/globalSetup.ts",

  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: process.env.CI !== undefined,

  /*
    Long enough for a cold Vite dev server to compile the route being visited on
    first navigation (which happens inside the first spec's timeout, not the
    webServer's), short enough that a genuinely hung request fails the run rather
    than sitting until CI's own limit.
  */
  timeout: 30_000,
  expect: { timeout: 10_000 },

  reporter: process.env.CI !== undefined ? [["github"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: BASE_URL,
    // `retain-on-failure` rather than `on-first-retry`, because there are no
    // retries — the failing run is the only one there will be.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  /*
    Two servers, both bound to 127.0.0.1 and both disposable.

    The API runs `tsx src/server.ts` rather than the `dev` script: `tsx watch`
    would add a file watcher and a restart-on-save loop to a process that lives
    for one test run. The web app runs the **dev** server rather than
    `vite preview`, so the suite needs no build step ahead of it; `VITE_API_BASE_URL`
    reaches the client through Vite's own `process.env` reading, which works in
    dev exactly as the `.env` file does. (It is inlined at build time in the
    production path, which is why the Docker image passes it as a build arg.)
  */
  webServer: [
    {
      command: "pnpm exec tsx src/server.ts",
      cwd: API_DIR,
      url: `${API_ORIGIN}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "ignore",
      stderr: "pipe",
      env: {
        DATABASE_URL: E2E_DATABASE_URL,
        PORT: String(API_PORT),
        HOST: API_HOST,
        ALLOWED_ORIGINS,
        LOG_LEVEL: "warn",
        // Nothing in the suite reads Swagger UI, and generating the document at
        // boot is the one thing that would make the API slower to become ready.
        DOCS_ENABLED: "false",
      },
    },
    {
      command: `pnpm exec vite --port ${WEB_PORT} --strictPort`,
      cwd: WEB_DIR,
      url: BASE_URL,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "ignore",
      stderr: "pipe",
      env: {
        VITE_API_BASE_URL: API_BASE_URL,
      },
    },
  ],
});
