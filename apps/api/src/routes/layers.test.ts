import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The layer rule from `docs/engineering/ARCHITECTURE.md`, asserted **from the
 * source text** rather than trusted to review:
 *
 * | Layer | May import | Must not |
 * | ----- | ---------- | -------- |
 * | `routes/` | contracts, services | Prisma |
 * | `services/` | contracts, `lib/prisma` | `req` / `res` / Express |
 *
 * It is a grep, and a grep is exactly the right instrument here. The rule is
 * syntactic — "this identifier does not appear in this directory" — and any
 * runtime check would have to boot the thing it is trying to prove is separable.
 * Its whole value is that it fails on the *first* violating line, in a review
 * where the violation looks locally reasonable ("just one Prisma call, the
 * service would only wrap it").
 *
 * Two rules that are not in the table but belong to stage 8 are pinned here too:
 * the `/facets` declaration order, and the absence of `express-async-handler`.
 */

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

const sourceFiles = (dir: string): { name: string; text: string }[] =>
  readdirSync(join(SRC, dir))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => ({ name: `${dir}/${name}`, text: readFileSync(join(SRC, dir, name), "utf8") }));

/** Comments describe the rules; only code should be searched for violations. */
const stripComments = (text: string): string =>
  text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "");

const routeFiles = sourceFiles("routes");
const serviceFiles = sourceFiles("services");

describe("routes/ contains no Prisma", () => {
  it("finds route files to check at all", () => {
    // Without this the two assertions below pass vacuously the day the
    // directory is renamed.
    expect(routeFiles.map((file) => file.name).sort()).toEqual([
      "routes/comments.route.ts",
      "routes/tickets.route.ts",
    ]);
  });

  it.each(routeFiles)("$name imports neither @prisma/client nor lib/prisma", ({ text }) => {
    const code = stripComments(text);

    expect(code).not.toMatch(/from\s+["']@prisma\/client["']/);
    expect(code).not.toMatch(/from\s+["'][^"']*lib\/prisma\.js["']/);
    expect(code).not.toMatch(/\bprisma\s*\./);
  });
});

describe("services/ contains no HTTP", () => {
  it("finds service files to check at all", () => {
    expect(serviceFiles.length).toBeGreaterThanOrEqual(4);
  });

  it.each(serviceFiles)("$name references no req, res, or express type", ({ text }) => {
    const code = stripComments(text);

    expect(code).not.toMatch(/from\s+["']express["']/);
    expect(code).not.toMatch(/\breq\b/);
    expect(code).not.toMatch(/\bres\b/);
    expect(code).not.toMatch(/\bRequest\b|\bResponse\b|\bNextFunction\b/);
  });
});

describe("stage-8 route rules", () => {
  const tickets = routeFiles.find((file) => file.name === "routes/tickets.route.ts")?.text ?? "";

  /**
   * Declaration order, checked positionally. With these swapped, `facets` is
   * captured as `:ticketId` and 404s — `tickets.route.test.ts` catches the
   * behaviour, this catches the cause and names it.
   */
  it("declares /facets before /:ticketId", () => {
    const facets = tickets.indexOf('ticketsRouter.get(\n  "/facets"');
    const byId = tickets.indexOf('ticketsRouter.get(\n  "/:ticketId"');

    expect(facets).toBeGreaterThan(-1);
    expect(byId).toBeGreaterThan(-1);
    expect(facets).toBeLessThan(byId);
  });

  it("implements no PUT — PATCH is the only update verb", () => {
    for (const { text } of routeFiles) {
      expect(stripComments(text)).not.toMatch(/\.put\s*\(/);
    }
  });

  it("uses the local asyncHandler, not the express-async-handler package", () => {
    const manifest = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8")) as Record<
      string,
      Record<string, string>
    >;

    expect(Object.keys(manifest.dependencies ?? {})).not.toContain("express-async-handler");
    expect(Object.keys(manifest.devDependencies ?? {})).not.toContain("express-async-handler");

    for (const { text } of routeFiles) {
      expect(text).toMatch(/from\s+["']\.\.\/lib\/asyncHandler\.js["']/);
    }
  });
});
