import { isApiErrorCode, type ApiErrorCode, type ValidationErrorDetails } from "@estuary/contracts";
import { sessionHeaders, useSessionStore } from "@/stores/session";

/* ------------------------------------------------------------------ *
 * Base URL
 * ------------------------------------------------------------------ */

/**
 * The API root, from `VITE_API_BASE_URL`.
 *
 * **Browser-reachable, always.** In Docker this is `http://localhost:4000/api/v1`
 * and never the compose service name: the request is issued by the user's
 * browser, which has no idea what `api` resolves to
 * (`docs/engineering/ENVIRONMENT_VARIABLES.md`, and stage 14 depends on it).
 *
 * Vite inlines `import.meta.env.*` at build time, so this is a constant in the
 * bundle rather than a runtime lookup — which also means it is baked into the
 * image, not read from the container's environment.
 */
export const API_BASE_URL: string =
  // `||`, not `??`. A `.env` (or a compose file) carrying `VITE_API_BASE_URL=`
  // inlines an empty string, which `??` passes straight through — every request
  // then resolves relative to the Vite origin, hits the SPA's HTML fallback, and
  // surfaces as MALFORMED_RESPONSE with nothing pointing at the real cause.
  // Stage 14 sets this variable in a container, so a blank value is a realistic
  // misconfiguration. An empty base URL is never what anyone meant.
  (import.meta.env.VITE_API_BASE_URL || "http://localhost:4000/api/v1").replace(/\/+$/, "");

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/**
 * Failures that never reach the server, so they have no code from
 * `ApiErrorCode`. Kept separate from the contract union rather than added to
 * it: the API cannot emit these, and widening a server contract to describe a
 * client condition is how the two drift.
 */
export const CLIENT_ERROR_CODES = ["NETWORK_ERROR", "MALFORMED_RESPONSE"] as const;
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];

export type ApiClientErrorCode = ApiErrorCode | ClientErrorCode;

/**
 * The single error type every caller in the app sees.
 *
 * `message` carries the server's text for logging and for the OpenAPI-documented
 * cases, but **the UI never renders it** — copy is keyed off `code` in
 * `lib/errorMessages.ts` so a raw server string can never reach a user
 * (`docs/features/Error_Handling.md` § What must not happen).
 */
export class ApiClientError extends Error {
  readonly code: ApiClientErrorCode;
  readonly details: unknown;
  readonly requestId: string | undefined;
  /** HTTP status, or `0` when the request never completed. */
  readonly status: number;

  constructor(init: {
    code: ApiClientErrorCode;
    message: string;
    details?: unknown;
    requestId?: string | undefined;
    status: number;
    cause?: unknown;
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ApiClientError";
    this.code = init.code;
    this.details = init.details;
    this.requestId = init.requestId;
    this.status = init.status;
  }

  /** `VALIDATION_ERROR` details, or `undefined` for every other code. */
  get validationDetails(): ValidationErrorDetails | undefined {
    if (this.code !== "VALIDATION_ERROR") return undefined;
    return isValidationDetails(this.details) ? this.details : undefined;
  }
}

export const isApiClientError = (value: unknown): value is ApiClientError =>
  value instanceof ApiClientError;

/**
 * Structural, **not** `instanceof DOMException`.
 *
 * `fetch` rejects with the `DOMException` from its *own* realm, and that is not
 * always the one `instanceof` resolves against here: under jsdom the global is
 * jsdom's while the rejection comes from undici's, so
 * `cause instanceof DOMException` is `false` for a genuine abort — the guard it
 * protects then falls through and turns a cancelled request into "can't reach
 * the server", which is the exact failure the guard exists to prevent.
 * `name === "AbortError"` is what the DOM spec actually guarantees, and it is
 * true in every realm.
 *
 * Same reasoning as the API's `errorHandler`, which detects `ZodError`
 * structurally for the same class of reason (`docs/history/BUILD_LOG.md`).
 */
const isAbortError = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  (cause as { name?: unknown }).name === "AbortError";

const isValidationDetails = (value: unknown): value is ValidationErrorDetails =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every(
    (entry) => Array.isArray(entry) && entry.every((item) => typeof item === "string"),
  );

/* ------------------------------------------------------------------ *
 * Envelope unwrapping
 * ------------------------------------------------------------------ */

const REQUEST_ID_HEADER = "x-request-id";

/**
 * Reads `{ error: { code, message, details?, requestId } }` off a failed
 * response.
 *
 * Deliberately hand-rolled rather than `apiErrorResponseSchema.parse()`. A 500
 * from a proxy, a 502 HTML page, or a CORS-stripped body all fail that parse —
 * and a throwing error parser turns "the API is down" into "the error handler
 * crashed". Every field is treated as absent-until-proven, and an unreadable
 * body still yields a usable `ApiClientError`.
 */
const errorFromResponse = async (response: Response): Promise<ApiClientError> => {
  const headerRequestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  const envelope =
    typeof body === "object" && body !== null && "error" in body
      ? (body as { error: unknown }).error
      : undefined;

  const error =
    typeof envelope === "object" && envelope !== null
      ? (envelope as Record<string, unknown>)
      : undefined;

  const code = isApiErrorCode(error?.code) ? error.code : "INTERNAL_ERROR";
  const message =
    typeof error?.message === "string" && error.message.length > 0
      ? error.message
      : `Request failed with status ${response.status}`;
  const requestId = typeof error?.requestId === "string" ? error.requestId : headerRequestId;

  return new ApiClientError({
    code,
    message,
    details: error?.details,
    requestId,
    status: response.status,
  });
};

/* ------------------------------------------------------------------ *
 * The client
 * ------------------------------------------------------------------ */

export type RequestOptions = {
  /** Appended to the base URL. Query values are encoded; arrays repeat the key. */
  query?: QueryInput;
  signal?: AbortSignal | undefined;
};

export type QueryValue = string | number | boolean | null | undefined;
export type QueryInput = Record<string, QueryValue | readonly QueryValue[]>;

/**
 * `{ status: ["open","closed"], page: 2, q: undefined }` →
 * `?status=open&status=closed&page=2`.
 *
 * `undefined` and `null` are dropped rather than serialized. An empty string is
 * kept — the server's `dropEmptyQueryValues` preprocessor already treats it as
 * absent, and dropping it here too would mean two places deciding what "empty"
 * means.
 */
export const buildQueryString = (query: QueryInput | undefined): string => {
  if (query === undefined) return "";

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (entry === undefined || entry === null) continue;
      params.append(key, String(entry));
    }
  }

  const serialized = params.toString();
  return serialized === "" ? "" : `?${serialized}`;
};

