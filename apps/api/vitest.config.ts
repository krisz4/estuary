import { defineConfig } from "vitest/config";

/**
 * API test harness. The three files it wires together are described in
 * `docs/engineering/TESTING.md` § Database isolation:
 *
 * | File | Runs | Owns |
 * | ---- | ---- | ---- |
 * | `vitest.globalSetup.ts` | once, main process | the migrated template database |
 * | `vitest.setup.ts` | before **every test module** | `DATABASE_URL`, truncation, log filtering |
 * | `src/test/factories.ts` | on demand | explicit row builders |
 *
 * The `setupFiles` entry is load-bearing and is not an alias for a `beforeAll`:
 * setup files run before the test module is imported, hooks run after, and
 * `src/lib/prisma.ts` binds its client at import time.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",

    globalSetup: ["./vitest.globalSetup.ts"],
    setupFiles: ["./vitest.setup.ts"],

    /**
     * Vitest only defaults `NODE_ENV` to `test` when it is unset, so an exported
     * `NODE_ENV=development` would silently unmount the `/__test__/boom`
     * diagnostic routes. Pinning it here keeps the `test` script a plain
     * `vitest run` instead of an environment-prefixed one.
     */
    env: {
      NODE_ENV: "test",
    },

    /**
     * The default pool. Named explicitly because the whole isolation scheme
     * depends on it: `forks` gives every worker its own `process.env`, which is
     * what makes a per-worker `DATABASE_URL` possible at all. Under `threads`,
     * workers share one environment and would fight over one database file.
     */
    pool: "forks",

    /**
     * `globalSetup` migrates the template once per run, and a worker copies it
     * once. Vitest re-runs `globalSetup` only when `globalSetup` itself changes —
     * so in watch mode, adding a migration leaves every worker on the schema
     * from before it, and the failures read as `no such column` against a schema
     * that is plainly correct on disk. These triggers restart the run instead.
     */
    forceRerunTriggers: [
      "**/package.json",
      "**/vitest.config.*",
      "**/vite.config.*",
      "./prisma/schema.prisma",
      "./prisma/migrations/**",
    ],

    coverage: {
      /**
       * The harness is not the subject. Reporting on the setup files and the
       * factories inflates the number with code whose only purpose is to run
       * the tests, and buries the services stages 6–8 actually add.
       */
      exclude: ["vitest.*.ts", "src/test/**", "dist/**", "prisma/**"],
    },
  },
});
