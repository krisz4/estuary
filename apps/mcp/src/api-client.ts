import { ACTOR_HEADER, apiErrorResponseSchema, type ApiErrorCode } from "@helpdesk/contracts";

import type { Config } from "./config.js";

/**
 * A thin `fetch` wrapper over the REST API — the MCP server's only way to touch
 * data. It never reads the database, so every rule (claims, versions, what a
 * transition requires, who may complete a task) is enforced in exactly one
 * place: the API. See `docs/features/Task_Workflow_API.md`.
 *
 * `fetch` is injected so the tests can assert on the exact requests without a
 * network or a running API.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type QueryValue = string | number | boolean | readonly (string | number)[] | undefined;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
}

export interface ApiResponse<T> {
  status: number;
  data: T;
}

/** The API answered with its standard error envelope. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: unknown;
  readonly requestId: string;

  constructor(
    status: number,
    body: { code: ApiErrorCode; message: string; details?: unknown; requestId: string },
  ) {
    super(body.message);
    this.name = "ApiError";
    this.status = status;
    this.code = body.code;
    this.details = body.details;
    this.requestId = body.requestId;
  }
}

/**
 * The API could not be reached, timed out, or answered with something that is
 * not the envelope (a proxy's HTML 502, say). Kept apart from `ApiError` because
 * the agent's next step differs: fix the setup, not the request.
 */
export class ApiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiUnavailableError";
  }
}

/**
 * Long enough for a cold SQLite write, short enough that a hung API does not
 * stall the agent's turn for Claude Code's full tool timeout.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * `{ status: ["todo", "blocked"], page: 2 }` → `status=todo&status=blocked&page=2`.
 * Arrays repeat the key, which is how `taskListQuerySchema` reads a repeatable
 * filter; `undefined` is dropped rather than sent as `"undefined"`.
 */
export const toQueryString = (query: Record<string, QueryValue> | undefined): string => {
  if (query === undefined) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) params.append(key, String(entry));
    } else {
      params.append(key, String(value));
    }
  }
  const encoded = params.toString();
  return encoded === "" ? "" : `?${encoded}`;
};

export class ApiClient {
  constructor(
    private readonly config: Pick<Config, "apiUrl" | "actor" | "token">,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  get baseUrl(): string {
    return this.config.apiUrl;
  }

  get = <T>(path: string, query?: RequestOptions["query"]) =>
    this.request<T>("GET", path, { query });
  post = <T>(path: string, body?: unknown) => this.request<T>("POST", path, { body });
  patch = <T>(path: string, body: unknown) => this.request<T>("PATCH", path, { body });
  delete = <T>(path: string) => this.request<T>("DELETE", path, {});

  async request<T>(method: string, path: string, options: RequestOptions): Promise<ApiResponse<T>> {
    const url = `${this.config.apiUrl}${path}${toQueryString(options.query)}`;

    const headers: Record<string, string> = {
      Accept: "application/json",
      [ACTOR_HEADER]: this.config.actor,
    };
    if (this.config.token !== undefined) headers.Authorization = `Bearer ${this.config.token}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ApiUnavailableError(this.unreachableMessage(error));
    }

    // 204 (DELETE) has no body; everything else the API sends is JSON.
    const text = await response.text();
    let payload: unknown = undefined;
    if (text !== "") {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = undefined;
      }
    }

    if (response.ok) {
      if (payload === undefined && text !== "") {
        throw new ApiUnavailableError(
          `${method} ${url} returned ${response.status} with a non-JSON body — is TASKS_API_URL pointing at the API (it must end in /api/v1)?`,
        );
      }
      return { status: response.status, data: payload as T };
    }

    const envelope = apiErrorResponseSchema.safeParse(payload);
    if (envelope.success) throw new ApiError(response.status, envelope.data.error);

    throw new ApiUnavailableError(
      `${method} ${url} failed with HTTP ${response.status} and no error envelope` +
        (text === "" ? "" : `: ${text.slice(0, 200)}`) +
        ". Check that TASKS_API_URL points at the task manager API (it must end in /api/v1).",
    );
  }

  private unreachableMessage(error: unknown): string {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    const reason = timedOut
      ? `no response within ${REQUEST_TIMEOUT_MS / 1000}s`
      : describeCause(error);
    return (
      `Task manager API not reachable at ${this.config.apiUrl} (${reason}). ` +
      "Is it running (`pnpm dev:api` in the task manager repo)? If it runs elsewhere, set TASKS_API_URL."
    );
  }
}

/** `fetch failed` hides the useful part (`ECONNREFUSED`) in `cause`. */
const describeCause = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as Error & { code?: string }).code;
    return code === undefined ? cause.message : `${code}: ${cause.message}`;
  }
  return error.message;
};
