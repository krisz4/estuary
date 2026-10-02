import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getOpenApiDocument } from "../src/openapi.js";

/**
 * `pnpm --filter @estuary/api openapi:gen` → `apps/api/openapi.json`.
 *
 * The artifact is **committed**, and it is regenerated in the same change set as
 * any contract change. CI re-runs this and fails if the working tree is dirty
 * afterwards, which is what turns "remember to regenerate" into a check.
 *
 * Formatting is fixed here rather than left to Prettier: `openapi.json` is in
 * `.prettierignore` (it is generated, not authored), so the two-space indent and
 * trailing newline below are the only thing keeping the committed file's diff
 * readable and stable between runs.
 */

const OUTPUT = fileURLToPath(new URL("../openapi.json", import.meta.url));

const document = getOpenApiDocument();

writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`, "utf8");

const pathCount = Object.keys(document.paths ?? {}).length;
const operationCount = Object.values(document.paths ?? {}).reduce<number>(
  (total, item) =>
    total +
    Object.keys(item as Record<string, unknown>).filter((key) => key !== "parameters").length,
  0,
);

process.stdout.write(
  `openapi.json written — ${pathCount} paths, ${operationCount} operations, ` +
    `${Object.keys(document.components?.schemas ?? {}).length} components\n`,
);
