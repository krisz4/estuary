import { TASK_STATUSES, type HistoryBucketRow, type TaskStatus } from "@helpdesk/contracts";
import { LOGBOOK_ZONES, ZONE_LABELS, ZONE_STACK_ORDER, ZONE_STATUSES, type LogbookZone } from "@/features/logbook/zones";

/**
 * The cumulative flow diagram's data, in stacked-area form: for each bucket, a
 * running baseline per band and the band's own height on top of it, in
 * `ZONE_STACK_ORDER` (or lifecycle order for the all-statuses view).
 *
 * Pure and unit-tested on its own — `HistoryBucketRow.statusCounts` is already
 * a snapshot at the bucket's end, so a CFD is a direct stack of those counts,
 * not an accumulation the client has to compute.
 */
export type CfdBand<TKey extends string> = {
  key: TKey;
  label: string;
  /** One value per bucket, aligned with `buckets`. */
  values: number[];
};

export type CfdSeries<TKey extends string> = {
  buckets: HistoryBucketRow[];
  bands: CfdBand<TKey>[];
  /** The highest stacked total across all buckets — the chart's y-axis max. */
  maxTotal: number;
};

export const cfdByZone = (buckets: HistoryBucketRow[]): CfdSeries<LogbookZone> => {
  const bands: CfdBand<LogbookZone>[] = ZONE_STACK_ORDER.map((zone) => ({
    key: zone,
    label: ZONE_LABELS[zone],
    values: buckets.map((bucket) =>
      ZONE_STATUSES[zone].reduce((sum, status) => sum + (bucket.statusCounts[status] ?? 0), 0),
    ),
  }));
  return { buckets, bands, maxTotal: maxStackedTotal(bands) };
};

export const cfdByStatus = (buckets: HistoryBucketRow[]): CfdSeries<TaskStatus> => {
  // Lifecycle order, reversed (closed statuses at the bottom), matching `ZONE_STACK_ORDER`'s
  // shipped-anchors-the-bottom convention.
  const order = [...TASK_STATUSES].reverse();
  const bands: CfdBand<TaskStatus>[] = order.map((status) => ({
    key: status,
    label: status,
    values: buckets.map((bucket) => bucket.statusCounts[status] ?? 0),
  }));
  return { buckets, bands, maxTotal: maxStackedTotal(bands) };
};

const maxStackedTotal = <TKey extends string>(bands: CfdBand<TKey>[]): number => {
  const bucketCount = bands[0]?.values.length ?? 0;
  let max = 0;
  for (let i = 0; i < bucketCount; i += 1) {
    let total = 0;
    for (const band of bands) total += band.values[i] ?? 0;
    if (total > max) max = total;
  }
  return max;
};

export { LOGBOOK_ZONES };
