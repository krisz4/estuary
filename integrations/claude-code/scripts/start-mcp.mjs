#!/usr/bin/env node
/**
 * Launches the task manager MCP server (`estuary-mcp`, built from `apps/mcp`)
 * for the plugin. First match wins:
 *
 * 1. `TASKS_MCP_SERVER` — the plugin's `server_path` option: a built
 *    `apps/mcp/dist/index.js` to run instead of the published package. An
 *    explicit path that does not exist is an error, not a reason to fall back.
 * 2. `../../apps/mcp/dist/index.js` relative to this plugin — true when the
 *    plugin is installed from a checkout used as a local marketplace
 *    (`claude plugin marketplace add /path/to/estuary`), which Claude Code
 *    loads in place rather than copying. This is the contributor path: a
 *    rebuild takes effect on the next session. A plugin installed from GitHub
 *    is copied into Claude Code's cache, where nothing is next to it.
 * 3. Otherwise `npx -y estuary-mcp@<version>`, pinned to this plugin's own
 *    version from `.claude-plugin/plugin.json` — plugin and package are released
 *    in lockstep, so an installed plugin always runs the server it was tested
 *    with. npm caches the package after the first download.
 *
 * No dependencies and no build step of its own, so it runs from wherever the
 * plugin sits. Diagnostics go to stderr: stdout is the MCP protocol stream.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE = "estuary-mcp";
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const fail = (lines) => {
  console.error(lines.map((line) => `[estuary plugin] ${line}`).join("\n"));
  process.exit(1);
};

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

/** Runs a built server in this process: its entry point starts itself on import. */
const runLocal = async (serverPath) => {
  await import(pathToFileURL(serverPath).href);
};

/** The plugin's version, which is also the `estuary-mcp` version it runs. */
const pluginVersion = () => {
  const manifest = resolve(pluginRoot, ".claude-plugin/plugin.json");
  let version;
  try {
    version = JSON.parse(readFileSync(manifest, "utf8")).version;
  } catch (error) {
    fail([`Cannot read the plugin version from ${manifest}: ${error.message}`]);
  }
  // It ends up on a command line (through a shell on Windows): accept a plain semver only.
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail([`${manifest} has no valid "version" (got ${JSON.stringify(version)}).`]);
  }
  return version;
};

/**
 * Runs the published package through npx as a child that shares our stdio, so
 * the protocol stream passes straight through, and mirrors how it ends.
 */
const runFromNpm = () => {
  const spec = `${PACKAGE}@${pluginVersion()}`;
  const windows = process.platform === "win32";
  // Prefer the npx installed next to the node running us (nvm and friends put both
  // in one directory), then whatever PATH has. On Windows, PATH's npx.cmd: it runs
  // through a shell, where an unquoted "Program Files" path would break.
  const sibling = resolve(dirname(process.execPath), "npx");
  const npx = windows ? "npx.cmd" : existsSync(sibling) ? sibling : "npx";
  // `-y` skips npx's install prompt, which would otherwise wait on the protocol's stdin.
  const child = spawn(npx, ["-y", spec], {
    stdio: "inherit",
    // Node refuses to spawn a `.cmd` without a shell; the arguments are fixed above.
    shell: windows,
    // npm's update notice is noise in Claude Code's MCP log.
    env: { ...process.env, npm_config_update_notifier: "false" },
    windowsHide: true,
  });

  const forwarded = ["SIGINT", "SIGTERM", "SIGHUP"];
  const forward = (signal) => child.kill(signal);
  for (const signal of forwarded) process.on(signal, forward);

  child.on("error", (error) => {
    fail([
      `Could not run \`npx -y ${spec}\`: ${error.message}`,
      "npx ships with npm; install Node.js with npm, or build the server from a checkout",
      "(pnpm --filter estuary-mcp build) and set the plugin's server_path option to its",
      "apps/mcp/dist/index.js (/plugin configure estuary).",
    ]);
  });

  child.on("exit", (code, signal) => {
    for (const s of forwarded) process.off(s, forward);
    if (signal !== null) {
      // Die of the same signal, so whoever started us sees what the server saw.
      process.kill(process.pid, signal);
      return;
    }
    if (code !== 0) {
      console.error(
        `[estuary plugin] \`npx -y ${spec}\` exited with code ${code}. If the download failed, ` +
          "check network access to the npm registry, or set server_path to a local build.",
      );
    }
    process.exit(code ?? 1);
  });
};

const explicit = process.env.TASKS_MCP_SERVER;
if (explicit !== undefined) {
  const serverPath = resolve(explicit);
  if (!existsSync(serverPath)) {
    fail([
      `MCP server not found at ${serverPath} (the server_path option / TASKS_MCP_SERVER).`,
      "Build it in the task manager repo (pnpm install && pnpm --filter estuary-mcp build),",
      "or clear server_path to use the published estuary-mcp package (/plugin configure estuary).",
    ]);
  }
  await runLocal(serverPath);
} else {
  const checkout = resolve(pluginRoot, "../../apps/mcp");
  const built = resolve(checkout, "dist/index.js");
  if (existsSync(built)) {
    await runLocal(built);
  } else {
    if (existsSync(resolve(checkout, "package.json"))) {
      // A contributor's checkout that was never built: say why their code is not what runs.
      console.error(
        `[estuary plugin] ${checkout} is not built; running the published ${PACKAGE} instead. ` +
          "Build it with: pnpm --filter estuary-mcp build",
      );
    }
    runFromNpm();
  }
}
