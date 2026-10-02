import { describe, expect, it } from "vitest";

import { githubImportInputSchema, githubImportKey, parseGithubUrl } from "./github.js";
import { findReferences } from "./reference.js";

describe("parseGithubUrl", () => {
  it("reads pull and issue URLs, ignoring trailing segments", () => {
    expect(parseGithubUrl("https://github.com/krisz4/estuary/pull/123/files")).toEqual({
      owner: "krisz4",
      repo: "estuary",
      kind: "pull",
      number: 123,
    });
    expect(parseGithubUrl("https://github.com/o/r/issues/7#issuecomment-1")?.kind).toBe("issue");
  });

  it("accepts owner/repo#n only when asked", () => {
    expect(parseGithubUrl("o/r#7")).toBeNull();
    expect(parseGithubUrl("o/r#7", true)).toEqual({
      owner: "o",
      repo: "r",
      kind: "issue",
      number: 7,
    });
  });

  it("rejects other hosts and pages", () => {
    expect(parseGithubUrl("https://gitlab.com/o/r/issues/7")).toBeNull();
    expect(parseGithubUrl("https://github.com/o/r/commit/abc")).toBeNull();
  });
});

describe("githubImportInputSchema", () => {
  it("defaults to backlog and refuses todo (an issue has no acceptance criteria)", () => {
    expect(githubImportInputSchema.parse({ issue: "o/r#1" }).status).toBe("backlog");
    expect(githubImportInputSchema.safeParse({ issue: "o/r#1", status: "todo" }).success).toBe(
      false,
    );
  });

  it("refuses a pull request URL", () => {
    expect(
      githubImportInputSchema.safeParse({ issue: "https://github.com/o/r/pull/1" }).success,
    ).toBe(false);
  });

  it("keys imports per issue, case-insensitively", () => {
    expect(githubImportKey({ owner: "O", repo: "R", kind: "issue", number: 3 })).toBe(
      "github:o/r#3",
    );
  });
});

describe("findReferences", () => {
  it("finds references in titles and branch names, deduplicated, in order", () => {
    expect(findReferences("Fix login (TASK-000042), see task-7 and TASK-42")).toEqual([42, 7]);
    expect(findReferences("feat/task-12-labels")).toEqual([12]);
  });

  it("does not read #n or words ending in task as references", () => {
    expect(findReferences("Closes #42")).toEqual([]);
    expect(findReferences("multitask-3")).toEqual([]);
  });
});
