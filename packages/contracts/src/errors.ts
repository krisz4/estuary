import { z } from "zod";

/**
 * The complete set of error codes the API can emit.
 *
 * This list is the runtime twin of the table in
 * `docs/engineering/API_ERROR_CONTRACT.md`, and the two must stay identical —
 * adding a code means adding it in both places. Clients branch on `code`, never
 * on the HTTP status alone.
 *
 * Two codes are deliberately absent and must not be reintroduced casually:
 *
 * - `METHOD_NOT_ALLOWED` (405) — Express does not generate it; an unmatched verb
 *   falls through to the `notFound` middleware as a 404.
 * - `CONFLICT` (409) — every 409 names *what* conflicted (`VERSION_CONFLICT`,
 *   `TASK_ALREADY_CLAIMED`, …). The one client-supplied unique column,
 *   `idempotencyKey`, never conflicts: a repeat returns the original task.
 *
 * `INVALID_STATUS_TRANSITION` was retired with the helpdesk lifecycle: there is
 * no from→to table any more, and what a status requires is validated as the
 * shape of the transition payload (`VALIDATION_ERROR`).
 */
export const API_ERROR_CODES = [
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
] as const;

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

/**
 * The HTTP status each code is served with. Kept here rather than in the API so
 * the OpenAPI generator and the web client agree with the server without a
 * second table to drift.
 */
export const API_ERROR_STATUS = {
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
} as const satisfies Record<ApiErrorCode, number>;

export type ApiErrorStatus = (typeof API_ERROR_STATUS)[ApiErrorCode];

/** Narrowing guard for a value arriving from the wire. */
export const isApiErrorCode = (value: unknown): value is ApiErrorCode =>
  typeof value === "string" && (API_ERROR_CODES as readonly string[]).includes(value);

/** `details` for `VALIDATION_ERROR`: field name → messages. */
export const validationErrorDetailsSchema = z.record(z.string(), z.array(z.string()));
export type ValidationErrorDetails = z.infer<typeof validationErrorDetailsSchema>;

/** `details` for `VERSION_CONFLICT`: the version the caller should re-read at. */
export const versionConflictDetailsSchema = z
  .object({
    expected: z.number().int(),
    current: z.number().int(),
  })
  .strict();
export type VersionConflictDetails = z.infer<typeof versionConflictDetailsSchema>;

/** `details` for `TASK_ALREADY_CLAIMED` / `NOT_CLAIM_HOLDER`: who holds it, until when. */
export const claimConflictDetailsSchema = z
  .object({
    claimedBy: z.string(),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type ClaimConflictDetails = z.infer<typeof claimConflictDetailsSchema>;

/** `details` for `DEPENDENCY_CYCLE`: the chain that would close the loop, as task ids. */
export const dependencyCycleDetailsSchema = z
  .object({
    path: z.array(z.number().int()),
  })
  .strict();
export type DependencyCycleDetails = z.infer<typeof dependencyCycleDetailsSchema>;

/**
 * The error envelope. `details` is intentionally loose (`unknown`) — it carries a
 * different shape per code, and the two concrete shapes above are what a client
 * narrows to once it has branched on `code`.
 */
export const apiErrorSchema = z
  .object({
    code: apiErrorCodeSchema,
    message: z.string().min(1),
    details: z.unknown().optional(),
    requestId: z.string().min(1),
  })
  .strict();
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

export const apiErrorResponseSchema = z.object({ error: apiErrorSchema }).strict();
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
