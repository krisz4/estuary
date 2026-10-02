import { type HistoryBucketRow } from "@estuary/contracts";

/** One bucket's throughput bar: created vs shipped (`completed + deferred`), plus sent-back. */
export type ThroughputPoint = {
  start: string;
  end: string;
  created: number;
  shipped: number;
  sentBack: number;
};

export const throughputSeries = (buckets: HistoryBucketRow[]): ThroughputPoint[] =>
  buckets.map((bucket) => ({
    start: bucket.start,
    end: bucket.end,
    created: bucket.created,
    shipped: bucket.completed + bucket.deferred,
    sentBack: bucket.sentBack,
  }));

/** The chart's y-axis max: the tallest of created/shipped across the range. */
export const throughputMax = (points: ThroughputPoint[]): number =>
  points.reduce((max, point) => Math.max(max, point.created, point.shipped), 0);
