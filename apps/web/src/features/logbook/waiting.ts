import { type HistoryBucketRow, type HumanWait } from "@helpdesk/contracts";

/** One bucket's human-wait stats, for the median/p90 chart. `null` minutes render as a gap. */
export type WaitingPoint = {
  start: string;
  end: string;
  medianMinutes: number | null;
  p90Minutes: number | null;
  count: number;
};

export const waitingSeries = (buckets: HistoryBucketRow[]): WaitingPoint[] =>
  buckets.map((bucket) => ({
    start: bucket.start,
    end: bucket.end,
    medianMinutes: bucket.humanWait.medianMinutes,
    p90Minutes: bucket.humanWait.p90Minutes,
    count: bucket.humanWait.count,
  }));

export const waitingMax = (points: WaitingPoint[]): number =>
  points.reduce((max, point) => Math.max(max, point.medianMinutes ?? 0, point.p90Minutes ?? 0), 0);

/** A wait still ongoing at "now" — `endedAt === null`. These sort first and get a call-out. */
export const isStillWaiting = (wait: HumanWait): boolean => wait.endedAt === null;

/** Minutes → "3h 20m" / "45m" / "2d 4h", for the longest-waits list. */
export const formatWaitDuration = (minutes: number): string => {
  const totalMinutes = Math.max(0, Math.round(minutes));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const mins = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
};
