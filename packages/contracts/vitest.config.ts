import { defineConfig } from "vitest/config";

/**
 * Contract tests are pure — no database, no HTTP, no DOM. They exist to pin the
 * four behaviors that are downstream bugs if they regress (see
 * docs/engineering/IMPLEMENTATION_PLAN.md, stage 2).
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
