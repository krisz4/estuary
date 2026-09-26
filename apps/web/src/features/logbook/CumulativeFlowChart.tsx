import { useId, useState } from "react";
import { type CfdBand, type CfdSeries } from "@/features/logbook/cfd";
import { formatDate } from "@/lib/formatting";
import { cn } from "@/lib/cn";

const WIDTH = 640;
const HEIGHT = 220;
const PAD_LEFT = 36;
const PAD_BOTTOM = 20;
const PAD_TOP = 8;

export type CumulativeFlowChartProps<TKey extends string> = {
  series: CfdSeries<TKey>;
  colorOf: (key: TKey) => { stroke: string; fill: string };
  title: string;
};

/**
 * Stacked-area cumulative flow diagram, hand-rolled SVG.
 *
 * Accessible via `role="img"` with a computed summary as the accessible name,
 * plus a `sr-only` data table carrying every value a sighted reader gets from
 * the shape of the bands. A hidden `<table>` rather than nothing: a screen
 * reader user gets the same numbers, not just "there is a chart here".
 */
export const CumulativeFlowChart = <TKey extends string>({
  series,
  colorOf,
  title,
}: CumulativeFlowChartProps<TKey>) => {
  const titleId = useId();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const { buckets, bands, maxTotal } = series;

  if (buckets.length === 0) return null;

  const plotWidth = WIDTH - PAD_LEFT;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const scaleY = maxTotal === 0 ? 0 : plotHeight / maxTotal;
  const stepX = buckets.length > 1 ? plotWidth / (buckets.length - 1) : 0;

  // Running baseline per bucket, band by band.
  const baselines: number[][] = bands.map(() => []);
  for (let i = 0; i < buckets.length; i += 1) {
    let running = 0;
    bands.forEach((band, bandIndex) => {
      baselines[bandIndex]![i] = running;
      running += band.values[i] ?? 0;
    });
  }

  const x = (i: number): number => PAD_LEFT + (buckets.length === 1 ? plotWidth / 2 : i * stepX);
  const y = (value: number): number => PAD_TOP + plotHeight - value * scaleY;

  const areaPath = (band: CfdBand<TKey>, bandIndex: number): string => {
    const top = buckets.map(
      (_, i) => `${x(i)},${y(baselines[bandIndex]![i]! + (band.values[i] ?? 0))}`,
    );
    const bottom = buckets.map((_, i) => `${x(i)},${y(baselines[bandIndex]![i]!)}`).reverse();
    return `M${top.join(" L")} L${bottom.join(" L")} Z`;
  };

  const tickIndices = pickTicks(buckets.length);

  return (
    <div className="flex flex-col gap-2">
      {/*
        `overflow-x-auto` around a `min-w`'d SVG, not a bare `min-w-full` SVG:
        this is the one chart the plan allows horizontal scroll *inside* at
        the widest range (many weekly buckets at 90d) — contained to this box,
        never the page. Every other chart shrinks fluidly via its `viewBox`
        instead (see `ThroughputChart` etc.) and never forces a scrollbar. On
        anything wider than `min-w-[480px]` (any tablet/desktop card), the
        `min-w` never binds and this div is exactly the card's width — no
        scroll there.

        `preserveAspectRatio="none"`, not the SVG default ("meet"): the
        viewBox's fixed 640×220 aspect is far narrower than a wide desktop
        card's actual box (e.g. 1100×224), so "meet" was fitting the content
        to the *shorter* axis and letterboxing empty space on both sides —
        the chart rendering at only ~60% of the card's width. `none` stretches
        non-uniformly to fill the box exactly, which is fine here: nothing in
        this chart depends on x and y sharing a scale.
      */}
      <div className="overflow-x-auto">
        <svg
          role="img"
          aria-labelledby={titleId}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          className="h-56 w-full min-w-[480px]"
          onMouseLeave={() => setHoverIndex(null)}
        >
          <title id={titleId}>{title}</title>
          {/* Y-axis gridlines */}
          {[0, 0.5, 1].map((fraction) => (
            <line
              key={fraction}
              x1={PAD_LEFT}
              x2={WIDTH}
              y1={PAD_TOP + plotHeight * (1 - fraction)}
              y2={PAD_TOP + plotHeight * (1 - fraction)}
              stroke="var(--border)"
              strokeWidth={1}
            />
          ))}
          <text x={2} y={PAD_TOP + 4} className="fill-muted-foreground text-[9px]">
            {maxTotal}
          </text>
          <text x={2} y={PAD_TOP + plotHeight} className="fill-muted-foreground text-[9px]">
            0
          </text>

          {bands.map((band, bandIndex) => {
            const color = colorOf(band.key);
            return (
              <path
                key={band.key}
                d={areaPath(band, bandIndex)}
                fill={color.fill}
                stroke={color.stroke}
                strokeWidth={1}
              />
            );
          })}

          {/* Hover/focus targets — one per bucket, full column height */}
          {buckets.map((bucket, i) => (
            <rect
              key={bucket.start}
              x={x(i) - stepX / 2}
              y={PAD_TOP}
              width={Math.max(stepX, 4)}
              height={plotHeight}
              fill="transparent"
              tabIndex={0}
              aria-label={`${formatDate(bucket.start)}: ${bands
                .map((band) => `${band.label} ${band.values[i] ?? 0}`)
                .join(", ")}`}
              onMouseEnter={() => setHoverIndex(i)}
              onFocus={() => setHoverIndex(i)}
              onBlur={() => setHoverIndex(null)}
              className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            />
          ))}
          {hoverIndex !== null ? (
            <line
              x1={x(hoverIndex)}
              x2={x(hoverIndex)}
              y1={PAD_TOP}
              y2={PAD_TOP + plotHeight}
              stroke="var(--foreground)"
              strokeDasharray="2 2"
            />
          ) : null}

          {tickIndices.map((i) => (
            <text
              key={i}
              x={x(i)}
              y={HEIGHT - 4}
              // The first/last tick sit exactly at the plot's left/right
              // edge — a centred anchor there draws half the label past the
              // SVG's own bounds, clipped by it (only visible once
              // `preserveAspectRatio="none"` stretches the chart to actually
              // reach the card's true edges instead of leaving margin).
              textAnchor={i === 0 ? "start" : i === buckets.length - 1 ? "end" : "middle"}
              className="fill-muted-foreground text-[9px]"
            >
              {formatDate(buckets[i]!.start)}
            </text>
          ))}
        </svg>
      </div>

      {hoverIndex !== null ? (
        <div
          role="status"
          className="flex flex-wrap gap-x-3 gap-y-1 rounded-md border border-border bg-card px-3 py-2 text-xs"
        >
          <span className="font-medium text-foreground">
            {formatDate(buckets[hoverIndex]!.start)}
          </span>
          {bands.map((band) => (
            <span key={band.key} className="text-muted-foreground">
              {band.label}:{" "}
              <span className="font-mono text-foreground">{band.values[hoverIndex] ?? 0}</span>
            </span>
          ))}
        </div>
      ) : null}

      <Legend bands={bands} colorOf={colorOf} />

      <div className="sr-only">
        <table>
          <caption>{title}</caption>
          <thead>
            <tr>
              <th scope="col">Bucket</th>
              {bands.map((band) => (
                <th scope="col" key={band.key}>
                  {band.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket, i) => (
              <tr key={bucket.start}>
                <th scope="row">{formatDate(bucket.start)}</th>
                {bands.map((band) => (
                  <td key={band.key}>{band.values[i] ?? 0}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const Legend = <TKey extends string>({
  bands,
  colorOf,
}: {
  bands: CfdBand<TKey>[];
  colorOf: (key: TKey) => { stroke: string; fill: string };
}) => (
  <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
    {bands.map((band) => (
      <li key={band.key} className={cn("inline-flex items-center gap-1.5")}>
        <span
          aria-hidden="true"
          className="inline-block size-2.5 rounded-sm"
          style={{ backgroundColor: colorOf(band.key).stroke }}
        />
        {band.label}
      </li>
    ))}
  </ul>
);

/** At most 6 x-axis labels, evenly spaced, always including the first and last bucket. */
const pickTicks = (count: number): number[] => {
  if (count <= 1) return [0];
  const maxTicks = Math.min(6, count);
  const step = (count - 1) / (maxTicks - 1);
  return Array.from({ length: maxTicks }, (_, i) => Math.round(i * step));
};
