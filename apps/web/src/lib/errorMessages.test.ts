import { API_ERROR_CODES } from "@helpdesk/contracts";
import { describe, expect, it } from "vitest";
import { ApiClientError, CLIENT_ERROR_CODES } from "@/api/http";
import {
  allowedTransitionsFrom,
  errorCopy,
  errorRequestId,
  GENERIC_ERROR,
  NON_FIELD_DETAIL_KEY,
  splitValidationErrors,
} from "@/lib/errorMessages";

const clientError = (code: string, details?: unknown, requestId?: string) =>
  new ApiClientError({
    code: code as never,
    message: "RAW SERVER TEXT THAT MUST NOT REACH A USER",
    details,
    requestId,
    status: 400,
  });

describe("errorCopy", () => {
  it.each([...API_ERROR_CODES, ...CLIENT_ERROR_CODES])("has copy for %s", (code) => {
    // Compared against the contract's own list rather than against this
    // module's keys — comparing a table to itself cannot fail. Adding a code
    // API-side and forgetting the copy fails here.
    const copy = errorCopy(clientError(code));
    expect(copy).not.toBe(GENERIC_ERROR);
    expect(copy.title.length).toBeGreaterThan(0);
    expect(copy.description.length).toBeGreaterThan(0);
  });

  it("falls back to generic for an unrecognised code, never the server's message", () => {
    const copy = errorCopy(clientError("SOME_FUTURE_CODE"));
    expect(copy).toBe(GENERIC_ERROR);
    expect(copy.description).not.toContain("RAW SERVER TEXT");
  });

  it("falls back to generic for a value that is not an ApiClientError at all", () => {
    expect(errorCopy(new TypeError("undefined is not a function"))).toBe(GENERIC_ERROR);
    expect(errorCopy("a string")).toBe(GENERIC_ERROR);
    expect(errorCopy(undefined)).toBe(GENERIC_ERROR);
  });

  it("marks 404s and 422s as non-retryable and transport failures as retryable", () => {
    expect(errorCopy(clientError("TICKET_NOT_FOUND")).retryable).toBe(false);
    expect(errorCopy(clientError("VALIDATION_ERROR")).retryable).toBe(false);
    expect(errorCopy(clientError("NETWORK_ERROR")).retryable).toBe(true);
    expect(errorCopy(clientError("INTERNAL_ERROR")).retryable).toBe(true);
  });
});

describe("errorRequestId", () => {
  it("returns the id when there is one, and undefined otherwise", () => {
    expect(errorRequestId(clientError("INTERNAL_ERROR", undefined, "req-9"))).toBe("req-9");
    expect(errorRequestId(new Error("boom"))).toBeUndefined();
  });
});

describe("allowedTransitionsFrom", () => {
  it("reads details.allowed for INVALID_STATUS_TRANSITION", () => {
    const error = clientError("INVALID_STATUS_TRANSITION", {
      from: "closed",
      to: "resolved",
      allowed: ["open", "in_progress"],
    });
    expect(allowedTransitionsFrom(error)).toEqual(["open", "in_progress"]);
  });

  it("is undefined for any other code, even with a matching details shape", () => {
    const error = clientError("VALIDATION_ERROR", { allowed: ["open"] });
    expect(allowedTransitionsFrom(error)).toBeUndefined();
  });
});

describe("splitValidationErrors", () => {
  const FIELDS = ["title", "description", "assignee"] as const;

  it("maps known fields onto fields", () => {
    const error = clientError("VALIDATION_ERROR", {
      title: ["Title must be at least 5 characters"],
    });

    expect(splitValidationErrors(error, FIELDS)).toEqual({
      fieldErrors: { title: ["Title must be at least 5 characters"] },
      formErrors: [],
    });
  });

  it('routes the "_" key to the form summary, not to a field', () => {
    // The stage-8 constraint: an unknown query parameter is reported by zod
    // with an empty path, and errorHandler files pathless issues under `_`.
    // A form that called setError("_", …) would highlight nothing at all —
    // react-hook-form drops errors for names it has not registered.
    const error = clientError("VALIDATION_ERROR", {
      [NON_FIELD_DETAIL_KEY]: ['Unrecognized key: "utm_source"'],
    });

    const result = splitValidationErrors(error, FIELDS);
    expect(result.fieldErrors).toEqual({});
    expect(result.formErrors).toEqual(['Unrecognized key: "utm_source"']);
  });

  it("routes a server field this form does not render to the summary too", () => {
    const error = clientError("VALIDATION_ERROR", {
      title: ["too short"],
      requesterEmail: ["Enter a valid email address"],
    });

    const result = splitValidationErrors(error, ["title"]);
    expect(result.fieldErrors).toEqual({ title: ["too short"] });
    expect(result.formErrors).toEqual(["Enter a valid email address"]);
  });

  it("is empty for a non-validation error and for a non-error value", () => {
    expect(splitValidationErrors(clientError("TICKET_NOT_FOUND"), FIELDS)).toEqual({
      fieldErrors: {},
      formErrors: [],
    });
    expect(splitValidationErrors(new Error("boom"), FIELDS)).toEqual({
      fieldErrors: {},
      formErrors: [],
    });
  });

  it("ignores a details payload whose values are not string arrays", () => {
    const error = clientError("VALIDATION_ERROR", { title: "not an array" });
    expect(splitValidationErrors(error, FIELDS)).toEqual({ fieldErrors: {}, formErrors: [] });
  });
});
