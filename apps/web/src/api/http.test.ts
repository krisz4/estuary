import { afterEach, describe, expect, it, vi } from "vitest";
import { api, buildQueryString, isApiClientError, type ApiClientError } from "@/api/http";

/**
 * `http.ts` is the only place a server response becomes an app-level value, so
 * everything below is about the boundary rather than about fetch: does a non-2xx
 * become an `ApiClientError` with the *server's* code, and does a response that
 * is not the documented envelope still produce a usable error instead of a
 * throw inside the error path.
 */

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

const mockFetch = (impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("buildQueryString", () => {
  it("repeats the key for an array and drops null/undefined", () => {
    expect(
      buildQueryString({
        status: ["open", "in_progress"],
        page: 2,
        assignee: undefined,
        category: null,
      }),
    ).toBe("?status=open&status=in_progress&page=2");
  });

  it("keeps an empty string rather than deciding what 'empty' means", () => {
    // The server's `dropEmptyQueryValues` preprocessor already treats `?q=` as
    // absent. Dropping it here too would put that decision in two places.
    expect(buildQueryString({ q: "" })).toBe("?q=");
  });

  it("is empty for no query at all", () => {
    expect(buildQueryString(undefined)).toBe("");
  });

  it("encodes values", () => {
    expect(buildQueryString({ q: "printer & scanner" })).toBe("?q=printer+%26+scanner");
  });
});

describe("api", () => {
  it("returns the parsed body on success", async () => {
    mockFetch(async () => jsonResponse({ data: [], meta: { total: 63 } }));
    await expect(api.get("/tickets")).resolves.toEqual({ data: [], meta: { total: 63 } });
  });

  it("turns a non-2xx envelope into an ApiClientError carrying the server's code", async () => {
    mockFetch(async () =>
      jsonResponse(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Request validation failed",
            details: { title: ["Title must be at least 5 characters"] },
            requestId: "req-1",
          },
        },
        { status: 422 },
      ),
    );

    const error = await api.post("/tickets", {}).catch((e: unknown) => e);

    expect(isApiClientError(error)).toBe(true);
    const apiError = error as ApiClientError;
    expect(apiError.code).toBe("VALIDATION_ERROR");
    expect(apiError.status).toBe(422);
    expect(apiError.requestId).toBe("req-1");
    expect(apiError.validationDetails).toEqual({
      title: ["Title must be at least 5 characters"],
    });
  });

  it("exposes validationDetails only for VALIDATION_ERROR", async () => {
    mockFetch(async () =>
      jsonResponse(
        {
          error: {
            code: "INVALID_STATUS_TRANSITION",
            message: "nope",
            details: { from: "closed", to: "resolved", allowed: [] },
            requestId: "req-2",
          },
        },
        { status: 409 },
      ),
    );

    const error = (await api.patch("/tickets/1", {}).catch((e: unknown) => e)) as ApiClientError;
    expect(error.code).toBe("INVALID_STATUS_TRANSITION");
    expect(error.validationDetails).toBeUndefined();
  });

  it("falls back to INTERNAL_ERROR when the body is not the documented envelope", async () => {
    // A 502 from a proxy is an HTML page. Parsing it with the contract schema
    // would throw *inside* the error path and surface as "the error handler
    // crashed" rather than "the API is down".
    mockFetch(
      async () => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: {} }),
    );

    const error = (await api.get("/tickets").catch((e: unknown) => e)) as ApiClientError;
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.status).toBe(502);
    expect(error.message).toContain("502");
  });

  it("reads requestId off the header when the body has none", async () => {
    mockFetch(
      async () =>
        new Response("", {
          status: 500,
          headers: { "x-request-id": "from-header", "content-length": "0" },
        }),
    );

    const error = (await api.get("/tickets").catch((e: unknown) => e)) as ApiClientError;
    expect(error.requestId).toBe("from-header");
  });

  it("maps a failed fetch to NETWORK_ERROR with status 0", async () => {
    mockFetch(async () => {
      throw new TypeError("Failed to fetch");
    });

    const error = (await api.get("/tickets").catch((e: unknown) => e)) as ApiClientError;
    expect(error.code).toBe("NETWORK_ERROR");
    expect(error.status).toBe(0);
  });

  it("rethrows an abort untouched", async () => {
    // TanStack Query cancels in-flight requests on every key change. Swallowing
    // the AbortError into a NETWORK_ERROR would show "can't reach the server"
    // on a healthy fast-typing search box.
    mockFetch(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });

    const error = (await api.get("/tickets").catch((e: unknown) => e)) as Error;
    expect(isApiClientError(error)).toBe(false);
    expect(error.name).toBe("AbortError");
  });

  it("returns undefined for a 204 rather than parsing an empty body", async () => {
    mockFetch(async () => new Response(null, { status: 204 }));
    await expect(api.delete("/tickets/1")).resolves.toBeUndefined();
  });

  it("maps unreadable JSON on a 2xx to MALFORMED_RESPONSE", async () => {
    mockFetch(
      async () =>
        new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
    );

    const error = (await api.get("/tickets").catch((e: unknown) => e)) as ApiClientError;
    expect(error.code).toBe("MALFORMED_RESPONSE");
  });

  it("sends a JSON content-type only when there is a body", async () => {
    const spy = mockFetch(async () => jsonResponse({}));

    await api.get("/tickets");
    await api.post("/tickets", { title: "x" });

    const [getInit, postInit] = spy.mock.calls.map(([, init]) => init);
    expect((getInit?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect((postInit?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(postInit?.body).toBe('{"title":"x"}');
  });
});
