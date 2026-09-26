import { useId, useState } from "react";
import { formatWaitDuration, waitingMax, type WaitingPoint } from "@/features/logbook/waiting";
import { formatDate } from "@/lib/formatting";

const WIDTH = 640;
const HEIGHT = 200;
const PAD_LEFT = 40;
const PAD_BOTTOM = 20;
const PAD_TOP = 8;

export type WaitingChartProps = {
  points: WaitingPoint[];
};

/** Median and p90 minutes spent waiting on a human, per bucket. Gaps where a bucket had no waits. */
export const WaitingChart = ({ points }: WaitingChartProps) => {
  const titleId = useId();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (points.length === 0) return null;

  const max = Math.max(1, waitingMax(points));
  const plotWidth = WIDTH - PAD_LEFT;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const stepX = points.length > 1 ? plotWidth / (points.length - 1) : 0;
  const scaleY = plotHeight / max;

  const x = (i: number) => PAD_LEFT + (points.length === 1 ? plotWidth / 2 : i * stepX);
  const y = (minutes: number) => PAD_TOP + plotHeight - minutes * scaleY;

  const linePath = (pick: (point: WaitingPoint) => number | null): string =>
    points
      .map((point, i) => {
        const value = pick(point);
        return value === null ? null : `${i === 0 ? "M" : "L"}${x(i)},${y(value)}`;
      })
      .filter((segment): segment is string => segment !== null)
      .join(" ");

  return (
    <div className="flex flex-col gap-2">
      <svg
        role="img"
        aria-labelledby={titleId}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        // `none`, not the SVG default ("meet") — see `CumulativeFlowChart` for
        // why the default was letterboxing a wide desktop card down to ~60%
        // of its actual width.
        preserveAspectRatio="none"
        className="h-52 w-full"
        onMouseLeave={() => setHoverIndex(null)}
      >
        <title id={titleId}>
          Median and 90th percentile minutes spent waiting on a human, per bucket
        </title>
        <line
          x1={PAD_LEFT}
          x2={WIDTH}
          y1={PAD_TOP + plotHeight}
          y2={PAD_TOP + plotHeight}
          stroke="var(--border)"
        />
        <text x={2} y={PAD_TOP + 4} className="fill-muted-foreground text-[9px]">
          {formatWaitDuration(max)}
        </text>
        <text x={2} y={PAD_TOP + plotHeight} className="fill-muted-foreground text-[9px]">
          0
        </text>

        <path
          d={linePath((p) => p.p90Minutes)}
          fill="none"
          stroke="var(--map-pool-block)"
          strokeWidth={2}
          strokeDasharray="4 3"
        />
        <path
          d={linePath((p) => p.medianMinutes)}
          fill="none"
          stroke="var(--map-pool-attn)"
          strokeWidth={2}
        />

        {points.map((point, i) =>
          point.medianMinutes === null ? null : (
            <circle
              key={`m-${point.start}`}
              cx={x(i)}
              cy={y(point.medianMinutes)}
              r={2.5}
              fill="var(--map-pool-attn)"
            />
          ),
        )}
        {points.map((point, i) =>
          point.p90Minutes === null ? null : (
            <circle
              key={`p-${point.start}`}
              cx={x(i)}
              cy={y(point.p90Minutes)}
              r={2.5}
              fill="var(--map-pool-block)"
            />
          ),
        )}

        {points.map((point, i) => (
          <rect
            key={point.start}
            x={x(i) - stepX / 2}
            y={PAD_TOP}
            width={Math.max(stepX, 4)}
            height={plotHeight}
            fill="transparent"
            tabIndex={0}
            aria-label={`${formatDate(point.start)}: median ${
              point.medianMinutes === null ? "no data" : formatWaitDuration(point.medianMinutes)
            }, p90 ${point.p90Minutes === null ? "no data" : formatWaitDuration(point.p90Minutes)}`}
            onMouseEnter={() => setHoverIndex(i)}
            onFocus={() => setHoverIndex(i)}
            onBlur={() => setHoverIndex(null)}
            className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          />
        ))}
      </svg>

      {hoverIndex !== null ? (
        <div
          role="status"
          className="flex flex-wrap gap-x-3 gap-y-1 rounded-md border border-border bg-card px-3 py-2 text-xs"
        >
          <span className="font-medium text-foreground">
            {formatDate(points[hoverIndex]!.start)}
          </span>
          <span className="text-muted-foreground">
            Median:{" "}
            <span className="font-mono text-foreground">
              {points[hoverIndex]!.medianMinutes === null
                ? "—"
                : formatWaitDuration(points[hoverIndex]!.medianMinutes!)}
            </span>
          </span>
          <span className="text-muted-foreground">
            p90:{" "}
            <span className="font-mono text-foreground">
              {points[hoverIndex]!.p90Minutes === null
                ? "—"
                : formatWaitDuration(points[hoverIndex]!.p90Minutes!)}
            </span>
          </span>
        </div>
      ) : null}

      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <li className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-0.5 w-3 bg-map-pool-attn" />
          Median
        </li>
        <li className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block h-0.5 w-3 border-t-2 border-dashed border-map-pool-block"
          />
          p90
        </li>
      </ul>

      <div className="sr-only">
        <table>
          <caption>Median and p90 minutes waiting on a human, per bucket</caption>
          <thead>
            <tr>
              <th scope="col">Bucket</th>
              <th scope="col">Median</th>
              <th scope="col">p90</th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.start}>
                <th scope="row">{formatDate(point.start)}</th>
                <td>
                  {point.medianMinutes === null ? "—" : formatWaitDuration(point.medianMinutes)}
                </td>
                <td>{point.p90Minutes === null ? "—" : formatWaitDuration(point.p90Minutes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
