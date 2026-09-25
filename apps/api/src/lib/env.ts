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
   * Comma-separated CORS allow-list.
   *
   * **Four origins, because a browser sees four.** `localhost` and `127.0.0.1`
   * are different origins, and so are the two ports this app is legitimately
   * served from: `5173` (`vite dev`, and the port compose publishes the web
   * container on) and `4173` (`vite preview`, the production build). Listing
   * fewer is what D21 was: the preview build could not reach the API at all,
   * and the failure surfaced as an opaque network error rather than as anything
   * naming CORS.
   *
   * The E2E suite is **not** among the four. It runs its own API process on its
   * own port and passes `ALLOWED_ORIGINS` explicitly (`e2e/env.ts`), so nothing
   * had to be widened here to accommodate it.
   *
   * The container does not depend on this list. nginx proxies `/api/` to the
   * API on the same origin, so no request the app makes is cross-origin.
   * Neither is Swagger UI: the OpenAPI document declares
   * `servers: [{ url: "/" }]`, so "try it out" resolves against whichever origin
   * served `/docs` and is same-origin on both `:4000` and the proxied `:5173`.
   * What the list still covers is `vite preview` on `:4173` and a web image
   * rebuilt with an absolute `VITE_API_BASE_URL`.
   *
   * This is not an "allow anything local" default: it is four exact origins,
   * and a deployment that serves the app from anywhere else sets the variable.
   */
  ALLOWED_ORIGINS: z
    .string()
    .default(
      "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173",
    )
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

  /**
   * Optional shared secret for self-hosted deployments. When set, every
   * `/api/v1` request must carry `Authorization: Bearer <API_TOKEN>` or gets
   * `UNAUTHORIZED` (401); `/health` and `/docs` stay open. Unset (the default)
   * means no check at all — right for localhost, wrong for anything reachable
   * from a network you do not control.
   *
   * This is a gate, not accounts: one token for every caller, humans and agents
   * alike. Who did what is still the self-declared `X-Actor`.
   *
   * At least 16 characters, so a placeholder like `changeme` fails boot instead
   * of protecting nothing.
   */
  API_TOKEN: z.string().min(16, "API_TOKEN must be at least 16 characters").optional(),

  /**
   * Whether an `agent:` actor may move a task to `done`. Off by default: agents
   * hand finished work to `needs_qa` and a human closes it. Turn it on for a
   * fully autonomous setup where a QA agent does the closing.
   */
  AGENTS_MAY_COMPLETE: booleanFromString(false),

  /**
   * How long a claim lasts without a heartbeat or a write from its holder. Short
   * enough that a crashed agent's task comes back within the working session,
   * long enough that an agent deep in a build does not lose its task.
   */
  CLAIM_LEASE_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
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
