import {
  TASK_STATUSES,
  type HistoryBucketRow,
  type HistoryResponse,
  type TaskStatus,
} from "@helpdesk/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { LogbookPage } from "@/pages/logbook/LogbookPage";
import { emptyEvents, makePage, makeSummary, mockApi, renderRoute, type RouteHandler } from "@/test/harness";

/**
 * `/logbook`. Each section shares `GET /stats/history`'s one loading/error/empty
 * state (asserted once, since `HistorySection` wires all four the same way);
 * the event log and archive have their own since they carry independent
 * requests.
 */

const statusCounts = (overrides: Partial<Record<TaskStatus, number>> = {}): Record<TaskStatus, number> =>
  Object.fromEntries(TASK_STATUSES.map((status) => [status, overrides[status] ?? 0])) as Record<
    TaskStatus,
    number
  >;

const makeBucket = (overrides: Partial<HistoryBucketRow> = {}): HistoryBucketRow => ({
  start: "2026-09-19T00:00:00.000Z",
  end: "2026-09-20T00:00:00.000Z",
  created: 0,
  completed: 0,
  deferred: 0,
  sentBack: 0,
  statusCounts: statusCounts(),
  humanWait: { count: 0, medianMinutes: null, p90Minutes: null },
  ...overrides,
});

const makeHistory = (overrides: Partial<HistoryResponse> = {}): HistoryResponse => ({
  from: "2026-09-19T00:00:00.000Z",
  to: "2026-09-26T00:00:00.000Z",
  bucket: "day",
  buckets: [makeBucket()],
  totals: {
    created: 0,
    completed: 0,
    deferred: 0,
    sentBack: 0,
    decisionsRequested: 0,
    decisionsAnswered: 0,
    humanWait: { count: 0, medianMinutes: null, p90Minutes: null },
    cycleTime: { count: 0, medianMinutes: null, p90Minutes: null },
  },
  cycleTimes: [],
  longestWaits: [],
  agents: [],
  ...overrides,
});

const renderLogbook = (handlers: Record<string, RouteHandler>, initialEntry = "/logbook") => {
  const api = mockApi({
    "GET /events": () => ({ body: emptyEvents() }),
    "GET /tasks": () => ({ body: makePage([]) }),
    ...handlers,
  });
  const { router } = renderRoute({
    routes: [{ path: "/logbook", element: <LogbookPage /> }],
    initialEntries: [initialEntry],
  });
  return { ...api, router };
};

describe("LogbookPage", () => {
  it("shows an error panel with retry when the history request fails", async () => {
    let attempts = 0;
    renderLogbook({
      "GET /stats/history": () => {
        attempts += 1;
        return attempts === 1
          ? { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "x", requestId: "r" } } }
          : { body: makeHistory() };
      },
    });

    const alerts = await screen.findAllByRole("alert");
    expect(alerts.length).toBeGreaterThan(0);

    const user = userEvent.setup();
    await user.click(within(alerts[0]!).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.queryAllByRole("alert")).toHaveLength(0));
  });

  it("shows each chart section's empty copy when nothing happened in range", async () => {
    renderLogbook({ "GET /stats/history": () => ({ body: makeHistory() }) });

    expect(await screen.findByText("No task activity in this range yet.")).toBeInTheDocument();
    expect(screen.getByText("Nothing was created or shipped in this range.")).toBeInTheDocument();
    expect(screen.getByText("No one waited on a human in this range.")).toBeInTheDocument();
    expect(screen.getByText("No cycle times finished in this range.")).toBeInTheDocument();
    expect(screen.getByText("No agent activity in this range.")).toBeInTheDocument();
  });

  it("renders the flow chart and agents table once there is data", async () => {
    renderLogbook({
      "GET /stats/history": () =>
        ({
          body: makeHistory({
            buckets: [makeBucket({ created: 3, completed: 2, statusCounts: statusCounts({ done: 2, todo: 1 }) })],
            agents: [
              {
                actor: "agent:claude-code",
                submitted: 4,
                approved: 3,
                sentBack: 1,
                decisionsRequested: 2,
                claims: 5,
                releases: 1,
              },
            ],
          }),
        }) as ReturnType<RouteHandler>,
    });

    // Rendered twice — once in the `md`-and-up table, once in the stacked
    // mobile cards; both exist in the DOM at once (CSS toggles which shows).
    expect((await screen.findAllByText("claude-code")).length).toBeGreaterThan(0);
    // QA pass rate: 3 approved of 4 (approved+sentBack) = 75%.
    expect(screen.getAllByText("75%").length).toBeGreaterThan(0);
  });

  it("shows the archive empty state, then a result once the request resolves", async () => {
    renderLogbook({
      "GET /stats/history": () => ({ body: makeHistory() }),
      "GET /tasks": () => ({ body: makePage([makeSummary({ id: 9, title: "Ship the docs", status: "done" })]) }),
    });

    expect((await screen.findAllByRole("link", { name: /Ship the docs/ })).length).toBeGreaterThan(0);
  });

  it("greets a first-time visitor in Since you left", async () => {
    renderLogbook({ "GET /stats/history": () => ({ body: makeHistory() }) });

    expect(
      await screen.findByText(/First time here — the Logbook will remember when you leave/),
    ).toBeInTheDocument();
  });

  it("switches the range and re-requests history with a new window", async () => {
    const { requests } = renderLogbook({ "GET /stats/history": () => ({ body: makeHistory() }) });
    const user = userEvent.setup();

    await screen.findByText("No task activity in this range yet.");
    await user.click(screen.getByRole("button", { name: "Last 30 days" }));

    await waitFor(() =>
      expect(
        requests.some(
          (request) =>
            request.url.pathname.endsWith("/stats/history") && request.url.searchParams.get("bucket") === "day",
        ),
      ).toBe(true),
    );
  });
});
