// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

/**
 * Root flat config for the whole monorepo.
 *
 * `pnpm lint` runs a single eslint pass from the repo root rather than fanning
 * out through turbo: one config, one resolution of the shared rules, and no
 * per-workspace duplication. Workspaces layer their own overrides here (by
 * `files:` glob) instead of shipping their own config file.
 */
export default tseslint.config(
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

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
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

  // Node-side source (apps/api, scripts, config files).
  {
    files: ["apps/api/**/*.{ts,js}", "e2e/**/*.ts", "**/*.config.{ts,js,mts,mjs}"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Browser-side source (apps/web).
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
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
