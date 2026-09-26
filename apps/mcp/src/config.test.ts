import { ACTOR_NAME_MAX, ACTOR_PATTERN } from "@helpdesk/contracts";
import { describe, expect, it } from "vitest";

import {
  ConfigError,
  DEFAULT_ACTOR,
  DEFAULT_API_URL,
  deriveActor,
  loadConfig,
  mainCheckoutName,
  parseRemoteUrl,
  projectFromDirectory,
  type GitInfo,
  worktreeName,
} from "./config.js";

/** No git at all: the tests never shell out. */
const noGit = () => ({});
const load = (env: Record<string, string | undefined>, info: GitInfo = {}) =>
  loadConfig(env, { gitInfo: () => info, cwd: "/nowhere" });

const MAIN: GitInfo = {
  originUrl: "git@github.com:krisz4/Helpdesk.git",
  gitDir: "/home/me/code/helpdesk/.git",
  commonDir: "/home/me/code/helpdesk/.git",
  topLevel: "/home/me/code/helpdesk",
};
const WORKTREE: GitInfo = {
  ...MAIN,
  gitDir: "/home/me/code/helpdesk/.git/worktrees/agent-a1b2",
  topLevel: "/home/me/code/helpdesk/.claude/worktrees/agent-a1b2",
};

describe("loadConfig", () => {
  it("falls back to localhost and agent:claude-code when nothing can be derived", () => {
    expect(loadConfig({}, { gitInfo: noGit })).toEqual({
      apiUrl: DEFAULT_API_URL,
      actor: DEFAULT_ACTOR,
      token: undefined,
      defaultProject: undefined,
      githubRepo: undefined,
    });
  });

  it('treats blank values as unset — `${VAR:-}` and empty plugin options arrive as ""', () => {
    const config = load({
      TASKS_API_URL: "",
      TASKS_ACTOR: " ",
      TASKS_API_TOKEN: "",
      TASKS_DEFAULT_PROJECT: "",
    });
    expect(config).toMatchObject({
      apiUrl: DEFAULT_API_URL,
      actor: DEFAULT_ACTOR,
      token: undefined,
    });
  });

  it("strips trailing slashes and canonicalises the actor like the API does", () => {
    const config = load({
      TASKS_API_URL: "https://tasks.example.com/api/v1/",
      TASKS_ACTOR: "Agent:Codex",
      TASKS_API_TOKEN: "t0ken",
    });
    expect(config).toMatchObject({
      apiUrl: "https://tasks.example.com/api/v1",
      actor: "agent:codex",
      token: "t0ken",
    });
  });

  it("rejects an actor the API would reject, naming the variable", () => {
    expect(() => load({ TASKS_ACTOR: "claude" })).toThrow(ConfigError);
    expect(() => load({ TASKS_ACTOR: "system:taskmanager" })).toThrow(/TASKS_ACTOR/);
    expect(() => load({ TASKS_API_URL: "localhost:4000" })).toThrow(/TASKS_API_URL/);
  });

  it("runs git in CLAUDE_PROJECT_DIR, else the given cwd", () => {
    const seen: string[] = [];
    const gitInfo = (cwd: string) => (seen.push(cwd), {});
    loadConfig({ CLAUDE_PROJECT_DIR: "/code/app" }, { gitInfo, cwd: "/elsewhere" });
    loadConfig({}, { gitInfo, cwd: "/elsewhere" });
    expect(seen).toEqual(["/code/app", "/elsewhere"]);
  });

  describe("default project", () => {
    it("prefers TASKS_DEFAULT_PROJECT over everything git says", () => {
      expect(load({ TASKS_DEFAULT_PROJECT: "Web-App" }, WORKTREE).defaultProject).toBe("web-app");
    });

    it("uses origin's repository name, the same in every worktree", () => {
      const env = { CLAUDE_PROJECT_DIR: WORKTREE.topLevel };
      expect(load(env, WORKTREE).defaultProject).toBe("helpdesk");
      expect(load({ CLAUDE_PROJECT_DIR: MAIN.topLevel }, MAIN).defaultProject).toBe("helpdesk");
    });

    it("without a remote, uses the main checkout's directory — not the worktree's", () => {
      const env = { CLAUDE_PROJECT_DIR: WORKTREE.topLevel };
      expect(load(env, { ...WORKTREE, originUrl: undefined }).defaultProject).toBe("helpdesk");
    });

    it("falls through a remote name that is not a slug", () => {
      const info = { ...MAIN, originUrl: "https://example.com/team/My%20Repo.git" };
      expect(load({}, info).defaultProject).toBe("helpdesk");
    });

    it("without git, uses the project directory's name (today's behaviour)", () => {
      expect(load({ CLAUDE_PROJECT_DIR: "/home/me/code/Helpdesk" }).defaultProject).toBe(
        "helpdesk",
      );
      expect(load({ CLAUDE_PROJECT_DIR: "/tmp/My Project!" }).defaultProject).toBeUndefined();
    });
  });

  describe("actor", () => {
    it("is per checkout when TASKS_ACTOR is unset", () => {
      expect(load({}, MAIN).actor).toBe("agent:claude-code@helpdesk");
      expect(load({}, WORKTREE).actor).toBe("agent:claude-code@helpdesk/agent-a1b2");
    });

    it("is stable across restarts of the same checkout", () => {
      expect(load({}, WORKTREE).actor).toBe(load({}, WORKTREE).actor);
    });

    it("follows TASKS_DEFAULT_PROJECT, and an explicit TASKS_ACTOR still wins", () => {
      expect(load({ TASKS_DEFAULT_PROJECT: "web" }, MAIN).actor).toBe("agent:claude-code@web");
      expect(load({ TASKS_ACTOR: "agent:ci" }, WORKTREE).actor).toBe("agent:ci");
    });

    it("exposes origin's GitHub owner/repo", () => {
      expect(load({}, MAIN).githubRepo).toBe("krisz4/Helpdesk");
      expect(load({}, { ...MAIN, originUrl: "git@gitlab.com:a/b.git" }).githubRepo).toBeUndefined();
    });
  });
});

