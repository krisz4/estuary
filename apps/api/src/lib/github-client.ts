import { env } from "./env.js";

/**
 * A small typed wrapper over the three GitHub REST calls the integration
 * needs. No Octokit dependency — Node's global `fetch` is enough for three
 * endpoints, and a dependency for six lines of headers is not worth it.
 *
 * `fetchImpl` is injectable so every test can stub it and never touch the
 * network (`docs/features/GitHub_Integration.md`).
 */

export interface GithubIssue {
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  /** Present only when the "issue" is actually a pull request. */
  pull_request?: unknown;
}

export interface GithubPullRequest {
  title: string;
  body: string | null;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  html_url: string;
  head: { sha: string; ref: string };
}

export type GithubCheckState = "success" | "failure" | "pending" | "error";

export interface GithubCombinedStatus {
  state: GithubCheckState;
}

/** Thrown by every client call. `rateLimited` is set on a 403 with `x-ratelimit-remaining: 0`. */
export class GithubApiError extends Error {
  readonly status: number;
  readonly rateLimited: boolean;

  constructor(message: string, status: number, rateLimited = false) {
    super(message);
    this.name = "GithubApiError";
    this.status = status;
    this.rateLimited = rateLimited;
  }
}

export interface GithubClientOptions {
  token?: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface GithubClient {
  getIssue(owner: string, repo: string, number: number): Promise<GithubIssue>;
  getPullRequest(owner: string, repo: string, number: number): Promise<GithubPullRequest>;
  getCombinedStatus(owner: string, repo: string, ref: string): Promise<GithubCombinedStatus>;
}

const DEFAULT_TIMEOUT_MS = 5000;

/** Builds a client from explicit options, defaulting to the live `env` and global `fetch`. */
export function createGithubClient(options: GithubClientOptions = {}): GithubClient {
  const apiUrl = options.apiUrl ?? env.GITHUB_API_URL;
  const token = options.token ?? env.GITHUB_TOKEN;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(`${apiUrl}${path}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "helpdesk-task-manager",
          ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        },
        signal: controller.signal,
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "AbortError";
      throw new GithubApiError(
        timedOut ? "GitHub request timed out" : "GitHub request failed",
        502,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 404) throw new GithubApiError("Not found", 404);

    if (!response.ok) {
      const rateLimited =
        response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0";
      throw new GithubApiError(`GitHub responded ${response.status}`, response.status, rateLimited);
    }

    return (await response.json()) as T;
  }

  return {
    getIssue: (owner, repo, number) => request(`/repos/${owner}/${repo}/issues/${number}`),
    getPullRequest: (owner, repo, number) => request(`/repos/${owner}/${repo}/pulls/${number}`),
    getCombinedStatus: (owner, repo, ref) =>
      request(`/repos/${owner}/${repo}/commits/${ref}/status`),
  };
}
