#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ConfigError, loadConfig } from "./config.js";
import { createServer } from "./server.js";

/**
 * Entry point: `node apps/mcp/dist/index.js`, spawned by Claude Code over stdio.
 *
 * **stdout belongs to the protocol.** Anything else written there corrupts the
 * JSON-RPC stream and the client drops the connection, so every diagnostic in
 * this package goes to stderr — which Claude Code keeps in its MCP logs.
 *
 * A bad configuration exits at startup, like the API's `env.ts` does, rather
 * than failing on every tool call: the message lands once, where
 * `claude mcp list` and `/mcp` show the server as failed.
 */

try {
  const config = loadConfig(process.env);
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  console.error(`[tasks-mcp] ready — API ${config.apiUrl}, actor ${config.actor}`);
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
}
