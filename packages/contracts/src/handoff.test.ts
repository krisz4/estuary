import { describe, expect, it } from "vitest";
import {
  hasPassingVerification,
  qualifiesForVerified,
  verificationSchema,
  checkpointSchema,
  claimSessionIdSchema,
} from "./handoff.js";
const evidence = {
  commit: "abcdef1234567",
  checks: [{ command: "pnpm test", result: "passed" as const }],
  criteria: [{ criterion: "Works as specified", result: "passed" as const }],
};
describe("handoff evidence", () => {
  it("requires both checked criteria and passing commands for batch approval", () => {
    expect(hasPassingVerification(evidence)).toBe(true);
    expect(hasPassingVerification(null)).toBe(false);
    expect(
      hasPassingVerification({
        ...evidence,
        checks: [{ command: "pnpm test", result: "not_run" }],
      }),
    ).toBe(false);
    expect(
      hasPassingVerification({ ...evidence, criteria: [{ criterion: "Works", result: "failed" }] }),
    ).toBe(false);
    expect(verificationSchema.safeParse({ ...evidence, checks: [] }).success).toBe(false);
  });
  it("qualifies for verified only with passing results and a qa record", () => {
    const device = {
      method: "device" as const,
      target: "Pixel 8 emulator",
      scenarios: [{ scenario: "Open the inbox", result: "passed" as const }],
    };
    expect(qualifiesForVerified(evidence)).toBe(false);
    expect(qualifiesForVerified({ ...evidence, qa: device })).toBe(true);
    expect(
      qualifiesForVerified({ ...evidence, qa: { method: "not_needed", reason: "API-only" } }),
    ).toBe(true);
    const failed = { ...device, scenarios: [{ scenario: "Open", result: "failed" as const }] };
    expect(qualifiesForVerified({ ...evidence, qa: failed })).toBe(false);
    expect(hasPassingVerification({ ...evidence, qa: failed })).toBe(false);
  });
  it("bounds session identifiers and requires usable resume instructions", () => {
    expect(claimSessionIdSchema.safeParse("session:codex-1").success).toBe(true);
    expect(claimSessionIdSchema.safeParse("new\nheader").success).toBe(false);
    expect(
      checkpointSchema.safeParse({
        completed: "Implemented the request",
        remaining: "Run the test suite",
      }).success,
    ).toBe(true);
    expect(checkpointSchema.safeParse({ completed: "", remaining: "" }).success).toBe(false);
  });
});
