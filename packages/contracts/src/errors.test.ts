import { describe, expect, it } from "vitest";
import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  apiErrorResponseSchema,
  claimConflictDetailsSchema,
  dependencyCycleDetailsSchema,
  isApiErrorCode,
  validationErrorDetailsSchema,
  versionConflictDetailsSchema,
} from "./errors.js";

describe("ApiErrorCode", () => {
  it("matches the code table in API_ERROR_CONTRACT.md exactly", () => {
    // Transcribed from docs/engineering/API_ERROR_CONTRACT.md. If this fails,
    // the doc and the union have diverged — fix whichever one is wrong, do not
    // relax the assertion.
    expect([...API_ERROR_CODES]).toEqual([
      "VALIDATION_ERROR",
      "AT_LEAST_ONE_FIELD",
      "UNAUTHORIZED",
      "ACTOR_NOT_PERMITTED",
      "TASK_NOT_FOUND",
      "COMMENT_NOT_FOUND",
      "VERSION_CONFLICT",
      "TASK_ALREADY_CLAIMED",
      "NOT_CLAIM_HOLDER",
      "DEPENDENCY_CYCLE",
      "NO_OPEN_DECISION",
      "INTEGRATION_NOT_CONFIGURED",
      "INVALID_WEBHOOK_SIGNATURE",
      "GITHUB_NOT_FOUND",
      "GITHUB_UNAVAILABLE",
      "MALFORMED_JSON",
      "PAYLOAD_TOO_LARGE",
      "NOT_FOUND",
      "INTERNAL_ERROR",
    ]);
  });

  it("omits METHOD_NOT_ALLOWED and CONFLICT, which were deliberately removed", () => {
    expect(API_ERROR_CODES).not.toContain("METHOD_NOT_ALLOWED");
    expect(API_ERROR_CODES).not.toContain("CONFLICT");
  });

  it("omits INVALID_STATUS_TRANSITION, retired with the helpdesk lifecycle", () => {
    // What a status requires is now the shape of the transition payload, so a
    // missing reason is a VALIDATION_ERROR on that field — there is no from→to
    // table left to violate.
    expect(API_ERROR_CODES).not.toContain("INVALID_STATUS_TRANSITION");
    expect(isApiErrorCode("INVALID_STATUS_TRANSITION")).toBe(false);
  });

  it("maps every code to the status the contract documents", () => {
    expect(API_ERROR_STATUS).toEqual({
      VALIDATION_ERROR: 422,
      AT_LEAST_ONE_FIELD: 422,
      UNAUTHORIZED: 401,
      ACTOR_NOT_PERMITTED: 403,
      TASK_NOT_FOUND: 404,
      COMMENT_NOT_FOUND: 404,
      VERSION_CONFLICT: 409,
      TASK_ALREADY_CLAIMED: 409,
      NOT_CLAIM_HOLDER: 409,
      DEPENDENCY_CYCLE: 409,
      NO_OPEN_DECISION: 409,
      INTEGRATION_NOT_CONFIGURED: 404,
      INVALID_WEBHOOK_SIGNATURE: 401,
      GITHUB_NOT_FOUND: 404,
      GITHUB_UNAVAILABLE: 502,
      MALFORMED_JSON: 400,
      PAYLOAD_TOO_LARGE: 413,
      NOT_FOUND: 404,
      INTERNAL_ERROR: 500,
    });
  });

  it("narrows an unknown wire value", () => {
    expect(isApiErrorCode("TASK_NOT_FOUND")).toBe(true);
    expect(isApiErrorCode("METHOD_NOT_ALLOWED")).toBe(false);
    expect(isApiErrorCode(404)).toBe(false);
  });
});

describe("apiErrorResponseSchema", () => {
  const envelope = {
    error: {
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
      details: { title: ["Title must be at least 5 characters"] },
      requestId: "8f2c1e44-9b3a-4d51-9f0e-2b7c5a1d3e88",
    },
  };

  it("accepts the documented envelope", () => {
    expect(apiErrorResponseSchema.parse(envelope)).toEqual(envelope);
  });

  it("accepts an envelope without details", () => {
    const { details: _details, ...rest } = envelope.error;
    expect(apiErrorResponseSchema.safeParse({ error: rest }).success).toBe(true);
  });

  it("requires code, message, and requestId", () => {
    for (const key of ["code", "message", "requestId"] as const) {
      const { [key]: _dropped, ...rest } = envelope.error;
      expect(apiErrorResponseSchema.safeParse({ error: rest }).success).toBe(false);
    }
  });

  it("rejects an unknown code so a typo is caught on both sides", () => {
    const result = apiErrorResponseSchema.safeParse({
      error: { ...envelope.error, code: "TOTALLY_MADE_UP" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra keys inside the envelope", () => {
    const result = apiErrorResponseSchema.safeParse({
      error: { ...envelope.error, stack: "Error: at foo.ts:1" },
    });
    expect(result.success).toBe(false);
  });
});

describe("details schemas", () => {
  it("accepts field errors as name → messages", () => {
    expect(validationErrorDetailsSchema.parse({ title: ["too short"] })).toEqual({
      title: ["too short"],
    });
    expect(validationErrorDetailsSchema.safeParse({ title: "too short" }).success).toBe(false);
  });

  it("accepts the { expected, current } version-conflict shape", () => {
    const details = { expected: 3, current: 5 };
    expect(versionConflictDetailsSchema.parse(details)).toEqual(details);
    expect(versionConflictDetailsSchema.safeParse({ expected: "3", current: 5 }).success).toBe(
      false,
    );
    expect(versionConflictDetailsSchema.safeParse({ current: 5 }).success).toBe(false);
    expect(versionConflictDetailsSchema.safeParse({ ...details, taskId: 42 }).success).toBe(false);
  });

  it("accepts the { claimedBy, expiresAt } claim-conflict shape", () => {
    const details = { claimedBy: "agent:claude-code", expiresAt: "2026-09-20T10:30:00.000Z" };
    expect(claimConflictDetailsSchema.parse(details)).toEqual(details);
    expect(
      claimConflictDetailsSchema.safeParse({ ...details, expiresAt: "in 30 minutes" }).success,
    ).toBe(false);
    expect(claimConflictDetailsSchema.safeParse({ claimedBy: details.claimedBy }).success).toBe(
      false,
    );
  });

  it("accepts the { path } dependency-cycle shape, as task ids", () => {
    // 42 → 43 → 44 → 42: the chain that adding the dependency would close.
    const details = { path: [42, 43, 44, 42] };
    expect(dependencyCycleDetailsSchema.parse(details)).toEqual(details);
    expect(
      dependencyCycleDetailsSchema.safeParse({ path: ["TASK-000042", "TASK-000043"] }).success,
    ).toBe(false);
    expect(dependencyCycleDetailsSchema.safeParse({}).success).toBe(false);
  });
});
