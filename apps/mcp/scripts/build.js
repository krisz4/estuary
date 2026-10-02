/**
 * Builds the published server: `src/index.ts` → one self-contained `dist/index.js`.
 *
 * `@estuary/contracts` is a private workspace package, so it is bundled in; the
 * package's runtime `dependencies` (the MCP SDK and zod) stay external and are
 * installed from npm next to it. Bundling zod too would give the contracts'
 * schemas a different zod instance from the one the SDK converts to JSON Schema.
 * Anything added to `dependencies` becomes external automatically; anything
 * else that `src` imports has to be bundleable.
 *
 * Type checking is not part of the build: `pnpm typecheck` (tsc) owns it, and
 * CI runs it before `pnpm build`.
 *
 * `node scripts/build.js --watch` rebuilds on every change (`pnpm dev`),
 * including changes to the contracts' built `dist`.
 */
import { chmodSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const watch = process.argv.includes("--watch");
const outfile = "dist/index.js";

/** Marks the bin executable after every build, so `./dist/index.js` runs directly too. */
const makeExecutable = {
  name: "make-executable",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0) chmodSync(new URL(`../${outfile}`, import.meta.url), 0o755);
    });
  },
};

/** @type {import("esbuild").BuildOptions} */
const options = {
  absWorkingDir: root,
  entryPoints: ["src/index.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  // Keep in step with `engines.node` in package.json.
  target: "node20",
  // A package name also covers its subpaths (`@modelcontextprotocol/sdk/server/stdio.js`).
  external: Object.keys(pkg.dependencies ?? {}),
  // The entry point's `#!/usr/bin/env node` is carried over to the output as is.
  logLevel: "info",
  plugins: [makeExecutable],
};

// Start from an empty dist, so no stale file (e.g. from an older per-module build) is packed.
rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}
