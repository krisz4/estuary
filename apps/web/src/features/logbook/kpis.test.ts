import { type AgentHistory, type HistoryBucketRow, type HistoryResponse } from "@helpdesk/contracts";
import { describe, expect, it } from "vitest";
import { buildKpiTiles } from "@/features/logbook/kpis";

const bucket = (overrides: Partial<HistoryBucketRow> = {}): HistoryBucketRow => ({
  start: "2026-09-01T00:00:00.000Z",
  end: "2026-09-02T00:00:00.000Z",
  created: 0,
  completed: 0,
  deferred: 0,
  sentBack: 0,
  statusCounts: {} as never,
  humanWait: { count: 0, medianMinutes: null, p90Minutes: null },
  ...overrides,
});

const agent = (overrides: Partial<AgentHistory> = {}): AgentHistory => ({
  actor: "agent:claude-code",
  submitted: 0,
  approved: 0,
  sentBack: 0,
  decisionsRequested: 0,
  claims: 0,
  releases: 0,
  ...overrides,
});

const history = (overrides: Partial<HistoryResponse> = {}): HistoryResponse => ({
  from: "2026-09-01T00:00:00.000Z",
  to: "2026-09-08T00:00:00.000Z",
  bucket: "day",
  buckets: [],
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

describe("buildKpiTiles", () => {
  it("reports shipped and created totals with a normalised sparkline", () => {
    const data = history({
      buckets: [bucket({ created: 2, completed: 1 }), bucket({ created: 4, completed: 2, deferred: 1 })],
      totals: {
        created: 6,
        completed: 3,
        deferred: 1,
        sentBack: 0,
        decisionsRequested: 0,
        decisionsAnswered: 0,
        humanWait: { count: 0, medianMinutes: null, p90Minutes: null },
        cycleTime: { count: 0, medianMinutes: null, p90Minutes: null },
      },
    });

    const tiles = buildKpiTiles(data);
    const shipped = tiles.find((tile) => tile.key === "shipped")!;
    const created = tiles.find((tile) => tile.key === "created")!;

    expect(shipped.value).toBe("4");
    // Bucket shipped values: 1, then 3 (2 completed + 1 deferred) — normalised against the max (3).
    expect(shipped.sparkline).toEqual([1 / 3, 1]);
    expect(created.value).toBe("6");
    expect(created.sparkline).toEqual([2 / 4, 1]);
  });

  it("formats the median human wait, and shows an em dash when there is no data", () => {
    const withData = buildKpiTiles(
      history({ totals: { ...history().totals, humanWait: { count: 3, medianMinutes: 190, p90Minutes: 300 } } }),
    );
    expect(withData.find((tile) => tile.key === "medianWait")!.value).toBe("3h 10m");

    const withoutData = buildKpiTiles(history());
    expect(withoutData.find((tile) => tile.key === "medianWait")!.value).toBe("—");
  });

  it("computes QA pass rate as approved over approved-plus-sent-back across all agents", () => {
    const data = history({
      agents: [agent({ approved: 3, sentBack: 1 }), agent({ actor: "agent:claude-code-ci", approved: 6, sentBack: 0 })],
    });
    expect(buildKpiTiles(data).find((tile) => tile.key === "qaPassRate")!.value).toBe("90%");
  });

  it("shows an em dash for QA pass rate when nobody has been through QA yet", () => {
    expect(buildKpiTiles(history()).find((tile) => tile.key === "qaPassRate")!.value).toBe("—");
  });

  it("keeps gaps (null) in a sparkline rather than treating them as zero", () => {
    const data = history({
      buckets: [
        bucket({ humanWait: { count: 0, medianMinutes: null, p90Minutes: null } }),
        bucket({ humanWait: { count: 1, medianMinutes: 60, p90Minutes: 60 } }),
      ],
    });
    const sparkline = buildKpiTiles(data).find((tile) => tile.key === "medianWait")!.sparkline;
    expect(sparkline).toEqual([null, 1]);
  });
});
