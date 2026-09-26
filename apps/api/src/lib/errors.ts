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
  UNAUTHORIZED: "Missing or invalid API token",
  ACTOR_NOT_PERMITTED: "This actor may not do that",
  TASK_NOT_FOUND: "Task not found",
  COMMENT_NOT_FOUND: "Comment not found",
  VERSION_CONFLICT: "The task changed since you read it. Re-read it and try again",
  TASK_ALREADY_CLAIMED: "Another agent is working on this task",
  NOT_CLAIM_HOLDER: "You do not hold the claim on this task",
  DEPENDENCY_CYCLE: "That dependency would create a cycle",
  NO_OPEN_DECISION: "This task has no open decision",
  INTEGRATION_NOT_CONFIGURED: "The GitHub integration is not configured on this server",
  INVALID_WEBHOOK_SIGNATURE: "Missing or invalid webhook signature",
  GITHUB_NOT_FOUND: "GitHub has no such issue",
  GITHUB_UNAVAILABLE: "GitHub did not answer",
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
 * codes that carry structured `details` a typed shape.
 * ------------------------------------------------------------------ */

export const notFoundError = (message?: string) => new ApiError("NOT_FOUND", message);

export const taskNotFound = (taskId?: number) =>
  new ApiError("TASK_NOT_FOUND", taskId === undefined ? undefined : `Task ${taskId} was not found`);

export const commentNotFound = () => new ApiError("COMMENT_NOT_FOUND");

export const unauthorized = () => new ApiError("UNAUTHORIZED");

export const actorNotPermitted = (message: string) => new ApiError("ACTOR_NOT_PERMITTED", message);

/** `details` shape is pinned by `versionConflictDetailsSchema` in contracts. */
export const versionConflict = (expected: number, current: number) =>
  new ApiError(
    "VERSION_CONFLICT",
    `Task is at version ${current}, not ${expected}. Re-read it and try again`,
    { expected, current },
  );

/** `details` shape is pinned by `claimConflictDetailsSchema` in contracts. */
export const taskAlreadyClaimed = (claimedBy: string, expiresAt: Date) =>
  new ApiError("TASK_ALREADY_CLAIMED", `${claimedBy} is working on this task`, {
    claimedBy,
    expiresAt: expiresAt.toISOString(),
  });

export const notClaimHolder = (claim: { claimedBy: string; expiresAt: Date } | null) =>
  claim === null
    ? new ApiError("NOT_CLAIM_HOLDER", "Nobody holds a claim on this task")
    : new ApiError("NOT_CLAIM_HOLDER", `${claim.claimedBy} holds the claim on this task`, {
        claimedBy: claim.claimedBy,
        expiresAt: claim.expiresAt.toISOString(),
      });

/** `details` shape is pinned by `dependencyCycleDetailsSchema` in contracts. */
export const dependencyCycle = (path: number[]) =>
  new ApiError("DEPENDENCY_CYCLE", undefined, { path });

export const noOpenDecision = () => new ApiError("NO_OPEN_DECISION");

/** The GitHub integration route is disabled — neither GITHUB_TOKEN nor GITHUB_WEBHOOK_SECRET is set. */
export const integrationNotConfigured = () => new ApiError("INTEGRATION_NOT_CONFIGURED");

/** `POST /integrations/github/webhook` — missing or wrong `X-Hub-Signature-256`. */
export const invalidWebhookSignature = () => new ApiError("INVALID_WEBHOOK_SIGNATURE");

/** Issue import: GitHub has no such issue, or it is private and the token cannot see it. */
export const githubNotFound = (message?: string) => new ApiError("GITHUB_NOT_FOUND", message);

/** Issue import: GitHub did not answer, answered with an error, or rate-limited the request. */
export const githubUnavailable = (message?: string) => new ApiError("GITHUB_UNAVAILABLE", message);

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
