import { type TaskStatus } from "@estuary/contracts";
import { type BadgeTone } from "@/components/ui";
import { MAP_REGIONS, mapRegionOf, type MapRegionKey } from "@/features/floor/layout";
import { STATUS_TONES } from "@/features/tasks/StatusBadge";
import { cn } from "@/lib/cn";
import { TASK_STATUS_LABELS } from "@/lib/formatting";

/**
 * Where a task sits on the river — a compact strip of the Map, for task
 * detail. The four reaches are the Map's own regions (`MAP_REGIONS`:
 * headwaters → the reach → the lagoon → the mouth), so a task shown "in the
 * reach" here is in the reach on the map too. Each of the ten statuses is a
 * station on the water, and the task is the bead at its own station.
 *
 * It orients the reader and nothing more. The statuses are not a line a task
 * walks in order (blocked and the waits come and go), so no station is drawn
 * as "passed". It is one `role="img"` with a sentence for a label rather than
 * ten focus stops: the status select beside it is the control.
 */

/** Column weights — one per station, so every station gets the same room. */
const weightOf = (key: MapRegionKey): number =>
  MAP_REGIONS.find((region) => region.key === key)?.statuses.length ?? 1;

const TOTAL_WEIGHT = MAP_REGIONS.reduce((sum, region) => sum + region.statuses.length, 0);

/** Each station's x position, as a fraction of the strip: evenly spaced inside its reach. */
const STATIONS: readonly { status: TaskStatus; x: number }[] = (() => {
  let offset = 0;
  return MAP_REGIONS.flatMap((region) => {
    const start = offset;
    offset += region.statuses.length;
    return region.statuses.map((status, i) => ({
      status,
      x: (start + i + 0.5) / TOTAL_WEIGHT,
    }));
  });
})();

/*
 * The river's half-width along the strip, as [x, half-width] in a 1000×20
 * viewBox: a thin stream at the headwaters, a swell where work pools in the
 * lagoon, and a mouth that opens out to sea. Eased between keyframes so the
 * banks curve instead of stepping.
 */
const BANKS: readonly [number, number][] = [
  [0, 1.4],
  [280, 2.4],
  [480, 3],
  [540, 5.4],
  [760, 5.4],
  [820, 3.8],
  [1000, 8.5],
];

const halfWidthAt = (x: number): number => {
  for (let i = 1; i < BANKS.length; i++) {
    const [x0, w0] = BANKS[i - 1]!;
    const [x1, w1] = BANKS[i]!;
    if (x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return w0 + (w1 - w0) * t * t * (3 - 2 * t);
    }
  }
  return BANKS[BANKS.length - 1]![1];
};

const RIVER_PATH = (() => {
  const xs = Array.from({ length: 51 }, (_, i) => i * 20);
  const top = xs.map((x) => `${x} ${(10 - halfWidthAt(x)).toFixed(2)}`);
  const bottom = [...xs].reverse().map((x) => `${x} ${(10 + halfWidthAt(x)).toFixed(2)}`);
  return `M${top.join(" L")} L${bottom.join(" L")} Z`;
})();

/** The bead's fill: the status pill's tone as a solid, so the two read as one. */
const BEAD: Record<BadgeTone, string> = {
  neutral: "bg-muted-foreground",
  primary: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  info: "bg-info",
  destructive: "bg-destructive",
  attention: "bg-attention",
};

const titleCase = (name: string): string => name.charAt(0) + name.slice(1).toLowerCase();

export type StatusCourseProps = {
  status: TaskStatus;
  className?: string;
};

export const StatusCourse = ({ status, className }: StatusCourseProps) => {
  const here = mapRegionOf(status);
  const region = MAP_REGIONS.find((candidate) => candidate.key === here)!;
  const bead = BEAD[STATUS_TONES[status]];
  const columns = MAP_REGIONS.map((r) => `${weightOf(r.key)}fr`).join(" ");

  return (
    <div
      role="img"
      aria-label={`On the river: ${titleCase(region.name)}, ${region.place} — at ${TASK_STATUS_LABELS[status]}.`}
      className={cn("flex flex-col gap-1.5", className)}
    >
      <div aria-hidden="true" className="relative h-5">
        <svg
          viewBox="0 0 1000 20"
          preserveAspectRatio="none"
          className="absolute inset-0 size-full overflow-visible"
        >
          <path
            d={RIVER_PATH}
            className="fill-map-water stroke-map-water-edge/60"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {/* The current, as on the map: faint ticks drifting downstream. */}
        <div className="absolute inset-x-[2%] top-1/2 h-px -translate-y-1/2 animate-flow bg-[repeating-linear-gradient(90deg,var(--map-flow)_0_6px,transparent_6px_18px)]" />

        {STATIONS.map((station) =>
          station.status === status ? (
            <span
              key={station.status}
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${station.x * 100}%` }}
            >
              <span className={cn("absolute inset-0 animate-ripple rounded-full", bead)} />
              <span
                className={cn("relative block size-3.5 rounded-full shadow-sm ring-2 ring-card", bead)}
              />
            </span>
          ) : (
            <span
              key={station.status}
              title={TASK_STATUS_LABELS[station.status]}
              className="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-card ring-1 ring-map-water-edge"
              style={{ left: `${station.x * 100}%` }}
            />
          ),
        )}
      </div>

      <div aria-hidden="true" className="grid" style={{ gridTemplateColumns: columns }}>
        {MAP_REGIONS.map((r) => (
          <p
            key={r.key}
            className={cn(
              "truncate text-center text-[11px] leading-4",
              r.key === here ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "mr-1 hidden font-mono text-[10px] tracking-[0.12em] sm:inline",
                r.key === here && "font-semibold",
              )}
            >
              {r.name}
            </span>
            <span className="italic">{r.place}</span>
          </p>
        ))}
      </div>
    </div>
  );
};
