import { type HistoryResponse } from "@estuary/contracts";
import { formatWaitDuration } from "@/features/logbook/waiting";

export type KpiKey = "shipped" | "created" | "medianWait" | "qaPassRate";

export type KpiTile = {
  key: KpiKey;
  label: string;
  /** Formatted for display — "42", "3h 20m", "75%", "—" when there is no data yet. */
  value: string;
  /**
   * One point per history bucket, already normalised to `[0, 1]` (or `null`
   * for a bucket with no data — a gap in the sparkline, same convention as
   * `WaitingChart`). Empty when there is nothing to draw yet.
   */
  sparkline: (number | null)[];
};

/**
 * The four "at a glance" tiles atop the Logbook: Shipped, Created, Median
 * wait on humans, and QA pass rate, each for the selected range with a tiny
 * sparkline over the same buckets the Flow chart below draws from.
 *
 * QA pass rate's sparkline is an approximation: `HistoryBucketRow` does not
 * carry a per-bucket submitted/approved split (only the range `totals` and
 * the per-agent breakdown do), so each bucket's point uses
 * `completed / (completed + sentBack)` as a proxy for "how much of what
 * finished this bucket was approved rather than sent back" — the headline
 * value uses the accurate range-wide `approved / (approved + sentBack)` from
 * `agents` instead, which is exact.
 */
export const buildKpiTiles = (data: HistoryResponse): KpiTile[] => {
  const shippedSeries = data.buckets.map((bucket) => bucket.completed + bucket.deferred);
  const createdSeries = data.buckets.map((bucket) => bucket.created);
  const medianWaitSeries = data.buckets.map((bucket) => bucket.humanWait.medianMinutes);
  const qaSeries = data.buckets.map((bucket) => {
    const denom = bucket.completed + bucket.sentBack;
    return denom === 0 ? null : bucket.completed / denom;
  });

  const totalApproved = data.agents.reduce((sum, agent) => sum + agent.approved, 0);
  const totalSentBack = data.agents.reduce((sum, agent) => sum + agent.sentBack, 0);
  const qaDenominator = totalApproved + totalSentBack;

  return [
    {
      key: "shipped",
      label: "Shipped",
      value: (data.totals.completed + data.totals.deferred).toLocaleString(),
      sparkline: normalize(shippedSeries),
    },
    {
      key: "created",
      label: "Created",
      value: data.totals.created.toLocaleString(),
      sparkline: normalize(createdSeries),
    },
    {
      key: "medianWait",
      label: "Median wait on humans",
      value:
        data.totals.humanWait.medianMinutes === null
          ? "—"
          : formatWaitDuration(data.totals.humanWait.medianMinutes),
      sparkline: normalize(medianWaitSeries),
    },
    {
      key: "qaPassRate",
      label: "QA pass rate",
      value: qaDenominator === 0 ? "—" : `${Math.round((totalApproved / qaDenominator) * 100)}%`,
      sparkline: normalize(qaSeries),
    },
  ];
};

/** Scales a series of (possibly `null`) values to `[0, 1]` against its own max, preserving gaps. */
const normalize = (values: (number | null)[]): (number | null)[] => {
  const max = Math.max(0, ...values.filter((v): v is number => v !== null));
  if (max === 0) return values.map((v) => (v === null ? null : 0));
  return values.map((v) => (v === null ? null : v / max));
};
