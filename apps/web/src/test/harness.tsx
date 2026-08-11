import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type Comment, type Ticket } from "@helpdesk/contracts";
import { render, type RenderResult } from "@testing-library/react";
import { type ReactNode } from "react";
import { RouterProvider, createMemoryRouter, type RouteObject } from "react-router-dom";
import { vi } from "vitest";

/**
 * Shared test scaffolding for the stage-12 screens.
 *
 * **`fetch` is stubbed, never the query hooks.** Mocking `useTicketQuery` would
 * prove a component renders whatever it is handed and say nothing about the
 * request → cache → render path, which is most of what these screens do. (Stage
 * 13 swaps MSW in at this same boundary; the components do not change.)
 *
 * `createMemoryRouter` rather than `MemoryRouter`: the forms use `useBlocker`,
 * which only exists on a data router. A non-data router makes the dirty guard
 * throw at render, so the cheaper wrapper is not an option here.
 */

export const makeTicket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 42,
  reference: "HD-000042",
  title: "Projector shows no signal",
  description: "Swapped the cable, still nothing.",
  status: "open",
  priority: "medium",
  category: "hardware",
  requesterName: "Dana Reyes",
  requesterEmail: "dana@example.com",
  assignee: "Marcus Feld",
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:00:00.000Z",
  resolvedAt: null,
  closedAt: null,
  commentCount: 0,
  comments: [],
  ...overrides,
});

export const makeComment = (overrides: Partial<Comment> = {}): Comment => ({
  id: 1,
  ticketId: 42,
  authorName: "Priya Nair",
  body: "Looking into it.",
  createdAt: "2026-08-01T11:00:00.000Z",
  ...overrides,
});

export type StubbedRequest = { method: string; url: URL; body: unknown };

export type RouteHandler = (request: StubbedRequest) => { status?: number; body?: unknown };

/**
 * Installs a `fetch` stub and returns the list of requests it saw.
 *
 * Handlers are keyed by `"<METHOD> <path-suffix>"` and matched by suffix, so a
 * test writes `"GET /tickets/42"` without repeating the base URL.
 */
export const stubFetch = (
  handlers: Record<string, RouteHandler>,
): { requests: StubbedRequest[] } => {
  const requests: StubbedRequest[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const request: StubbedRequest = { method, url, body };
    requests.push(request);

    const key = Object.keys(handlers).find((candidate) => {
      const [handlerMethod, path] = candidate.split(" ");
      return handlerMethod === method && url.pathname.endsWith(path ?? "");
    });

    if (key === undefined) {
      return new Response(
        JSON.stringify({ error: { code: "NOT_FOUND", message: "no handler", requestId: "t" } }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }

    const { status = 200, body: responseBody } = handlers[key]!(request);
    if (status === 204) return new Response(null, { status: 204 });

    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  });

  vi.stubGlobal("fetch", fetchMock);
  return { requests };
};

/** A client with retries off, so an error state is reached in one tick. */
export const makeQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });

export type RenderRouteOptions = {
  routes: RouteObject[];
  initialEntries?: (string | { pathname: string; state?: unknown })[];
  queryClient?: QueryClient;
};

export const renderRoute = ({
  routes,
  initialEntries = ["/"],
  queryClient = makeQueryClient(),
}: RenderRouteOptions): RenderResult & { queryClient: QueryClient } => {
  const router = createMemoryRouter(routes, { initialEntries: initialEntries as never });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
};

/** Wraps `children` in the providers, on a single throwaway route. */
export const renderInProviders = (
  children: ReactNode,
  options: Omit<RenderRouteOptions, "routes"> = {},
): RenderResult & { queryClient: QueryClient } =>
  renderRoute({ routes: [{ path: "*", element: children }], ...options });
