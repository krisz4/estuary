import { defineConfig } from "vitest/config";

/**
 * MCP server tests. No network and no API process: every test drives the real
 * `McpServer` through the SDK's in-memory transport, with `fetch` replaced by a
 * recorder (`src/test/fake-fetch.ts`). What is under test is the mapping —
 * tool call in, HTTP request out, API response back to tool text.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
