import { TASK_IDEMPOTENCY_KEY_MAX } from "@estuary/contracts";
import { describe, expect, it } from "vitest";

import { deriveIdempotencyKey } from "./idempotency.js";

describe("deriveIdempotencyKey", () => {
  it("is stable across case, punctuation, and spacing — the same task written twice", () => {
    expect(deriveIdempotencyKey("estuary", "Fix flaky login test")).toBe(
      "mcp:estuary:fix-flaky-login-test",
    );
    expect(deriveIdempotencyKey("estuary", "  fix flaky  login test. ")).toBe(
      "mcp:estuary:fix-flaky-login-test",
    );
  });

  it("scopes by project, with a placeholder when there is none", () => {
    expect(deriveIdempotencyKey("web", "Fix flaky login test")).not.toBe(
      deriveIdempotencyKey("api", "Fix flaky login test"),
    );
    expect(deriveIdempotencyKey(null, "Fix flaky login test")).toBe(
      "mcp:no-project:fix-flaky-login-test",
    );
  });

  it("stays within the contract's length bound and keeps long titles distinct", () => {
    const project = "p".repeat(64);
    const a = deriveIdempotencyKey(project, `${"long shared prefix ".repeat(6)}ending one`);
    const b = deriveIdempotencyKey(project, `${"long shared prefix ".repeat(6)}ending two`);
    expect(a.length).toBeLessThanOrEqual(TASK_IDEMPOTENCY_KEY_MAX);
    expect(b.length).toBeLessThanOrEqual(TASK_IDEMPOTENCY_KEY_MAX);
    expect(a).not.toBe(b);
  });

  it("hashes a title with no ASCII letters or digits instead of producing an empty key", () => {
    expect(deriveIdempotencyKey("estuary", "修复登录页面")).toMatch(/^mcp:estuary:[0-9a-f]{32}$/);
  });
});
