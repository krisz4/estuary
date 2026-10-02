import { type HistoryBucket } from "@estuary/contracts";

/** The Logbook's range control. Default `7d`; `custom` means the URL carries explicit `from`/`to`. */
export const LOGBOOK_RANGES = ["24h", "7d", "30d", "90d", "custom"] as const;
export type LogbookRange = (typeof LOGBOOK_RANGES)[number];

export const DEFAULT_LOGBOOK_RANGE: LogbookRange = "7d";

export const isLogbookRange = (value: unknown): value is LogbookRange =>
  typeof value === "string" && (LOGBOOK_RANGES as readonly string[]).includes(value);

export const LOGBOOK_RANGE_LABELS: Record<LogbookRange, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  custom: "Custom",
};

const RANGE_MS: Record<Exclude<LogbookRange, "custom">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

/** Auto bucket: hour under 2 days, day under 45 days, week beyond. Matches the plan's 24h/7d·30d/90d mapping. */
export const bucketForSpan = (fromMs: number, toMs: number): HistoryBucket => {
  const spanMs = Math.max(0, toMs - fromMs);
  const days = spanMs / (24 * 60 * 60 * 1000);
  if (days <= 2) return "hour";
  if (days <= 45) return "day";
  return "week";
};

export type LogbookWindow = { from: string; to: string; bucket: HistoryBucket };

/**
 * Resolves the range control (or an explicit `from`/`to`) into the window the
 * `useHistoryQuery` request needs. `to` is always "now" for a preset; a custom
 * range uses exactly what the URL carries.
 */
export const resolveLogbookWindow = (
  range: LogbookRange,
  custom: { from?: string | undefined; to?: string | undefined },
  now: Date = new Date(),
): LogbookWindow => {
  if (range === "custom" && custom.from !== undefined && custom.to !== undefined) {
    const fromMs = Date.parse(custom.from);
    const toMs = Date.parse(custom.to);
    return { from: custom.from, to: custom.to, bucket: bucketForSpan(fromMs, toMs) };
  }

  const preset = range === "custom" ? "7d" : range;
  const toMs = now.getTime();
  const fromMs = toMs - RANGE_MS[preset];
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    bucket: bucketForSpan(fromMs, toMs),
  };
};
