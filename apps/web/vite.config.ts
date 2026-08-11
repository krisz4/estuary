/// <reference types="vitest/config" />
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
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
  plugins: [react(), tailwindcss()],

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
    sourcemap: true,
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
