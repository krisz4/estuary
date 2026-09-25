#!/usr/bin/env node
/**
 * Launches the task manager MCP server (`apps/mcp`) for the plugin.
 *
 * The server is not bundled into the plugin: it lives in the task manager repo
 * and needs that repo's `node_modules`, so the plugin has to find a built copy.
 * In order:
 *
 * 1. `TASKS_MCP_SERVER` — the plugin's `server_path` option. Needed when the
 *    plugin was copied into Claude Code's cache (any marketplace other than a
 *    local directory), because then nothing is next to it.
 * 2. `../../apps/mcp/dist/index.js` relative to this plugin — true when the
 *    plugin is installed from the repo's own local marketplace
 *    (`claude plugin marketplace add <repo>/integrations`), which Claude Code
 *    loads in place rather than copying.
 *
 * No dependencies and no build step of its own, so it runs from wherever the
 * plugin sits. Diagnostics go to stderr: stdout is the MCP protocol stream.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A plugin option the user never set can reach us as `""` or, on some
 * versions, as the literal `${user_config.key}`. Both mean "unset" — and must be
 * removed before the server parses its environment, or an unset token would be
 * sent as `Bearer ${user_config.api_token}`.
 */
const isUnset = (value) =>
  value === undefined || value.trim() === "" || /^\$\{[^}]*\}$/.test(value.trim());

for (const key of [
  "TASKS_API_URL",
  "TASKS_ACTOR",
  "TASKS_API_TOKEN",
  "TASKS_DEFAULT_PROJECT",
  "TASKS_MCP_SERVER",
]) {
  if (isUnset(process.env[key])) delete process.env[key];
}

const serverPath = process.env.TASKS_MCP_SERVER
  ? resolve(process.env.TASKS_MCP_SERVER)
  : resolve(pluginRoot, "../../apps/mcp/dist/index.js");

if (!existsSync(serverPath)) {
  console.error(
    [
      `[task-manager plugin] MCP server not found at ${serverPath}.`,
      "Build it in the task manager repo: pnpm install && pnpm --filter @helpdesk/mcp build",
      "If the plugin is not installed from that repo's local marketplace, set the plugin's",
      "server_path option to <repo>/apps/mcp/dist/index.js (/plugin configure task-manager).",
    ].join("\n"),
  );
  process.exit(1);
}

// The server's entry point starts itself on import.
await import(pathToFileURL(serverPath).href);
