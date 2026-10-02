import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  TASK_STATUSES,
  type Comment,
  type Decision,
  type EventsResponse,
  type PaginatedTasks,
  type Task,
  type TaskStats,
  type TaskSummary,
} from "@estuary/contracts";
import { render, type RenderResult } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { type ReactNode } from "react";
import { RouterProvider, createMemoryRouter, type RouteObject } from "react-router-dom";
import { harnessFaults, server } from "@/test/server";

/**
 * Shared test scaffolding for the web screens.
 *
 * **The network is mocked, never the query hooks.** Mocking `useTaskQuery`
 * would prove a component renders whatever it is handed and say nothing about
 * the request → cache → render path, which is most of what these screens do.
 *
 * Stage 13 moved that boundary from a hand-rolled `fetch` stub to MSW. The
 * ergonomics are unchanged — handlers keyed `"METHOD /path-suffix"`, a
 * `requests` array to assert on — but the request `http.ts` sees is now a real
 * one: `fetch` runs its own argument normalisation, header handling, and body
 * streaming, and the response comes back through `Response` rather than being
 * one the test constructed by hand. A stub that returns whatever object the
 * test wrote cannot disagree with `http.ts` about what a response *is*.
 *
 * `createMemoryRouter` rather than `MemoryRouter`: the forms use `useBlocker`,
 * which only exists on a data router. A non-data router makes the dirty guard
 * throw at render, so the cheaper wrapper is not an option here.
 */

export const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: 42,
  reference: "TASK-000042",
  title: "Add rate limiting to the export endpoint",
  description: "Exports time out under load; throttle per client.",
  status: "todo",
  statusNote: null,
  concerns: null,
  needsTriage: false,
  priority: "medium",
  project: "estuary",
  assignee: null,
  acceptanceCriteria: "Requests over 10/min get a 429.",
  links: [],
  labels: [],
  parentId: null,
  childCount: 0,
  createdBy: "agent:claude-code",
  claim: null,
  version: 3,
  openDependencyCount: 0,
  openDecision: null,
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:00:00.000Z",
  startedAt: null,
  completedAt: null,
  commentCount: 0,
  comments: [],
  decisions: [],
  parent: null,
  children: [],
  dependencies: [],
  dependents: [],
  ...overrides,
});

/** A list row: the task minus its thread and relations. */
export const makeSummary = (overrides: Partial<TaskSummary> = {}): TaskSummary => {
  const {
    comments: _comments,
    decisions: _decisions,
    parent: _parent,
    children: _children,
    dependencies: _dependencies,
    dependents: _dependents,
    ...rest
  } = makeTask();
  return { ...rest, ...overrides };
};

export const makeComment = (overrides: Partial<Comment> = {}): Comment => ({
  id: 1,
  taskId: 42,
  author: "human:priya",
  kind: "note",
  body: "Looking into it.",
  createdAt: "2026-08-01T11:00:00.000Z",
  ...overrides,
});

export const makeDecision = (overrides: Partial<Decision> = {}): Decision => ({
  id: 7,
  taskId: 42,
  status: "open",
  question: "Which limiter should we use?",
  options: [
    { label: "Token bucket", description: "Smooth, allows bursts." },
    { label: "Fixed window" },
  ],
  recommendedOption: "Token bucket",
  context: "Both are a day of work.",
  requestedBy: "agent:claude-code",
  choice: null,
  note: null,
  answeredBy: null,
  createdAt: "2026-08-01T12:00:00.000Z",
  answeredAt: null,
  ...overrides,
});

export const makeStats = (overrides: Partial<TaskStats> = {}): TaskStats => ({
  byStatus: Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as TaskStats["byStatus"],
  needsAttention: 0,
  ...overrides,
});

/** `{ data, meta }` for a list handler, with `meta` consistent with `data`. */
export const makePage = (data: TaskSummary[], pageSize = 20): PaginatedTasks => ({
  data,
  meta: {
    page: 1,
    pageSize,
    total: data.length,
    totalPages: Math.max(1, Math.ceil(data.length / pageSize)),
    hasNextPage: false,
    hasPrevPage: false,
  },
});

/** An empty events feed — what every detail page asks for alongside the task. */
export const emptyEvents = (): EventsResponse => ({
  data: [],
  meta: { nextAfter: 0, nextBefore: null, hasMore: false },
});

export type MockRequest = { method: string; url: URL; body: unknown };

export type MockReply = { status?: number; body?: unknown };

export type RouteHandler = (request: MockRequest) => MockReply | Promise<MockReply>;

