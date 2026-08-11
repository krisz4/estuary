import { describe, expect, it } from "vitest";
import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  apiErrorResponseSchema,
  isApiErrorCode,
  statusTransitionErrorDetailsSchema,
  validationErrorDetailsSchema,
} from "./errors.js";

describe("ApiErrorCode", () => {
  it("matches the code table in API_ERROR_CONTRACT.md exactly", () => {
    // Transcribed from docs/engineering/API_ERROR_CONTRACT.md. If this fails,
    // the doc and the union have diverged — fix whichever one is wrong, do not
    // relax the assertion.
    expect([...API_ERROR_CODES]).toEqual([
      "VALIDATION_ERROR",
      "AT_LEAST_ONE_FIELD",
      "TICKET_NOT_FOUND",
      "COMMENT_NOT_FOUND",
      "INVALID_STATUS_TRANSITION",
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

  it("maps every code to the status the contract documents", () => {
    expect(API_ERROR_STATUS).toEqual({
      VALIDATION_ERROR: 422,
      AT_LEAST_ONE_FIELD: 422,
      TICKET_NOT_FOUND: 404,
      COMMENT_NOT_FOUND: 404,
      INVALID_STATUS_TRANSITION: 409,
      MALFORMED_JSON: 400,
      PAYLOAD_TOO_LARGE: 413,
      NOT_FOUND: 404,
      INTERNAL_ERROR: 500,
    });
  });

  it("narrows an unknown wire value", () => {
    expect(isApiErrorCode("TICKET_NOT_FOUND")).toBe(true);
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

  it("accepts the { from, to, allowed } transition shape", () => {
    const details = { from: "closed", to: "resolved", allowed: ["open", "in_progress"] };
    expect(statusTransitionErrorDetailsSchema.parse(details)).toEqual(details);
  });
});
