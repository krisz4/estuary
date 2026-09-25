import { describe, expect, it } from "vitest";

import {
  ConfigError,
  DEFAULT_ACTOR,
  DEFAULT_API_URL,
  loadConfig,
  projectFromDirectory,
} from "./config.js";

describe("loadConfig", () => {
  it("falls back to localhost and agent:claude-code", () => {
    expect(loadConfig({})).toEqual({
      apiUrl: DEFAULT_API_URL,
      actor: DEFAULT_ACTOR,
      token: undefined,
      defaultProject: undefined,
    });
  });

  it('treats blank values as unset — `${VAR:-}` and empty plugin options arrive as ""', () => {
    const config = loadConfig({
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
    const config = loadConfig({
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
    expect(() => loadConfig({ TASKS_ACTOR: "claude" })).toThrow(ConfigError);
    expect(() => loadConfig({ TASKS_ACTOR: "system:taskmanager" })).toThrow(/TASKS_ACTOR/);
    expect(() => loadConfig({ TASKS_API_URL: "localhost:4000" })).toThrow(/TASKS_API_URL/);
  });

  it("defaults the project to TASKS_DEFAULT_PROJECT, else the project directory's name", () => {
    expect(loadConfig({ CLAUDE_PROJECT_DIR: "/home/me/code/Helpdesk" }).defaultProject).toBe(
      "helpdesk",
    );
    expect(
      loadConfig({ CLAUDE_PROJECT_DIR: "/home/me/code/helpdesk", TASKS_DEFAULT_PROJECT: "Web-App" })
        .defaultProject,
    ).toBe("web-app");
  });
});

describe("projectFromDirectory", () => {
  it("returns undefined rather than guessing at a name that is not a slug", () => {
    expect(projectFromDirectory("/tmp/My Project!")).toBeUndefined();
    expect(projectFromDirectory(undefined)).toBeUndefined();
  });
});
