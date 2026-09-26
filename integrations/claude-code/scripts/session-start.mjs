#!/usr/bin/env node
/**
 * SessionStart hook: tells the agent, before its first turn, which tasks it
 * still holds and how many are waiting on a human — so a resumed or restarted
 * session picks its claimed work back up instead of leaving it to expire.
 *
 * Plain text on stdout becomes context for Claude. **It must never get in the
 * way of a session**: any failure (API down, bad config, slow network) exits 0
 * with no output. The MCP tools report connection problems properly when the
 * agent actually uses them.
 *
 * No dependencies — Node's global `fetch` and `node:*` only — so it runs from
 * the plugin directory as-is. The actor and project are derived exactly like
 * the MCP server derives them (`apps/mcp/src/config.ts`); see the twin note below.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const TIMEOUT_MS = 2500;

/** Plugin options arrive as CLAUDE_PLUGIN_OPTION_*; plain TASKS_* works for manual setups. */
const setting = (option, envName, fallback) => {
  for (const value of [process.env[`CLAUDE_PLUGIN_OPTION_${option}`], process.env[envName]]) {
    if (value !== undefined && value.trim() !== "" && !/^\$\{[^}]*\}$/.test(value.trim()))
      return value.trim();
  }
  return fallback;
};

const apiUrl = setting("API_URL", "TASKS_API_URL", "http://localhost:4000/api/v1").replace(
  /\/+$/,
  "",
);
const explicitActor = setting("ACTOR", "TASKS_ACTOR", undefined)?.toLowerCase();
const token = setting("API_TOKEN", "TASKS_API_TOKEN", undefined);

const readHookInput = () => {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
};

const getJson = async (path, actor) => {
  const headers = { Accept: "application/json", "X-Actor": actor };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${apiUrl}${path}`, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

/* ------------------------------------------------------------------ *
 * Default project and actor.
 *
 * TWIN of `apps/mcp/src/config.ts` (resolveDefaultProject, deriveActor,
 * parseRemoteUrl, …): this hook must derive exactly what the MCP server does,
 * or "tasks you still hold" would look up the wrong actor. It is duplicated
 * rather than imported because the hook has no dependencies and no build.
 * ------------------------------------------------------------------ */

const ACTOR_NAME_MAX = 64;
const ACTOR_PATTERN = new RegExp(`^(human|agent):[a-z0-9][a-z0-9._@/-]{0,${ACTOR_NAME_MAX - 1}}$`);
const DEFAULT_ACTOR = "agent:claude-code";

/** Same rule as `projectSchema` in packages/contracts: a lowercase slug, or nothing. */
const slug = (value) => {
  if (typeof value !== "string") return undefined;
  const name = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) ? name : undefined;
};

const git = (cwd, args) => {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
};

const readGitInfo = (cwd) => {
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

/** The repository's name from a remote URL (scp-like, URL, or local path). */
const repoFromRemote = (url) => {
  const trimmed = (url ?? "").trim();
  if (trimmed === "") return undefined;
  let path = trimmed;
  const scpLike = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(trimmed);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      path = decodeURIComponent(new URL(trimmed).pathname);
    } catch {
      return undefined;
    }
  } else if (scpLike !== null && !/^[a-z]:[\\/]/i.test(trimmed)) {
    path = scpLike[2];
  }
  const last = path
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "")
    .at(-1)
    ?.replace(/\.git$/i, "");
  return last === "" ? undefined : last;
};

const mainCheckoutName = (commonDir) => {
  if (commonDir === undefined) return undefined;
  const name = basename(commonDir);
  if (name === ".git") return basename(dirname(commonDir));
  if (/\.git$/i.test(name)) return name.replace(/\.git$/i, "");
  return undefined;
};

const worktreeName = (info) => {
  if (info.gitDir === undefined || info.commonDir === undefined || info.topLevel === undefined)
    return undefined;
  return resolve(info.gitDir) === resolve(info.commonDir) ? undefined : basename(info.topLevel);
};

const deriveActor = (project, worktree) => {
  if (project === undefined) return DEFAULT_ACTOR;
  const tree =
    worktree === undefined
      ? ""
      : worktree
          .toLowerCase()
          .replace(/[^a-z0-9._@-]+/g, "-")
          .replace(/^-+|-+$/g, "");
  let name = `claude-code@${project}${tree === "" ? "" : `/${tree}`}`;
  if (name.length > ACTOR_NAME_MAX) {
    const hash = createHash("sha256").update(name).digest("hex").slice(0, 6);
    name = `${name.slice(0, ACTOR_NAME_MAX - 7)}-${hash}`;
  }
  const actor = `agent:${name}`;
  return ACTOR_PATTERN.test(actor) ? actor : DEFAULT_ACTOR;
};

const main = async () => {
  const input = readHookInput();
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd;
  const info = readGitInfo(projectDir ?? process.cwd());
  const worktree = worktreeName(info);
  // TASKS_DEFAULT_PROJECT → origin's repo name → main checkout's directory → project directory.
  const project =
    slug(setting("DEFAULT_PROJECT", "TASKS_DEFAULT_PROJECT", undefined)) ??
    slug(repoFromRemote(info.originUrl)) ??
    slug(mainCheckoutName(info.commonDir)) ??
    (typeof projectDir === "string" && projectDir !== "" ? slug(basename(projectDir)) : undefined);
  const actor = explicitActor ?? deriveActor(project, worktree);

  // `claimedBy` matches the stored holder even after the lease lapsed, so the
  // live-claim check stays here. One page of 100 is plenty.
  const [inProgress, stats] = await Promise.all([
    getJson(
      `/tasks?status=in_progress&claimedBy=${encodeURIComponent(actor)}&pageSize=100&sort=updatedAt:desc`,
      actor,
    ),
    getJson("/tasks/stats", actor),
  ]);
  const mine = inProgress.data.filter((task) => task.claim?.actor === actor);

  const lines = [
    `Task manager: ${apiUrl}, acting as ${actor}` +
      (explicitActor === undefined
        ? ` (derived per checkout${worktree === undefined ? "" : ` — worktree ${worktree}`}; set TASKS_ACTOR to override).`
        : ".") +
      (project === undefined ? "" : ` Use project "${project}" for tasks in this repository.`),
  ];
  if (mine.length > 0) {
    lines.push(`You still hold ${mine.length} claimed task(s):`);
    for (const task of mine) {
      lines.push(
        `- ${task.reference} ${task.title} (project ${task.project ?? "none"}, lease until ${task.claim.expiresAt})`,
      );
    }
    lines.push(
      "Resume each one (task_get, then task_heartbeat while working) or hand it off / task_release it — never leave it idle.",
    );
  }
  if (stats.needsAttention > 0) {
    lines.push(
      `${stats.needsAttention} task(s) are waiting on a human (needs_user_decision, needs_user_action, needs_qa).`,
    );
  }
  lines.push("Follow the task-workflow skill when working tasks.");
  process.stdout.write(`${lines.join("\n")}\n`);
};

try {
  await main();
} catch {
  // Unreachable, unauthorized, or malformed: stay silent, never block the session.
}
process.exit(0);
