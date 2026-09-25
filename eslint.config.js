// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

/**
 * Root flat config for the whole monorepo.
 *
 * `pnpm lint` runs a single eslint pass from the repo root rather than fanning
 * out through turbo: one config, one resolution of the shared rules, and no
 * per-workspace duplication. Workspaces layer their own overrides here (by
 * `files:` glob) instead of shipping their own config file.
 */
export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "apps/api/prisma/migrations/**",
      "apps/api/openapi.json",
    ],
  },

  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
      "object-shorthand": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
    },
  },

  // Node-side source (apps/api, apps/mcp, the Claude Code plugin's scripts, config files).
  {
    files: [
      "apps/api/**/*.{ts,js}",
      "apps/mcp/**/*.{ts,js}",
      "integrations/**/*.{js,mjs}",
      "e2e/**/*.ts",
      "**/*.config.{ts,js,mts,mjs}",
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Browser-side source (apps/web).
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    // The plugin is registered by hand rather than spread from its shipped
    // config: `configs["recommended-latest"]` carries `plugins` as an *array*,
    // which ESLint 10 rejects outright ("flat config requires plugins to be an
    // object"). Taking the rule table and naming the plugin ourselves is the
    // same result in a shape this ESLint accepts.
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      ...reactHooks.configs["recommended-latest"].rules,
      /**
       * The exhaustive-deps rule is an error rather than the plugin's default
       * warning, because `pnpm lint` runs with `--max-warnings 0` — a warning
       * would fail the build anyway, just with a label that says it is optional.
       *
       * The rule earns its place on the two screens stages 11–12 build: a
       * `useEffect` with a stale dependency is how a debounced search box stops
       * seeing the latest query, and it produces no error, only wrong data.
       */
      "react-hooks/exhaustive-deps": "error",
    },
  },

  // Tests may reach for looser typing than production code.
  {
    files: ["**/*.test.{ts,tsx}", "**/test/**/*.{ts,tsx}", "e2e/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },

  // Must stay last: turns off every rule Prettier owns.
  prettier,
);
