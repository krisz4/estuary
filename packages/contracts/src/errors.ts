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
 * - `CONFLICT` (409) — the only unique columns are server-generated primary
 *   keys, so no client request can violate one. A Prisma `P2002` here is a
 *   server bug and correctly surfaces as `INTERNAL_ERROR`.
 */
export const API_ERROR_CODES = [
  "VALIDATION_ERROR",
  "AT_LEAST_ONE_FIELD",
  "TICKET_NOT_FOUND",
  "COMMENT_NOT_FOUND",
  "INVALID_STATUS_TRANSITION",
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
  TICKET_NOT_FOUND: 404,
  COMMENT_NOT_FOUND: 404,
  INVALID_STATUS_TRANSITION: 409,
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

/** `details` for `INVALID_STATUS_TRANSITION`. */
export const statusTransitionErrorDetailsSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    allowed: z.array(z.string()),
  })
  .strict();
export type StatusTransitionErrorDetails = z.infer<typeof statusTransitionErrorDetailsSchema>;

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