describe("parseRemoteUrl", () => {
  it.each([
    ["git@github.com:owner/repo.git", "repo", "owner/repo"],
    ["git@github.com:owner/repo", "repo", "owner/repo"],
    ["https://github.com/owner/repo", "repo", "owner/repo"],
    ["https://github.com/owner/repo.git", "repo", "owner/repo"],
    ["https://github.com/owner/repo/", "repo", "owner/repo"],
    ["https://user:tok@github.com/owner/repo.git", "repo", "owner/repo"],
    ["ssh://git@github.com/owner/repo.git", "repo", "owner/repo"],
    ["ssh://git@github.com:22/owner/repo.git", "repo", "owner/repo"],
    ["git@gitlab.com:group/sub/repo.git", "repo", undefined],
    ["https://gitlab.com/group/sub/repo.git", "repo", undefined],
    ["/srv/git/repo.git", "repo", undefined],
    ["file:///srv/git/repo.git", "repo", undefined],
    ["../repo", "repo", undefined],
  ])("%s → %s", (url, repo, githubRepo) => {
    expect(parseRemoteUrl(url)).toEqual({ repo, githubRepo });
  });

  it("returns undefined when there is no name to read", () => {
    expect(parseRemoteUrl("")).toBeUndefined();
    expect(parseRemoteUrl("https://github.com/")).toBeUndefined();
  });
});

describe("git helpers", () => {
  it("mainCheckoutName reads the common git dir", () => {
    expect(mainCheckoutName("/code/helpdesk/.git")).toBe("helpdesk");
    expect(mainCheckoutName("/srv/helpdesk.git")).toBe("helpdesk");
    expect(mainCheckoutName("/code/super/.git/modules/sub")).toBeUndefined();
    expect(mainCheckoutName(undefined)).toBeUndefined();
  });

  it("worktreeName is set only inside a linked worktree", () => {
    expect(worktreeName(MAIN)).toBeUndefined();
    expect(worktreeName(WORKTREE)).toBe("agent-a1b2");
    expect(worktreeName({})).toBeUndefined();
  });

  it("projectFromDirectory returns undefined rather than guessing at a name that is not a slug", () => {
    expect(projectFromDirectory("/tmp/My Project!")).toBeUndefined();
    expect(projectFromDirectory(undefined)).toBeUndefined();
  });
});

describe("deriveActor", () => {
  it("falls back to the plain default without a project", () => {
    expect(deriveActor(undefined, "wt")).toBe(DEFAULT_ACTOR);
  });

  it("slugs the worktree name", () => {
    expect(deriveActor("helpdesk", "Feature Branch!")).toBe(
      "agent:claude-code@helpdesk/feature-branch",
    );
  });

  it("stays within ACTOR_PATTERN and keeps long names distinct", () => {
    const project = "p".repeat(64);
    const a = deriveActor(project, "worktree-one");
    const b = deriveActor(project, "worktree-two");
    for (const actor of [a, b]) {
      expect(actor).toMatch(ACTOR_PATTERN);
      expect(actor.length - "agent:".length).toBeLessThanOrEqual(ACTOR_NAME_MAX);
    }
    expect(a).not.toBe(b);
    expect(deriveActor(project, "worktree-one")).toBe(a);
  });
});
