import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_BASE_URL,
  api,
  buildQueryString,
  isApiClientError,
  type ApiClientError,
} from "@/api/http";
import { server } from "@/test/server";
import { resetSessionStore, useSessionStore } from "@/stores/session";

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
        status: ["todo", "in_progress"],
        page: 2,
        assignee: undefined,
        project: null,
      }),
    ).toBe("?status=todo&status=in_progress&page=2");
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
    await expect(api.get("/tasks")).resolves.toEqual({ data: [], meta: { total: 63 } });
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

    const error = await api.post("/tasks", {}).catch((e: unknown) => e);

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
            code: "VERSION_CONFLICT",
            message: "nope",
            details: { expected: 3, current: 4 },
            requestId: "req-2",
          },
        },
        { status: 409 },
      ),
    );

    const error = (await api.patch("/tasks/1", {}).catch((e: unknown) => e)) as ApiClientError;
    expect(error.code).toBe("VERSION_CONFLICT");
    expect(error.validationDetails).toBeUndefined();
  });

  it("falls back to INTERNAL_ERROR when the body is not the documented envelope", async () => {
    // A 502 from a proxy is an HTML page. Parsing it with the contract schema
    // would throw *inside* the error path and surface as "the error handler
    // crashed" rather than "the API is down".
    mockFetch(
      async () => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: {} }),
    );

    const error = (await api.get("/tasks").catch((e: unknown) => e)) as ApiClientError;
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

    const error = (await api.get("/tasks").catch((e: unknown) => e)) as ApiClientError;
    expect(error.requestId).toBe("from-header");
  });

  it("maps a failed fetch to NETWORK_ERROR with status 0", async () => {
    mockFetch(async () => {
      throw new TypeError("Failed to fetch");
    });

    const error = (await api.get("/tasks").catch((e: unknown) => e)) as ApiClientError;
    expect(error.code).toBe("NETWORK_ERROR");
    expect(error.status).toBe(0);
  });

  it("rethrows an abort untouched", async () => {
    // TanStack Query cancels in-flight requests on every key change. Swallowing
    // the AbortError into a NETWORK_ERROR would show "can't reach the server"
    // on a healthy fast-typing search box.
    //
    // This constructs the rejection itself, which is why it could not see the
    // realm bug the MSW test below found: the `DOMException` a stub throws is
    // the one `instanceof DOMException` resolves against, so the old
    // `instanceof` guard matched here and nowhere else. Kept as the cheap unit
    // case; the wire-level one is the guard.
    mockFetch(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });

    const error = (await api.get("/tasks").catch((e: unknown) => e)) as Error;
    expect(isApiClientError(error)).toBe(false);
    expect(error.name).toBe("AbortError");
  });

  it("returns undefined for a 204 rather than parsing an empty body", async () => {
    mockFetch(async () => new Response(null, { status: 204 }));
    await expect(api.delete("/tasks/1")).resolves.toBeUndefined();
  });

  it("maps unreadable JSON on a 2xx to MALFORMED_RESPONSE", async () => {
    mockFetch(
      async () =>
        new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
    );

    const error = (await api.get("/tasks").catch((e: unknown) => e)) as ApiClientError;
    expect(error.code).toBe("MALFORMED_RESPONSE");
  });

  it("sends a JSON content-type only when there is a body", async () => {
    const spy = mockFetch(async () => jsonResponse({}));

    await api.get("/tasks");
    await api.post("/tasks", { title: "x" });

    const [getInit, postInit] = spy.mock.calls.map(([, init]) => init);
    expect((getInit?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect((postInit?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(postInit?.body).toBe('{"title":"x"}');
  });
});

/**
 * The tests above assert on the `init` object `http.ts` hands to `fetch`. That
 * is the argument, not the request — it proves the client *asked* for a header,
 * not that one went out, and it cannot distinguish "built correctly" from "sent
 * correctly" at all.
 *
 * MSW sees the request `fetch` actually produced, after its own normalisation,
 * so these read the other side of the same boundary. Both are kept: the `init`
 * assertions localise a fault to `http.ts`, and these say the wire agrees.
 */
describe("api — the request that actually goes out", () => {
  const seen: Request[] = [];

  const capture = (reply: () => Response = () => HttpResponse.json({})) => {
    seen.length = 0;
    server.use(
      http.all(`${API_BASE_URL}/*`, ({ request }) => {
        seen.push(request.clone());
        return reply();
      }),
    );
  };

  it("puts the query string on the URL rather than only in the options", async () => {
    capture();
    await api.get("/tasks", { query: { status: ["todo", "done"], page: 2 } });

    const url = new URL(seen[0]!.url);
    expect(url.pathname).toBe(new URL(API_BASE_URL).pathname + "/tasks");
    expect(url.searchParams.getAll("status")).toEqual(["todo", "done"]);
    expect(url.searchParams.get("page")).toBe("2");
  });

  it("actually transmits the JSON body and its content-type on a POST", async () => {
    capture();
    await api.post("/tasks", { title: "Projector shows no signal" });

    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers.get("content-type")).toBe("application/json");
    await expect(seen[0]!.json()).resolves.toEqual({ title: "Projector shows no signal" });
  });

  it("sends no body and no content-type on a GET or a DELETE", async () => {
    capture(() => new HttpResponse(null, { status: 204 }));
    await api.get("/tasks");
    await api.delete("/tasks/1");

    for (const request of seen) {
      expect(request.headers.get("content-type")).toBeNull();
      expect(request.body).toBeNull();
    }
    expect(seen.map((request) => request.method)).toEqual(["GET", "DELETE"]);
  });

  it("asks for JSON on every request", async () => {
    capture();
    await api.get("/tasks");
    expect(seen[0]!.headers.get("accept")).toBe("application/json");
  });

  /*
    The session headers are asserted on the wire, not on `init`: a header the
    client "asked for" but that `fetch` normalised away would still leave the
    server attributing an agent's board to `human:anonymous`.
  */
  describe("session headers", () => {
    afterEach(() => {
      resetSessionStore();
    });

    it("sends neither X-Actor nor Authorization when nothing is set", async () => {
      capture();
      await api.get("/tasks");

      expect(seen[0]!.headers.get("x-actor")).toBeNull();
      expect(seen[0]!.headers.get("authorization")).toBeNull();
    });

    it("sends the display name as a slugged human actor", async () => {
      useSessionStore.getState().save({ displayName: "  Krisz Tian ", apiToken: "" });
      capture();
      await api.post("/tasks/1/comments", { body: "hi" });

      expect(seen[0]!.headers.get("x-actor")).toBe("human:krisz-tian");
      // A blank token is no header at all, not `Bearer ` — which a server with
      // no API_TOKEN configured would still have to parse.
      expect(seen[0]!.headers.get("authorization")).toBeNull();
    });

    it("sends the API token as a bearer header", async () => {
      useSessionStore.getState().save({ displayName: "", apiToken: " s3cret " });
      capture();
      await api.get("/tasks");

      expect(seen[0]!.headers.get("authorization")).toBe("Bearer s3cret");
      expect(seen[0]!.headers.get("x-actor")).toBeNull();
    });

    it("reads the store at request time, not when the module loaded", async () => {
      capture();
      await api.get("/tasks");
      useSessionStore.getState().save({ displayName: "Dana", apiToken: "t" });
      await api.get("/tasks");

      expect(seen.map((request) => request.headers.get("x-actor"))).toEqual([null, "human:dana"]);
    });

    it("flags the session as unauthorized on a 401, for the shell's banner", async () => {
      capture(() =>
        HttpResponse.json(
          { error: { code: "UNAUTHORIZED", message: "no", requestId: "r" } },
          { status: 401 },
        ),
      );

      const error = (await api.get("/tasks").catch((e: unknown) => e)) as ApiClientError;

      expect(error.code).toBe("UNAUTHORIZED");
      expect(useSessionStore.getState().unauthorized).toBe(true);
    });
  });

  it("aborts the in-flight request when the signal fires", async () => {
    // TanStack Query cancels on every key change, and the abort has to reach
    // the network rather than only being remembered by the caller.
    const controller = new AbortController();
    server.use(
      http.get(`${API_BASE_URL}/tasks`, async () => {
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 50));
        return HttpResponse.json({ data: [] });
      }),
    );

    const error = (await api
      .get("/tasks", { signal: controller.signal })
      .catch((e: unknown) => e)) as Error;

    expect(error.name).toBe("AbortError");
    expect(isApiClientError(error)).toBe(false);
  });
});
