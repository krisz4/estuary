import { API_ERROR_STATUS, type ApiErrorCode } from "@helpdesk/contracts";
import type { ZodError } from "zod";

/**
 * The only error type routes and services throw.
 *
 * Rule from `docs/features/Error_Handling.md`: **errors are thrown, never
 * constructed as responses.** `middleware/errorHandler.ts` is the single place
 * that writes an error body, so nothing here knows about `res`.
 *
 * The code union and its HTTP status both come from `@helpdesk/contracts`, so a
 * typo is a compile error and the status table cannot drift from the client's
 * copy of it.
 */

/** Fallback copy per code. A call site may pass something more specific. */
const DEFAULT_MESSAGE: Record<ApiErrorCode, string> = {
  VALIDATION_ERROR: "Request validation failed",
  AT_LEAST_ONE_FIELD: "Provide at least one field to update",
  TICKET_NOT_FOUND: "Ticket not found",
  COMMENT_NOT_FOUND: "Comment not found",
  INVALID_STATUS_TRANSITION: "That status change is not allowed",
  MALFORMED_JSON: "Request body is not valid JSON",
  PAYLOAD_TOO_LARGE: "Request body is too large",
  NOT_FOUND: "Resource not found",
  INTERNAL_ERROR: "Something went wrong. Please try again",
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message?: string, details?: unknown) {
    super(message ?? DEFAULT_MESSAGE[code]);
    this.name = "ApiError";
    this.code = code;
    this.status = API_ERROR_STATUS[code];
    if (details !== undefined) this.details = details;

    // Without this the stack starts inside the Error constructor on V8.
    Error.captureStackTrace?.(this, ApiError);
  }
}

export const isApiError = (value: unknown): value is ApiError => value instanceof ApiError;

/* ------------------------------------------------------------------ *
 * Factories
 *
 * Thin, but they keep the code strings out of route files and give the
 * two codes that carry structured `details` a typed shape.
 * ------------------------------------------------------------------ */

export const notFoundError = (message?: string) => new ApiError("NOT_FOUND", message);

export const ticketNotFound = (ticketId?: number) =>
  new ApiError(
    "TICKET_NOT_FOUND",
    ticketId === undefined ? undefined : `Ticket ${ticketId} was not found`,
  );

export const commentNotFound = () => new ApiError("COMMENT_NOT_FOUND");

/** `details` shape is pinned by `statusTransitionErrorDetailsSchema` in contracts. */
export const invalidStatusTransition = (from: string, to: string, allowed: readonly string[]) =>
  new ApiError("INVALID_STATUS_TRANSITION", `A ticket cannot move from "${from}" to "${to}"`, {
    from,
    to,
    allowed: [...allowed],
  });

/** `details` shape is pinned by `validationErrorDetailsSchema` in contracts. */
export const validationError = (details: Record<string, string[]>, message?: string) =>
  new ApiError("VALIDATION_ERROR", message, details);

export const atLeastOneField = () => new ApiError("AT_LEAST_ONE_FIELD");

export const malformedJson = () => new ApiError("MALFORMED_JSON");

export const payloadTooLarge = () => new ApiError("PAYLOAD_TOO_LARGE");

/** Rarely thrown directly — anything unrecognised already becomes this. */
export const internalError = () => new ApiError("INTERNAL_ERROR");

/**
 * Structural check for a `ZodError`, not `instanceof`.
 *
 * The schemas that throw live in `@helpdesk/contracts` and are compiled against
 * *that* package's `zod`, while this app resolves its own. pnpm dedupes them to
 * one physical copy today, so `instanceof` happens to hold — but the day the two
 * ranges drift to different minors, every validation failure would silently fall
 * through to `INTERNAL_ERROR` 500 instead of `VALIDATION_ERROR` 422. A 500 in
 * place of a 422 is exactly the kind of regression that ships unnoticed.
 */
export const isZodError = (err: unknown): err is ZodError => {
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as { name?: unknown; issues?: unknown };
  return candidate.name === "ZodError" && Array.isArray(candidate.issues);
};
