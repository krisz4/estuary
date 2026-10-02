import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";

import { ACTOR_NAME_MAX, ACTOR_PATTERN, actorSchema, projectSchema } from "@estuary/contracts";
import { z } from "zod";

/**
 * The server's whole configuration, read once from the environment at startup.
 *
 * `loadConfig` takes the environment as an argument instead of reading
 * `process.env` itself, and the git lookups it needs are injected too, so tests
 * build a config from literals and never depend on what the developer's shell
 * exported or which checkout the tests run in. `index.ts` is the only caller
 * that hands it the real environment.
 *
 * **Twin:** `integrations/claude-code/scripts/session-start.mjs` derives the
 * same default project and actor without dependencies (it lists "tasks you still
 * hold" by actor). Change the derivation in both places.
 *
 * Keep this schema, `apps/mcp/env.example`, and
 * `docs/engineering/ENVIRONMENT_VARIABLES.md` § `apps/mcp` in sync.
 */

export const DEFAULT_API_URL = "http://localhost:4000/api/v1";
/** The actor when nothing better can be derived (no project could be resolved). */
export const DEFAULT_ACTOR = "agent:claude-code";
const ACTOR_BASE_NAME = "claude-code";

/**
 * A blank value is absent. Claude Code substitutes `${VAR:-}` and an unset
 * plugin option as `""`, and `.default()` only fires on `undefined` — without
 * this, an empty `TASKS_ACTOR` would fail the actor regex instead of falling
 * back to the derived default.
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
  TASKS_ACTOR: optionalString.pipe(actorSchema.optional()),

  TASKS_API_TOKEN: optionalString,

  TASKS_DEFAULT_PROJECT: optionalString.pipe(projectSchema.optional()),

  /** Set by Claude Code in every stdio server's environment: the project root. */
  CLAUDE_PROJECT_DIR: optionalString,
});

export interface Config {
  apiUrl: string;
  /**
   * `TASKS_ACTOR`, else derived from the checkout — see `deriveActor`.
   */
  actor: string;
  token: string | undefined;
  /**
   * What `task_create` and `task_next` use when the call names no project.
   * See `resolveDefaultProject` for the order.
   */
  defaultProject: string | undefined;
  /** `owner/repo` of the `origin` remote, when it is on GitHub. */
  githubRepo?: string | undefined;
}

/* ------------------------------------------------------------------ *
 * Git
 * ------------------------------------------------------------------ */

/** What the derivation needs from git. Every field is absent when git could not say. */
export interface GitInfo {
  /** `git remote get-url origin`. */
  originUrl?: string | undefined;
  /** `git rev-parse --path-format=absolute --git-common-dir` — the same for every worktree. */
  commonDir?: string | undefined;
  /** `git rev-parse --path-format=absolute --git-dir` — differs from `commonDir` inside a linked worktree. */
  gitDir?: string | undefined;
  /** `git rev-parse --show-toplevel` — the root of this checkout (worktree). */
  topLevel?: string | undefined;
}

export type GitInfoLookup = (cwd: string) => GitInfo;

const GIT_TIMEOUT_MS = 1500;

const git = (cwd: string, args: string[]): string | undefined => {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    return out === "" ? undefined : out;
  } catch {
    // No git, not a repository, no remote, a missing cwd: all mean "git cannot say".
    return undefined;
  }
};

/** The real lookup: two `git` calls, every failure swallowed. */
export const readGitInfo: GitInfoLookup = (cwd) => {
  const [gitDir, commonDir, topLevel] = (
    git(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
      "--show-toplevel",
    ]) ?? ""
  ).split("\n");
  return {
    originUrl: git(cwd, ["remote", "get-url", "origin"]),
    gitDir: gitDir || undefined,
    commonDir: commonDir || undefined,
    topLevel: topLevel || undefined,
  };
};

export interface RemoteInfo {
  /** The repository's name, `.git` stripped: `estuary`. */
  repo: string;
  /** `owner/repo`, only when the remote is on github.com. */
  githubRepo?: string | undefined;
}

/**
 * `git@github.com:owner/repo.git`, `https://github.com/owner/repo(.git)`,
 * `ssh://git@github.com[:22]/owner/repo.git`, `/srv/git/repo.git` → the repo's
 * name, plus `owner/repo` when the host is GitHub. `undefined` when no name
 * can be read.
 */
export const parseRemoteUrl = (url: string): RemoteInfo | undefined => {
  const trimmed = url.trim();
  if (trimmed === "") return undefined;

  let host: string | undefined;
  let path: string;
  const scpLike = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(trimmed);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      host = parsed.hostname.toLowerCase();
      path = decodeURIComponent(parsed.pathname);
    } catch {
      return undefined;
    }
  } else if (scpLike !== null && !/^[a-z]:[\\/]/i.test(trimmed)) {
    // scp-like syntax; a Windows drive path (`C:\repo`) is not one.
    host = scpLike[1]!.toLowerCase();
    path = scpLike[2]!;
  } else {
    path = trimmed; // A local path.
  }

  const segments = path
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "");
  const last = segments.at(-1)?.replace(/\.git$/i, "");
  if (last === undefined || last === "") return undefined;

  const onGithub = host === "github.com" || host === "www.github.com";
  const githubRepo = onGithub && segments.length === 2 ? `${segments[0]}/${last}` : undefined;
  return { repo: last, githubRepo };
};

