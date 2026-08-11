// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The dark-mode guarantee, asserted rather than eyeballed.
 *
 * "Define both light and dark values for every token" is a rule that fails
 * silently: a token declared only under `:root` renders its *light* value on a
 * dark surface, which looks like a contrast bug three screens away from the
 * line that caused it. Enumerating both blocks and comparing the key sets is
 * the only check that catches it at the point of edit.
 *
 * The file is read as text on purpose. Reading it through the Tailwind pipeline
 * would let a token that Tailwind happens to fall back for pass, and the
 * fallback is the failure mode being tested.
 *
 * It lives in `tests/` rather than beside `index.css` because it needs
 * `node:fs`, and `apps/web`'s tsconfig is browser-typed (`types:
 * ["vite/client"]`) on purpose — adding `@types/node` so one test can read a
 * file would put `process` and `Buffer` in scope for every component in the
 * app. `tests/` is compiled by `tsconfig.node.json` instead. (Importing the CSS
 * with `?raw` was the obvious alternative and does not work: vitest's
 * `css: false` — which every component test wants — resolves it to an empty
 * string, and an empty string passes every assertion here.)
 */

// Resolved from the vitest root (apps/web) rather than from `import.meta.url`,
// which vite-node serves as an http: URL that `fileURLToPath` rejects.
const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

/** Pulls the body of a top-level `selector { … }` block. */
const blockBody = (selector: string): string => {
  const start = css.indexOf(`${selector} {`);
  expect(start, `no "${selector}" block in index.css`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("\n}", start);
  expect(end, `unterminated "${selector}" block`).toBeGreaterThan(start);
  return css.slice(start, end);
};

/** `--name: value;` → Map(name → value), comments and blank lines ignored. */
const declarations = (body: string): Map<string, string> => {
  const found = new Map<string, string>();
  for (const match of body.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gim)) {
    const [, name, value] = match;
    if (name === undefined || value === undefined) continue;
    found.set(name, value.trim());
  }
  return found;
};

const light = declarations(blockBody(":root"));
const dark = declarations(blockBody(".dark"));
const themed = declarations(blockBody("@theme inline"));

describe("design tokens", () => {
  it("declares a non-trivial number of tokens (the parser found something)", () => {
    // Guards the two assertions below from passing vacuously on a regex that
    // stopped matching — two empty sets are equal, and every empty set has no
    // empty value in it.
    expect(light.size).toBeGreaterThan(20);
  });

  it("declares exactly the same token names in light and dark", () => {
    expect([...dark.keys()].sort()).toEqual([...light.keys()].sort());
  });

  it.each([
    ["light", light],
    ["dark", dark],
  ])("gives every %s token a non-empty value", (_theme, tokens) => {
    const empty = [...tokens].filter(([, value]) => value === "" || value === "initial");
    expect(empty).toEqual([]);
  });

  it("maps every token to a Tailwind color utility, and maps nothing that does not exist", () => {
    // `@theme inline` is what turns `--background` into `bg-background`. A token
    // defined but unmapped is invisible to Tailwind; a mapping pointing at a
    // token that does not exist resolves to nothing at runtime.
    const mappedTokens = [...themed]
      .filter(([name]) => name.startsWith("--color-"))
      .map(([, value]) => value.replace(/^var\(\s*|\s*\)$/g, ""));

    expect(new Set(mappedTokens)).toEqual(new Set(light.keys()));
  });
});