export type ResponseWithStatus<TResponse> = { data: TResponse; status: number };

const requestWithStatus = async <TResponse>(
  method: string,
  path: string,
  body: unknown,
  options: RequestOptions = {},
): Promise<ResponseWithStatus<TResponse>> => {
  const url = `${API_BASE_URL}${path}${buildQueryString(options.query)}`;

  const init: RequestInit = {
    method,
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      // `X-Actor` and `Authorization`, each only when set — an absent name is
      // the server's `human:anonymous`, and an empty `Bearer ` is a 401 on a
      // server that has no token configured at all. See `stores/session.ts`.
      ...sessionHeaders(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    // An abort is the caller getting what it asked for, not a failure — TanStack
    // Query cancels in-flight requests on every key change, and swallowing the
    // AbortError into a NETWORK_ERROR would show "can't reach the server" on a
    // perfectly healthy fast-typing search box.
    if (isAbortError(cause)) throw cause;

    throw new ApiClientError({
      code: "NETWORK_ERROR",
      message: `Could not reach ${url}`,
      status: 0,
      cause,
    });
  }

  if (!response.ok) {
    const error = await errorFromResponse(response);
    // Raised here, for every caller at once, rather than in each screen's error
    // branch: a 401 means the same thing wherever it happens — the token in the
    // session dialog is missing or wrong — and the banner that says so lives
    // in the app shell (`UnauthorizedBanner`).
    if (error.code === "UNAUTHORIZED") useSessionStore.getState().reportUnauthorized();
    throw error;
  }

  // 204 on a successful DELETE, with no body. Parsing it as JSON throws.
  if (response.status === 204 || response.headers.get("content-length") === "0") {
    return { data: undefined as TResponse, status: response.status };
  }

  try {
    return { data: (await response.json()) as TResponse, status: response.status };
  } catch (cause) {
    throw new ApiClientError({
      code: "MALFORMED_RESPONSE",
      message: `Response from ${url} was not valid JSON`,
      requestId: response.headers.get(REQUEST_ID_HEADER) ?? undefined,
      status: response.status,
      cause,
    });
  }
};

const request = async <TResponse>(
  method: string,
  path: string,
  body: unknown,
  options: RequestOptions = {},
): Promise<TResponse> => (await requestWithStatus<TResponse>(method, path, body, options)).data;

export const api = {
  get: <TResponse>(path: string, options?: RequestOptions) =>
    request<TResponse>("GET", path, undefined, options),
  post: <TResponse>(path: string, body?: unknown, options?: RequestOptions) =>
    request<TResponse>("POST", path, body, options),
  patch: <TResponse>(path: string, body?: unknown, options?: RequestOptions) =>
    request<TResponse>("PATCH", path, body, options),
  delete: <TResponse = void>(path: string, options?: RequestOptions) =>
    request<TResponse>("DELETE", path, undefined, options),
  /**
   * Like `post`, but also hands back the HTTP status — for the one endpoint
   * where 200 vs 201 is meaningful to the UI: `POST
   * /integrations/github/import` returns 200 for an issue already imported
   * and 201 for a new task, and the import dialog's toast says which.
   */
  postWithStatus: <TResponse>(path: string, body?: unknown, options?: RequestOptions) =>
    requestWithStatus<TResponse>("POST", path, body, options),
};
