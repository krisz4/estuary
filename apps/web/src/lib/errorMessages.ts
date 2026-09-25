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
  TASK_NOT_FOUND: {
    title: "Task not found",
    description: "This task does not exist, or it has been deleted.",
    retryable: false,
  },
  COMMENT_NOT_FOUND: {
    title: "Comment not found",
    description: "This comment has already been deleted.",
    retryable: false,
  },
  UNAUTHORIZED: {
    title: "This server needs an API token",
    description: "Open “You” in the header and paste the token your admin gave you.",
    retryable: true,
  },
  ACTOR_NOT_PERMITTED: {
    title: "Not allowed for this actor",
    description: "Agents hand finished work to Needs QA; a human marks it done.",
    retryable: false,
  },
  VERSION_CONFLICT: {
    title: "This task changed while you were editing",
    description:
      "Someone — possibly an agent — changed this task. Reload to see their changes, then try again.",
    retryable: false,
  },
  TASK_ALREADY_CLAIMED: {
    title: "Another agent is working on this",
    description: "The task is claimed. Wait for the claim to expire, or release it first.",
    retryable: false,
  },
  NOT_CLAIM_HOLDER: {
    title: "You don't hold this task's claim",
    description: "Only the actor working on the task can do that.",
    retryable: false,
  },
  DEPENDENCY_CYCLE: {
    title: "That would create a dependency loop",
    description: "The task you picked already depends on this one, directly or indirectly.",
    retryable: false,
  },
  NO_OPEN_DECISION: {
    title: "This question was already answered",
    description: "The decision is no longer open — someone answered or withdrew it. Reload to see.",
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
 * The copy's description, sharpened with the error's `details` where the
 * contract gives them a documented shape — who holds a claim, which chain of
 * tasks a new dependency would close into a loop.
 *
 * The details are read defensively (they are `unknown` on the wire) and only
 * the *structured* values are rendered — never `message`. An unreadable
 * `details` falls back to the plain description rather than to nothing.
 */
export const errorDescription = (error: unknown): string => {
  const copy = errorCopy(error);
  if (!isApiClientError(error)) return copy.description;

  const details = error.details;
  if (typeof details !== "object" || details === null) return copy.description;
  const record = details as Record<string, unknown>;

  if (error.code === "TASK_ALREADY_CLAIMED" || error.code === "NOT_CLAIM_HOLDER") {
    const claimedBy = record.claimedBy;
    if (typeof claimedBy === "string") {
      return `${claimedBy} holds the claim. ${copy.description}`;
    }
  }

  if (error.code === "DEPENDENCY_CYCLE") {
    const path = record.path;
    if (Array.isArray(path) && path.length > 1 && path.every((id) => typeof id === "number")) {
      return `${copy.description} Loop: ${path.map((id) => `#${id}`).join(" → ")}.`;
    }
  }

  return copy.description;
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
