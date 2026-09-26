import { buildSparklineGeometry } from "@/features/logbook/sparklineGeometry";
import { cn } from "@/lib/cn";

const WIDTH = 96;
const HEIGHT = 28;

export type SparklineProps = {
  /** Already normalised to `[0, 1]`; `null` renders as a gap, same convention as `WaitingChart`. */
  points: (number | null)[];
  color: string;
  className?: string;
};

/**
 * A tiny inline trend line for a KPI tile — decorative (`aria-hidden`; the
 * tile's own numeric value and label carry the meaning for assistive tech,
 * same as `Briefing`'s tide tiles carry no chart at all).
 *
 * Gap-aware: each available bucket gets its own dot; two dots adjacent in
 * the series (no missing bucket between them) connect with a solid line,
 * while a connection that bridges one or more empty buckets renders as a
 * faint dotted one — a lone point every few buckets used to draw as an
 * unreadable zig-zag ("`\ ^ \ /`") when every gap was joined the same way.
 * Below `MIN_SPARKLINE_POINTS` real values there is no trend to show at all,
 * so it falls back to a muted dash rather than a misleading two-point line.
 */
export const Sparkline = ({ points, color, className }: SparklineProps) => {
  const geometry = buildSparklineGeometry(points, { width: WIDTH, height: HEIGHT, pad: 3 });

  if (!geometry.hasEnoughData) {
    return (
      <div aria-hidden="true" className={cn("flex items-center", className ?? "h-7 w-full")}>
        <span className="h-px w-6 border-t border-dashed border-muted-foreground/40" />
      </div>
    );
  }

  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      className={className ?? "h-7 w-full"}
    >
      {geometry.segments.map((segment, i) => (
        <path
          key={i}
          d={segment.d}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeDasharray={segment.dashed ? "2 2" : undefined}
          opacity={segment.dashed ? 0.45 : 1}
        />
      ))}
      {geometry.dots.map((dot) => (
        <circle key={dot.index} cx={dot.x} cy={dot.y} r={1.6} fill={color} />
      ))}
    </svg>
  );
};
