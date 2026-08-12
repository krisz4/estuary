/// <reference types="vitest/config" />
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";

/**
 * Vite config for the helpdesk SPA.
 *
 * Tailwind v4 has no `tailwind.config.ts`: the plugin below compiles the
 * `@theme` block in `src/index.css`, which is where every design token lives
 * (`docs/engineering/UI_DESIGN_GUIDELINES.md` § Tokens).
 *
 * The dev server is pinned to 5173 with `strictPort` because two things depend
 * on that exact spelling: the API's `ALLOWED_ORIGINS` default, and
 * `PLAYWRIGHT_BASE_URL` in stage 15. Silently sliding to 5174 when the port is
 * busy would surface as a CORS preflight failure with no obvious cause.
 */
export default defineConfig({
  /*
    React Compiler, rather than hand-placed `memo` / `useMemo` / `useCallback`.

    The screens that re-render most here are the board (four `useQueries`
    results, an in-flight `pendingMoves` map, and up to 100 cards under one
    `DndContext`) and the list (a filter bar whose every control is fed from one
    `params` object). Both are shaped so that manual memoisation would mean
    memoising a chain — the derived object, then every prop closure hanging off
    it, then the leaf components — and each link has to stay correct as the code
    changes. The compiler derives that from the code itself, on every component,
    including the ones nobody thought to annotate.

    It runs through Babel because that is the only place the compiler exists;
    `reactCompilerPreset` narrows the files Babel sees to those matching
    /forwardRef|memo|\b(?:[A-Z]|use[A-Z0-9])/, so the rest of `src/` is still
    handled by Vite's native oxc transform and never pays the Babel round trip.

    Bail-outs are silent by design: a component the compiler cannot prove safe
    is left exactly as it is today, so this can never be *worse* than the
    hand-written version. `pnpm lint` is where those surface:
    `eslint-plugin-react-hooks` v7's `recommended-latest` is the compiler's own
    diagnostic set, so a rule violation that would make a component bail out is
    already a lint error here.
  */
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  server: {
    port: 5173,
    strictPort: true,
  },

  preview: {
    port: 4173,
    strictPort: true,
  },

  build: {
    outDir: "dist",

    /*
      Source maps on by default, off in the Docker image (`WEB_SOURCEMAP=false`,
      set in apps/web/Dockerfile).

      Locally they are what makes a stack trace from `pnpm build` or
      `vite preview` readable. In the image they are a liability: the runtime
      stage copies `dist/` into nginx and serves it publicly under /assets/ with
      a one-year cache, so every `.map` publishes the original TypeScript and
      roughly doubles the asset bytes shipped.

      Build-time only — it is read here, in the node process running Vite, and is
      not a `VITE_`-prefixed variable, so it is never inlined into the bundle.
    */
    sourcemap: process.env.WEB_SOURCEMAP !== "false",
  },

  test: {
    // `tests/` holds the few checks that need Node APIs (reading index.css) and
    // is therefore compiled by tsconfig.node.json, not by the browser-typed app
    // config. Component tests live beside their component under src/.
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.ts"],
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    css: false,
    coverage: {
      exclude: ["vitest.*.ts", "vite.config.ts", "dist/**", "src/main.tsx"],
    },
  },
});