/* ------------------------------------------------------------------ *
 * Project and actor
 * ------------------------------------------------------------------ */

const slug = (candidate: string | undefined): string | undefined => {
  if (candidate === undefined) return undefined;
  const parsed = projectSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
};

/**
 * `/home/me/code/Estuary` → `"estuary"`. Returns `undefined` when the name
 * does not survive `projectSchema` (a directory called `My Project!`): guessing a
 * mangled slug would file tasks under a project nobody chose.
 */
export const projectFromDirectory = (dir: string | undefined): string | undefined =>
  dir === undefined ? undefined : slug(basename(dir));

/**
 * The main checkout's directory, from the common git dir every worktree shares:
 * `/code/estuary/.git` → `estuary`; a bare `/srv/estuary.git` → `estuary`.
 * Anything else (a submodule's `.git/modules/x`) says nothing reliable.
 */
export const mainCheckoutName = (commonDir: string | undefined): string | undefined => {
  if (commonDir === undefined) return undefined;
  const name = basename(commonDir);
  if (name === ".git") return basename(dirname(commonDir));
  if (/\.git$/i.test(name)) return name.replace(/\.git$/i, "");
  return undefined;
};

/** Inside a linked worktree: its directory name. `undefined` in a main checkout. */
export const worktreeName = (info: GitInfo): string | undefined => {
  if (info.gitDir === undefined || info.commonDir === undefined || info.topLevel === undefined)
    return undefined;
  if (resolve(info.gitDir) === resolve(info.commonDir)) return undefined;
  return basename(info.topLevel);
};

/**
 * The default project, first that yields a valid slug:
 *
 * 1. `TASKS_DEFAULT_PROJECT`;
 * 2. the repository name of `origin` — the same in every clone and worktree;
 * 3. the main checkout's directory name (parent of the common git dir), so a
 *    worktree at `.claude/worktrees/agent-a1b2` still resolves to `estuary`;
 * 4. the project directory's name.
 */
export const resolveDefaultProject = (
  explicit: string | undefined,
  info: GitInfo,
  projectDir: string | undefined,
): string | undefined => {
  if (explicit !== undefined) return explicit;
  const remote = info.originUrl === undefined ? undefined : parseRemoteUrl(info.originUrl);
  return (
    slug(remote?.repo) ?? slug(mainCheckoutName(info.commonDir)) ?? projectFromDirectory(projectDir)
  );
};

const ACTOR_HASH_LENGTH = 6;

/**
 * The actor when `TASKS_ACTOR` is unset — one per checkout, so two sessions in
 * two worktrees cannot take over each other's claims:
 *
 * - `agent:claude-code@estuary` in a main checkout;
 * - `agent:claude-code@estuary/agent-a1b2` in a linked worktree.
 *
 * Stable across restarts of the same checkout (so a resumed session still owns
 * its claims). Two sessions in the **same** checkout still share it.
 *
 * A name past `ACTOR_NAME_MAX` is cut and suffixed with a hash of the whole
 * name, so two long worktree names sharing a prefix stay distinct.
 */
export const deriveActor = (project: string | undefined, worktree: string | undefined): string => {
  if (project === undefined) return DEFAULT_ACTOR;
  const tree =
    worktree === undefined
      ? ""
      : worktree
          .toLowerCase()
          .replace(/[^a-z0-9._@-]+/g, "-")
          .replace(/^-+|-+$/g, "");
  let name = `${ACTOR_BASE_NAME}@${project}${tree === "" ? "" : `/${tree}`}`;
  if (name.length > ACTOR_NAME_MAX) {
    const hash = createHash("sha256").update(name).digest("hex").slice(0, ACTOR_HASH_LENGTH);
    name = `${name.slice(0, ACTOR_NAME_MAX - ACTOR_HASH_LENGTH - 1)}-${hash}`;
  }
  const actor = `agent:${name}`;
  // Belt and braces: every part is already a slug, but a derived actor the API
  // would reject must never be what stops the server from starting.
  return ACTOR_PATTERN.test(actor) ? actor : DEFAULT_ACTOR;
};

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface LoadConfigOptions {
  /** Defaults to running `git`; tests pass a literal. */
  gitInfo?: GitInfoLookup;
  /** Where git runs when `CLAUDE_PROJECT_DIR` is unset. Defaults to `process.cwd()`. */
  cwd?: string;
}

export const loadConfig = (
  env: Record<string, string | undefined>,
  { gitInfo = readGitInfo, cwd = process.cwd() }: LoadConfigOptions = {},
): Config => {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`);
    throw new ConfigError(`Invalid task manager MCP configuration:\n${lines.join("\n")}`);
  }
  const values = parsed.data;
  const info = gitInfo(values.CLAUDE_PROJECT_DIR ?? cwd);
  const defaultProject = resolveDefaultProject(
    values.TASKS_DEFAULT_PROJECT,
    info,
    values.CLAUDE_PROJECT_DIR,
  );
  const remote = info.originUrl === undefined ? undefined : parseRemoteUrl(info.originUrl);
  return {
    apiUrl: values.TASKS_API_URL,
    actor: values.TASKS_ACTOR ?? deriveActor(defaultProject, worktreeName(info)),
    token: values.TASKS_API_TOKEN,
    defaultProject,
    githubRepo: remote?.githubRepo,
  };
};
