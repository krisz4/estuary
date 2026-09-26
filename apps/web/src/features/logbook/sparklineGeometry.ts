/**
 * Pure geometry for `Sparkline` — a tiny gap-aware trend line. Split out from
 * the component so the series → dots/segments mapping is unit-testable
 * without rendering.
 */

/** Fewer real data points than this and a line reads as noise, not a trend — show a placeholder instead. */
export const MIN_SPARKLINE_POINTS = 3;

export type SparklineDot = { x: number; y: number; index: number };

/**
 * One line segment between two consecutive *available* points.
 * `dashed` is true when the two points are not adjacent in the original
 * series — i.e. the segment bridges one or more `null` buckets — so it
 * renders as a faint dotted line rather than implying a real trend across
 * data that was never measured.
 */
export type SparklineSegment = { d: string; dashed: boolean };

export type SparklineGeometry =
  | { hasEnoughData: false }
  | { hasEnoughData: true; dots: SparklineDot[]; segments: SparklineSegment[] };

export type SparklineGeometryOptions = {
  width?: number;
  height?: number;
  pad?: number;
};

/**
 * Builds dot positions and line segments for a series of `[0, 1]`-normalised
 * values (`null` = no data for that bucket, a gap). Two isolated points (or
 * fewer) with wide gaps around them render as a single stray mark that reads
 * as noise rather than a trend — `hasEnoughData` is false below
 * `MIN_SPARKLINE_POINTS` real values, and the caller shows a muted
 * placeholder instead of a line.
 */
export const buildSparklineGeometry = (
  points: (number | null)[],
  { width = 96, height = 28, pad = 3 }: SparklineGeometryOptions = {},
): SparklineGeometry => {
  const validCount = points.filter((v): v is number => v !== null).length;
  if (validCount < MIN_SPARKLINE_POINTS) return { hasEnoughData: false };

  const stepX = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
  const x = (i: number) => pad + i * stepX;
  const y = (v: number) => pad + (1 - v) * (height - pad * 2);

  const dots: SparklineDot[] = [];
  const segments: SparklineSegment[] = [];
  let prevIndex: number | null = null;

  points.forEach((v, i) => {
    if (v === null) return;
    dots.push({ x: x(i), y: y(v), index: i });
    if (prevIndex !== null) {
      const prevValue = points[prevIndex] as number;
      segments.push({
        d: `M${x(prevIndex)},${y(prevValue)} L${x(i)},${y(v)}`,
        dashed: i - prevIndex > 1,
      });
    }
    prevIndex = i;
  });

  return { hasEnoughData: true, dots, segments };
};