/**
 * Installs MSW handlers for the API and returns the list of requests they saw.
 *
 * Handlers are keyed by `"<METHOD> <path-suffix>"` and matched by suffix, so a
 * test writes `"GET /tasks/42"` without repeating the base URL.
 *
 * One MSW handler is registered — `http.all("*")` — and the suffix dispatch
 * happens inside it, rather than translating each key into an MSW path pattern.
 * That keeps suffix matching (a key must not have to know `VITE_API_BASE_URL`)
 * and keeps *every* request the app makes flowing through one place, which is
 * what makes `requests` a complete record rather than a record of the requests
 * somebody remembered to declare.
 *
 * A handler may be async. `GET /tasks` awaiting a latch is how a test gets a
 * window in which to observe the in-flight state.
 *
 * **An unmatched or ambiguous key fails the test**, via `harnessFaults` rather
 * than a thrown resolver (see `server.ts` for why a throw is not enough). Both
 * are test-authoring bugs and both used to be invisible:
 *
 * - *Unmatched.* Answering with a synthetic 404 made a mistyped key
 *   (`"GET /tasks/4"`, a stray space, the wrong method) look like a
 *   well-formed not-found response, so a test would reach its asserted state
 *   for entirely the wrong reason — and it silently cancelled the
 *   `onUnhandledRequest: "error"` guarantee `server.ts` documents, because the
 *   catch-all means nothing is ever unhandled. A test that wants a 404 declares
 *   one.
 * - *Ambiguous.* Suffix matching genuinely can collide: `"POST /comments"` and
 *   `"POST /tasks/42/comments"` both match `POST /api/v1/tasks/42/comments`,
 *   and **both spellings are in use across this suite**. First-match-wins would
 *   silently pick by object key order. (It does *not* collide for
 *   `/tasks` vs `/tasks/facets` — `"/api/v1/tasks/facets"` does not end
 *   with `"/tasks"` — so there is no route-ordering rule here, only this
 *   check.)
 */
/**
 * The default answer for `GET /integrations/github` — off, the state of a
 * self-hosted instance with neither `GITHUB_TOKEN` nor
 * `GITHUB_WEBHOOK_SECRET` set.
 *
 * Applied automatically by `mockApi()` unless a test declares its own handler
 * for that key. Almost every screen in this app now mounts a query for it (the
 * list header's import button, and `TaskLinks`' per-link status badge), and
 * that query is entirely incidental to what most tests are about — without
 * this default, every one of them would have to name a handler for a feature
 * they are not testing, just to satisfy `onUnhandledRequest: "error"`.
 */
const DEFAULT_GITHUB_INTEGRATION_HANDLER: RouteHandler = () => ({
  body: {
    enabled: false,
    tokenConfigured: false,
    webhookConfigured: false,
    webhookPath: "/integrations/github/webhook",
  },
});

export const mockApi = (handlers: Record<string, RouteHandler>): { requests: MockRequest[] } => {
  const requests: MockRequest[] = [];
  const effectiveHandlers: Record<string, RouteHandler> = {
    "GET /integrations/github": DEFAULT_GITHUB_INTEGRATION_HANDLER,
    ...handlers,
  };

  server.use(
    http.all("*", async ({ request }) => {
      const url = new URL(request.url);
      const method = request.method.toUpperCase();
      const raw = await request.text();
      const record: MockRequest = {
        method,
        url,
        body: raw === "" ? undefined : JSON.parse(raw),
      };
      requests.push(record);

      const matches = Object.keys(effectiveHandlers).filter((candidate) => {
        const [handlerMethod, path] = candidate.split(" ");
        return handlerMethod === method && url.pathname.endsWith(path ?? "");
      });

      const where = `${method} ${url.pathname}`;
      if (matches.length !== 1) {
        harnessFaults.push(
          matches.length === 0
            ? `mockApi: no handler for ${where}. Declared: [${Object.keys(effectiveHandlers).join(", ")}]`
            : `mockApi: ${where} matches ${matches.length} handlers [${matches.join(", ")}] — the suffixes are ambiguous, so which one answers is decided by key order`,
        );
        return HttpResponse.json(
          { error: { code: "INTERNAL_ERROR", message: where, requestId: "harness" } },
          { status: 500 },
        );
      }

      const key = matches[0]!;
      const { status = 200, body } = await effectiveHandlers[key]!(record);
      if (status === 204) return new HttpResponse(null, { status: 204 });

      // `JSON.stringify` rather than `HttpResponse.json`, which types its body
      // as `JsonBodyType` and — more importantly — answers an `undefined` body
      // with an empty 200 that `http.ts` reads as "no content". A handler that
      // forgot its body should surface as MALFORMED_RESPONSE, the same as a
      // real server sending nothing, not silently resolve to `undefined`.
      return new HttpResponse(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );

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

/**
 * The router is returned as well as the render result: `initialEntries` plus
 * `router.navigate(-1)` is the only way to assert what **Back** does, and
 * whether a navigation pushed or replaced is invisible from the rendered output
 * alone — both spellings put the same screen on screen.
 */
export const renderRoute = ({
  routes,
  initialEntries = ["/"],
  queryClient = makeQueryClient(),
}: RenderRouteOptions): RenderResult & {
  queryClient: QueryClient;
  router: ReturnType<typeof createMemoryRouter>;
} => {
  const router = createMemoryRouter(routes, { initialEntries: initialEntries as never });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...result, queryClient, router };
};

/** Wraps `children` in the providers, on a single throwaway route. */
export const renderInProviders = (
  children: ReactNode,
  options: Omit<RenderRouteOptions, "routes"> = {},
): RenderResult & { queryClient: QueryClient } =>
  renderRoute({ routes: [{ path: "*", element: children }], ...options });
