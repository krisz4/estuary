import { type ValidationErrorDetails } from "@helpdesk/contracts";
import { ApiClientError, isApiClientError, type ApiClientErrorCode } from "@/api/http";

/**
 * UI copy for every failure, keyed off `code`.
 *
 * The rule this file exists to enforce: **an unrecognised code falls back to
 * the generic message rather than rendering the raw server text**
 * (`docs/engineering/API_ERROR_CONTRACT.md` § Client mapping). Server messages
 * are written for a log, not for a user, and a future code added on the API
 * side must not leak its prose into the interface before someone has written
 * copy for it.
 */

export type ErrorCopy = {
  /** Short heading for an error panel, or the toast title. */
  title: string;
  /** One sentence, actionable where there is an action. */
  description: string;
  /**
   * Whether a Retry button makes sense. A 404 or a 422 will fail identically on
   * a second try; a network blip or a 500 might not.
   */
  retryable: boolean;
};

export const GENERIC_ERROR: ErrorCopy = {
  title: "Something went wrong",
  description: "The request could not be completed. Please try again.",
  retryable: true,
};

const ERROR_COPY: Record<ApiClientErrorCode, ErrorCopy> = {
  VALIDATION_ERROR: {
    title: "Check the highlighted fields",
    description: "Some values were rejected. Correct them and submit again.",
    retryable: false,
  },
  AT_LEAST_ONE_FIELD: {
    title: "Nothing to save",
    description: "Change at least one field before saving.",
    retryable: false,
  },
  TICKET_NOT_FOUND: {
    title: "Ticket not found",
    description: "This ticket does not exist, or it has been deleted.",
    retryable: false,
  },
  COMMENT_NOT_FOUND: {
    title: "Comment not found",
    description: "This comment has already been deleted.",
    retryable: false,
  },
  INVALID_STATUS_TRANSITION: {
    title: "That status change is not allowed",
    description: "This ticket cannot move directly to the status you picked.",
    retryable: false,
  },
  MALFORMED_JSON: {
    title: "The request could not be read",
    description: "The data sent to the server was not valid. Please try again.",
    retryable: true,
  },
  PAYLOAD_TOO_LARGE: {
    title: "That is too much text",
    description: "Shorten the description or comment and try again.",
    retryable: false,
  },
  NOT_FOUND: {
    title: "Not found",
    description: "The page or resource you asked for does not exist.",
    retryable: false,
  },
  INTERNAL_ERROR: {
    title: "Something went wrong on the server",
    description: "This is not your fault. Try again in a moment.",
    retryable: true,
  },
  NETWORK_ERROR: {
    title: "Can't reach the server",
    description: "Check your connection, or the API may not be running.",
    retryable: true,
  },
  MALFORMED_RESPONSE: {
    title: "Unexpected response",
    description: "The server replied with something this app could not read.",
    retryable: true,
  },
};

/**
 * Copy for any thrown value.
 *
 * Takes `unknown`, not `ApiClientError`: a render crash, a rejected promise from
 * somewhere else, or a `TypeError` in a query function all land in the same
 * error panel, and every one of them must produce copy rather than a blank box.
 */
export const errorCopy = (error: unknown): ErrorCopy => {
  if (!isApiClientError(error)) return GENERIC_ERROR;
  return ERROR_COPY[error.code] ?? GENERIC_ERROR;
};

/** `requestId` when the failure carried one — shown in small text on 500s. */
export const errorRequestId = (error: unknown): string | undefined =>
  isApiClientError(error) ? error.requestId : undefined;

/**
 * `details.allowed` for `INVALID_STATUS_TRANSITION`, so the status control can
 * say which targets are legal instead of only that this one is not.
 */
export const allowedTransitionsFrom = (error: unknown): string[] | undefined => {
  if (!isApiClientError(error) || error.code !== "INVALID_STATUS_TRANSITION") return undefined;
  const details = error.details;
  if (typeof details !== "object" || details === null) return undefined;
  const allowed = (details as { allowed?: unknown }).allowed;
  if (!Array.isArray(allowed) || !allowed.every((v) => typeof v === "string")) return undefined;
  return allowed;
};

/* ------------------------------------------------------------------ *
 * Validation details → form fields
 * ------------------------------------------------------------------ */

/**
 * The key `errorHandler` files a pathless zod issue under.
 *
 * **Not every `details` key is a form field.** An unknown query parameter is
 * reported by zod with an empty path — it names the offending key in the
 * *message*, not the path — and the server files those under `_`
 * (`docs/engineering/BUILD_LOG.md`, stage 8 constraints). A form that mapped
 * `details` straight onto its fields would call `setError("_", …)` on a field
 * that does not exist, and react-hook-form drops errors for unregistered names
 * silently: the user sees a rejected submit with nothing highlighted.
 */
export const NON_FIELD_DETAIL_KEY = "_";

export type SplitValidationErrors = {
  /** Keys that match a field the caller actually renders. */
  fieldErrors: Record<string, string[]>;
  /** Everything else — `_`, and any field name this form does not have. */
  formErrors: string[];
};

/**
 * Splits `VALIDATION_ERROR` details into "goes on a field" and "goes in the
 * summary", against the field names the caller says it owns.
 *
 * Checking against a caller-supplied list rather than filtering out `_` alone is
 * deliberate: `_` is the known case, but a server field the form does not
 * render (a query param, a field added API-side later) has exactly the same
 * failure mode, and the same fix.
 */
export const splitValidationErrors = (
  error: unknown,
  knownFields: readonly string[],
): SplitValidationErrors => {
  const empty: SplitValidationErrors = { fieldErrors: {}, formErrors: [] };
  if (!(error instanceof ApiClientError)) return empty;

  const details: ValidationErrorDetails | undefined = error.validationDetails;
  if (details === undefined) return empty;

  const known = new Set(knownFields);
  const fieldErrors: Record<string, string[]> = {};
  const formErrors: string[] = [];

  for (const [key, messages] of Object.entries(details)) {
    if (key !== NON_FIELD_DETAIL_KEY && known.has(key)) {
      fieldErrors[key] = messages;
    } else {
      formErrors.push(...messages);
    }
  }

  return { fieldErrors, formErrors };
};
