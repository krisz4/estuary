import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppLayout } from "@/components/layout/AppLayout";
import { mockApi, renderRoute } from "@/test/harness";
import { routeChildren } from "@/router";

/**
 * `/` is the app's front door — the Map is the landing page now
 * (`docs/pages/App_Shell.md`). One regression test against the real route
 * table (not a hand-rolled stand-in) so a future edit to `router.tsx` cannot
 * silently point the index route back at the list.
 */
describe("the index route", () => {
  it("redirects '/' to '/tasks/map'", async () => {
    mockApi({
      "GET /floor": () => ({
        body: {
          tasks: [],
          edges: [],
          refs: [],
          meta: {
            total: 0,
            truncated: false,
            olderClosedCount: 0,
            statusCounts: {
              backlog: 0,
              needs_refinement: 0,
              todo: 0,
              in_progress: 0,
              blocked: 0,
              needs_user_decision: 0,
              needs_user_action: 0,
              needs_qa: 0,
              done: 0,
              deferred: 0,
            },
            matchCount: 0,
            shippedSince: "2026-01-01T00:00:00.000Z",
            at: null,
            lastEventId: 0,
            generatedAt: "2026-01-02T00:00:00.000Z",
          },
        },
      }),
      "GET /tasks/facets": () => ({ body: { assignees: [], projects: [], creators: [], labels: [] } }),
      "GET /events": () => ({ body: { data: [], meta: { nextAfter: 0, nextBefore: null, hasMore: false } } }),
      "GET /tasks": () => ({ body: { data: [], meta: { total: 0 } } }),
      "GET /tasks/stats": () => ({ body: { total: 0, byStatus: {}, byPriority: {} } }),
      "GET /stats/history": () => ({
        body: {
          range: { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z", bucket: "day" },
          buckets: [],
          cycleTimes: [],
          longestWaits: [],
          agents: [],
        },
      }),
    });

    const { router } = renderRoute({
      routes: [{ element: <AppLayout />, children: routeChildren }],
      initialEntries: ["/"],
    });

    await waitFor(() => expect(router.state.location.pathname).toBe("/tasks/map"));
  });
});

/**
 * The Kanban board was retired in favor of the Map (Estuary). `/tasks/board`
 * redirects rather than 404s, preserving the query string, so a bookmark or a
 * link shared before the retirement still lands somewhere useful.
 */
describe("the retired board route", () => {
  it("redirects '/tasks/board' to '/tasks/map', keeping the query string", async () => {
    mockApi({
      "GET /floor": () => ({
        body: {
          tasks: [],
          edges: [],
          refs: [],
          meta: {
            total: 0,
            truncated: false,
            olderClosedCount: 0,
            statusCounts: {
              backlog: 0,
              needs_refinement: 0,
              todo: 0,
              in_progress: 0,
              blocked: 0,
              needs_user_decision: 0,
              needs_user_action: 0,
              needs_qa: 0,
              done: 0,
              deferred: 0,
            },
            matchCount: 0,
            shippedSince: "2026-01-01T00:00:00.000Z",
            at: null,
            lastEventId: 0,
            generatedAt: "2026-01-02T00:00:00.000Z",
          },
        },
      }),
      "GET /tasks/facets": () => ({ body: { assignees: [], projects: [], creators: [], labels: [] } }),
      "GET /events": () => ({ body: { data: [], meta: { nextAfter: 0, nextBefore: null, hasMore: false } } }),
      "GET /tasks": () => ({ body: { data: [], meta: { total: 0 } } }),
      "GET /tasks/stats": () => ({ body: { total: 0, byStatus: {}, byPriority: {} } }),
      "GET /stats/history": () => ({
        body: {
          range: { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z", bucket: "day" },
          buckets: [],
          cycleTimes: [],
          longestWaits: [],
          agents: [],
        },
      }),
    });

    const { router } = renderRoute({
      routes: [{ element: <AppLayout />, children: routeChildren }],
      initialEntries: ["/tasks/board?status=open"],
    });

    await waitFor(() =>
      expect(router.state.location.pathname + router.state.location.search).toBe(
        "/tasks/map?status=open",
      ),
    );
  });
});
