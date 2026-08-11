import { config as loadDotenv } from "dotenv";
import { z } from "zod";

/**
 * The **only** `process.env` reader in the codebase.
 *
 * Everything else imports `env` from here, so a missing or malformed variable
 * fails once, at boot, with a readable message — instead of surfacing later as
 * an `undefined` threaded three layers deep.
 *
 * Keep this schema, `apps/api/env.example`, and
 * `docs/engineering/ENVIRONMENT_VARIABLES.md` in sync; a new variable is added
 * in all three places in the same change set.
 */

/**
 * Load `apps/api/.env` into `process.env` before parsing.
 *
 * Without this the Prisma CLI reads `.env` but the server does not, so
 * `db:migrate` and `pnpm dev:api` disagree about which database they are
 * talking to — migrations land in one file while requests are served from
 * another, silently.
 *
 * `override: false` is the default and is load-bearing: a value already in
 * `process.env` wins. That is what keeps a vitest worker's `DATABASE_URL`
 * (assigned in `setupFiles`, before this module is imported) from being
 * replaced by the developer's `.env` and pointed at the real database.
 */
loadDotenv({ path: new URL("../../.env", import.meta.url), quiet: true });

/**
 * Treats a blank value as absent, so `PORT=` in a compose file or CI matrix
 * falls back to the default instead of aborting boot.
 *
 * `.default()` only fires on `undefined`. Without this, `PORT=""` reaches
 * `z.coerce.number()`, becomes `0`, fails `.positive()`, and the process exits
 * with "Too small" — for a variable the operator meant to leave unset.
 */
const blankAsAbsent = (source: NodeJS.ProcessEnv): Record<string, string | undefined> => {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && value.trim() === "") continue;
    result[key] = value;
  }
  return result;
};

/** `"true"` / `"1"` / `"yes"` → true, anything else → false. */
const booleanFromString = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value.trim() === ""
        ? defaultValue
        : ["true", "1", "yes", "on"].includes(value.trim().toLowerCase()),
    );

const envSchema = z.object({
  /**
   * SQLite connection string. Relative paths resolve from `apps/api/prisma/`,
   * so `file:./data/helpdesk.db` lands at `apps/api/prisma/data/helpdesk.db`.
   *
   * **Required, with no default, on purpose.** A default here is the failure
   * that costs a developer their local data: a vitest worker whose `setupFiles`
   * entry is missing or misordered would not fail — it would quietly open the
   * dev database, and `beforeEach` would truncate it. `env.example` supplies the
   * value for local development; the container supplies it explicitly.
   */
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required — copy env.example to .env"),

  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  PORT: z.coerce.number().int().positive().max(65535).default(4000),

  /** `0.0.0.0` in Docker; `127.0.0.1` is fine locally. */
  HOST: z.string().min(1).default("0.0.0.0"),

  /**
   * Comma-separated CORS allow-list. Both spellings of loopback are in the
   * default on purpose: `localhost` and `127.0.0.1` are different origins to a
   * browser, and Playwright drives one while the dev server prints the other.
   */
  ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:5173,http://127.0.0.1:5173")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),

  /**
   * Permits seeding. The guard is this variable and **not** `NODE_ENV`, so the
   * Docker image can ship demo data while still running a production build.
   */
  ALLOW_SEED: booleanFromString(false),

  /** Container entrypoint: seed after `migrate deploy`, if the table is empty. */
  SEED_ON_START: booleanFromString(false),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  /** Set `false` to hide Swagger UI at `/docs`. */
  DOCS_ENABLED: booleanFromString(true),

  /** Over-limit bodies become `PAYLOAD_TOO_LARGE`. */
  BODY_LIMIT: z.string().min(1).default("1mb"),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(blankAsAbsent(source));

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    throw new Error(
      `Invalid environment configuration:\n${details}\n\n` +
        `See apps/api/env.example and docs/engineering/ENVIRONMENT_VARIABLES.md.`,
    );
  }

  return result.data;
}

export const env: Env = parseEnv(process.env);

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
