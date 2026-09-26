import { useId, useState } from "react";
import { throughputMax, type ThroughputPoint } from "@/features/logbook/throughput";
import { formatDate } from "@/lib/formatting";

const WIDTH = 640;
const HEIGHT = 200;
const PAD_LEFT = 32;
const PAD_BOTTOM = 34;
const PAD_TOP = 8;

export type ThroughputChartProps = {
  points: ThroughputPoint[];
};

/** Created vs shipped, grouped bars per bucket, with sent-back as a number under the axis. */
export const ThroughputChart = ({ points }: ThroughputChartProps) => {
  const titleId = useId();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (points.length === 0) return null;

  const max = Math.max(1, throughputMax(points));
  const plotWidth = WIDTH - PAD_LEFT;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const groupWidth = plotWidth / points.length;
  const barWidth = Math.min(18, groupWidth / 3);
  const scaleY = plotHeight / max;
  // At most 6 x-axis date labels — every bucket's label overlapping into
  // illegible mush is exactly what a `90d`/day-bucket range produced before
  // this (same tick-picking `CumulativeFlowChart` already does).
  const tickIndices = new Set(pickTicks(points.length));

  return (
    <div className="flex flex-col gap-2">
      <svg
        role="img"
        aria-labelledby={titleId}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        // `none`, not the SVG default ("meet") — the fixed 640×200 viewBox is
        // narrower than a wide desktop card, so "meet" fits to the shorter
        // axis and letterboxes empty space on the sides instead of filling
        // the card. See `CumulativeFlowChart` for the fuller explanation.
        preserveAspectRatio="none"
        className="h-52 w-full"
        onMouseLeave={() => setHoverIndex(null)}
      >
        <title id={titleId}>Created versus shipped tasks per bucket, with sent-back counts</title>
        <line
          x1={PAD_LEFT}
          x2={WIDTH}
          y1={PAD_TOP + plotHeight}
          y2={PAD_TOP + plotHeight}
          stroke="var(--border)"
        />

        {points.map((point, i) => {
          const groupX = PAD_LEFT + i * groupWidth + groupWidth / 2;
          const createdHeight = point.created * scaleY;
          const shippedHeight = point.shipped * scaleY;
          return (
            <g key={point.start}>
              <rect
                x={groupX - barWidth - 2}
                y={PAD_TOP + plotHeight - createdHeight}
                width={barWidth}
                height={createdHeight}
                fill="var(--map-ink-3)"
              />
              <rect
                x={groupX + 2}
                y={PAD_TOP + plotHeight - shippedHeight}
                width={barWidth}
                height={shippedHeight}
                fill="var(--map-water-edge)"
              />
              {point.sentBack > 0 ? (
                <text
                  x={groupX}
                  y={HEIGHT - PAD_BOTTOM + 12}
                  textAnchor="middle"
                  className="fill-map-pool-attn text-[9px] font-semibold"
                >
                  ↩{point.sentBack}
                </text>
              ) : null}
              {tickIndices.has(i) ? (
                <text
                  x={groupX}
                  y={HEIGHT - 4}
                  // Same edge-clipping fix as `CumulativeFlowChart`: a
                  // centred anchor on the first/last tick draws half the
                  // label outside the SVG's own bounds now that
                  // `preserveAspectRatio="none"` stretches the chart to the
                  // card's true edges.
                  textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
                  className="fill-muted-foreground text-[9px]"
                >
                  {formatDate(point.start)}
                </text>
              ) : null}
              <rect
                x={groupX - groupWidth / 2}
                y={PAD_TOP}
                width={groupWidth}
                height={plotHeight}
                fill="transparent"
                tabIndex={0}
                aria-label={`${formatDate(point.start)}: ${point.created} created, ${point.shipped} shipped, ${point.sentBack} sent back from QA`}
                onMouseEnter={() => setHoverIndex(i)}
                onFocus={() => setHoverIndex(i)}
                onBlur={() => setHoverIndex(null)}
                className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
              />
            </g>
          );
        })}
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
            Created:{" "}
            <span className="font-mono text-foreground">{points[hoverIndex]!.created}</span>
          </span>
          <span className="text-muted-foreground">
            Shipped:{" "}
            <span className="font-mono text-foreground">{points[hoverIndex]!.shipped}</span>
          </span>
          <span className="text-muted-foreground">
            Sent back:{" "}
            <span className="font-mono text-foreground">{points[hoverIndex]!.sentBack}</span>
          </span>
        </div>
      ) : null}

      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <li className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block size-2.5 rounded-sm bg-map-ink-3" />
          Created
        </li>
        <li className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block size-2.5 rounded-sm bg-map-water-edge" />
          Shipped
        </li>
        <li className="inline-flex items-center gap-1.5 text-map-pool-attn">↩ Sent back from QA</li>
      </ul>

      <div className="sr-only">
        <table>
          <caption>Created versus shipped tasks per bucket</caption>
          <thead>
            <tr>
              <th scope="col">Bucket</th>
              <th scope="col">Created</th>
              <th scope="col">Shipped</th>
              <th scope="col">Sent back</th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.start}>
                <th scope="row">{formatDate(point.start)}</th>
                <td>{point.created}</td>
                <td>{point.shipped}</td>
                <td>{point.sentBack}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/** At most 6 x-axis labels, evenly spaced, always including the first and last bucket. */
const pickTicks = (count: number): number[] => {
  if (count <= 1) return [0];
  const maxTicks = Math.min(6, count);
  const step = (count - 1) / (maxTicks - 1);
  return Array.from({ length: maxTicks }, (_, i) => Math.round(i * step));
};
