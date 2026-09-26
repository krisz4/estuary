import { describe, expect, it, vi } from "vitest";

import { GithubApiError, createGithubClient } from "./github-client.js";

/**
 * `lib/github-client.ts` — never touches the network: every call stubs
 * `fetchImpl` (`docs/features/GitHub_Integration.md`).
 */

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

describe("createGithubClient", () => {
  it("sends the required headers, and a bearer token when one is configured", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ title: "Bug", state: "open" }),
    );
    const client = createGithubClient({
      token: "gh-secret",
      apiUrl: "https://api.example",
      fetchImpl,
    });

    await client.getIssue("acme", "widgets", 7);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.example/repos/acme/widgets/issues/7");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(headers["User-Agent"]).toBeTruthy();
    expect(headers.Authorization).toBe("Bearer gh-secret");
  });

  it("omits the Authorization header when no token is configured", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ title: "Bug", state: "open" }),
    );
    const client = createGithubClient({ apiUrl: "https://api.example", fetchImpl });

    await client.getIssue("acme", "widgets", 7);

    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("never logs or echoes the token anywhere in a thrown error", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
    const client = createGithubClient({
      token: "gh-super-secret",
      apiUrl: "https://api.example",
      fetchImpl,
    });

    const err = await client.getIssue("acme", "widgets", 7).catch((e: unknown) => e);

    expect(String((err as Error).message)).not.toContain("gh-super-secret");
  });

  it("throws GithubApiError(404) for a 404", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const client = createGithubClient({ apiUrl: "https://api.example", fetchImpl });

    const err = await client.getIssue("acme", "widgets", 999).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GithubApiError);
    expect((err as GithubApiError).status).toBe(404);
  });

  it("flags a rate-limited 403 (x-ratelimit-remaining: 0)", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        }),
    );
    const client = createGithubClient({ apiUrl: "https://api.example", fetchImpl });

    const err = await client.getIssue("acme", "widgets", 1).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GithubApiError);
    expect((err as GithubApiError).status).toBe(403);
    expect((err as GithubApiError).rateLimited).toBe(true);
  });

  it("does not flag an ordinary 403 as rate-limited", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 403 }));
    const client = createGithubClient({ apiUrl: "https://api.example", fetchImpl });

    const err = await client.getIssue("acme", "widgets", 1).catch((e: unknown) => e);

    expect((err as GithubApiError).rateLimited).toBe(false);
  });

  it("wraps a network failure as a GithubApiError rather than letting it propagate raw", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const client = createGithubClient({ apiUrl: "https://api.example", fetchImpl });

    const err = await client.getIssue("acme", "widgets", 1).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GithubApiError);
  });

  it("aborts and throws after the configured timeout", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const client = createGithubClient({ apiUrl: "https://api.example", fetchImpl, timeoutMs: 10 });

    const err = await client.getIssue("acme", "widgets", 1).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GithubApiError);
    expect((err as GithubApiError).message).toContain("timed out");
  });

  it("resolves the pull request and combined status endpoints", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          title: "Fix login",
          state: "open",
          draft: false,
          merged: false,
          html_url: "https://github.com/acme/widgets/pull/12",
          head: { sha: "abc123", ref: "task-42-fix-login" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ state: "success" }));

    const client = createGithubClient({ apiUrl: "https://api.example", fetchImpl });

    const pr = await client.getPullRequest("acme", "widgets", 12);
    expect(pr.head.ref).toBe("task-42-fix-login");

    const status = await client.getCombinedStatus("acme", "widgets", pr.head.sha);
    expect(status.state).toBe("success");
    expect(fetchImpl.mock.calls[1]![0]).toBe(
      "https://api.example/repos/acme/widgets/commits/abc123/status",
    );
  });
});
