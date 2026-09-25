import { basename } from "node:path";

import { actorSchema, projectSchema } from "@helpdesk/contracts";
import { z } from "zod";

/**
 * The server's whole configuration, read once from the environment at startup.
 *
 * `loadConfig` takes the environment as an argument instead of reading
 * `process.env` itself, so tests build a config from a literal and never depend
 * on what the developer's shell exported. `index.ts` is the only caller that
 * hands it the real environment.
 *
 * Keep this schema, `apps/mcp/env.example`, and
 * `docs/engineering/ENVIRONMENT_VARIABLES.md` § `apps/mcp` in sync.
 */

export const DEFAULT_API_URL = "http://localhost:4000/api/v1";
export const DEFAULT_ACTOR = "agent:claude-code";

/**
 * A blank value is absent. Claude Code substitutes `${VAR:-}` and an unset
 * plugin option as `""`, and `.default()` only fires on `undefined` — without
 * this, an empty `TASKS_ACTOR` would fail the actor regex instead of falling
 * back to `agent:claude-code`.
 */
const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().optional(),
);

const envSchema = z.object({
  /**
   * Base URL including `/api/v1`. The trailing slash is stripped so path joins
   * never produce `//tasks`, which Express would 404.
   */
  TASKS_API_URL: optionalString
    .pipe(
      // `protocol` matters: bare `z.url()` accepts `localhost:4000`, reading "localhost" as the scheme.
      z
        .url({ protocol: /^https?$/, message: "TASKS_API_URL must be an absolute http(s) URL" })
        .optional(),
    )
    .transform((value) => (value ?? DEFAULT_API_URL).replace(/\/+$/, "")),

  /** Validated with the same schema the API applies to `X-Actor`, so a typo fails here, at boot. */
  TASKS_ACTOR: optionalString.pipe(actorSchema.optional()).transform((v) => v ?? DEFAULT_ACTOR),

  TASKS_API_TOKEN: optionalString,

  TASKS_DEFAULT_PROJECT: optionalString.pipe(projectSchema.optional()),

  /** Set by Claude Code in every stdio server's environment: the project root. */
  CLAUDE_PROJECT_DIR: optionalString,
});

export interface Config {
  apiUrl: string;
  actor: string;
  token: string | undefined;
  /**
   * What `task_create` and `task_next` use when the call names no project.
   * `TASKS_DEFAULT_PROJECT`, else the slug of the project directory's name.
   */
  defaultProject: string | undefined;
}

/**
 * `/home/me/code/Helpdesk` → `"helpdesk"`. Returns `undefined` when the name
 * does not survive `projectSchema` (a directory called `My Project!`): guessing a
 * mangled slug would file tasks under a project nobody chose.
 */
export const projectFromDirectory = (dir: string | undefined): string | undefined => {
  if (dir === undefined) return undefined;
  const parsed = projectSchema.safeParse(basename(dir));
  return parsed.success ? parsed.data : undefined;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const loadConfig = (env: Record<string, string | undefined>): Config => {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`);
    throw new ConfigError(`Invalid task manager MCP configuration:\n${lines.join("\n")}`);
  }
  const values = parsed.data;
  return {
    apiUrl: values.TASKS_API_URL,
    actor: values.TASKS_ACTOR,
    token: values.TASKS_API_TOKEN,
    defaultProject: values.TASKS_DEFAULT_PROJECT ?? projectFromDirectory(values.CLAUDE_PROJECT_DIR),
  };
};
