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
 * the literal-before-`/:taskId` declaration order (`/facets`, `/stats`,
 * `/next`), and the absence of `express-async-handler`.
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
    // directory is renamed. The `*.openapi.ts` modules live here on purpose
    // (`docs/features/API_Documentation.md` places schema registration beside
    // its router) and are held to the same no-Prisma rule.
    expect(routeFiles.map((file) => file.name).sort()).toEqual([
      "routes/comments.openapi.ts",
      "routes/comments.route.ts",
      "routes/docs.route.ts",
      "routes/events.openapi.ts",
      "routes/events.route.ts",
      "routes/system.openapi.ts",
      "routes/tasks.openapi.ts",
      "routes/tasks.route.ts",
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
    // Listed rather than counted, so a new service is a conscious addition to
    // the checked set and a renamed one cannot silently drop out of it.
    expect(serviceFiles.map((file) => file.name).sort()).toEqual([
      "services/comment.service.ts",
      "services/task-events.ts",
      "services/task-guards.ts",
      "services/task-query.ts",
      "services/task-read.ts",
      "services/task-status.ts",
      "services/task-workflow.service.ts",
      "services/task.service.ts",
    ]);
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
  const tasks = routeFiles.find((file) => file.name === "routes/tasks.route.ts")?.text ?? "";

  /**
   * Declaration order, checked positionally. With these swapped, `facets` is
   * captured as `:taskId` and 404s — `tasks.route.test.ts` catches the
   * behaviour, this catches the cause and names it.
   */
  it.each(["/facets", "/stats"])("declares GET %s before GET /:taskId", (path) => {
    const literal = tasks.indexOf(`tasksRouter.get(\n  "${path}"`);
    const byId = tasks.indexOf('tasksRouter.get(\n  "/:taskId"');

    expect(literal).toBeGreaterThan(-1);
    expect(byId).toBeGreaterThan(-1);
    expect(literal).toBeLessThan(byId);
  });

  /**
   * `POST /next` cannot collide with a `POST /:taskId` today, because there is
   * none — but the day someone adds one, `next` must already be above it.
   */
  it("declares POST /next before any POST on /:taskId", () => {
    const nextRoute = tasks.indexOf('tasksRouter.post(\n  "/next"');
    const firstById = tasks.indexOf('tasksRouter.post(\n  "/:taskId');

    expect(nextRoute).toBeGreaterThan(-1);
    expect(firstById).toBeGreaterThan(-1);
    expect(nextRoute).toBeLessThan(firstById);
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

    /**
     * Only the resource routers have async handlers to wrap: the `*.openapi.ts`
     * modules register schemas and `docs.route.ts` mounts static middleware, and
     * neither awaits anything.
     *
     * **`docs.route.ts` is filtered out before the floor assertion, not skipped
     * inside the loop.** Counting it and then `continue`-ing past it made the
     * floor pass with a single file left to check — renaming `comments.route.ts`
     * would have kept the length at 2 while the rule was asserted against
     * `tasks.route.ts` alone. Same class as the vacuous tests in the build
     * log's "what these gates are actually worth" note.
     */
    const resourceRouters = routeFiles.filter(
      (file) => file.name.endsWith(".route.ts") && file.name !== "routes/docs.route.ts",
    );
    expect(resourceRouters.map((file) => file.name).sort()).toEqual([
      "routes/comments.route.ts",
      "routes/events.route.ts",
      "routes/tasks.route.ts",
    ]);

    for (const { text } of resourceRouters) {
      expect(text).toMatch(/from\s+["']\.\.\/lib\/asyncHandler\.js["']/);
    }
  });
});
