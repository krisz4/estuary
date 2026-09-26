import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { cycleTimeScaleMax, type CycleTimeLane } from "@/features/logbook/cycleTime";
import { formatWaitDuration } from "@/features/logbook/waiting";
import { formatDate } from "@/lib/formatting";

const WIDTH = 640;
const ROW_HEIGHT = 28;
const PAD_LEFT = 96;
const PAD_RIGHT = 12;

export type CycleTimeDotStripProps = {
  lanes: CycleTimeLane[];
};

/** One horizontal dot-strip lane per agent: each dot is one in-progress → done/needs-qa pass. */
export const CycleTimeDotStrip = ({ lanes }: CycleTimeDotStripProps) => {
  const titleId = useId();
  const [hovered, setHovered] = useState<{ lane: number; pass: number } | null>(null);

  if (lanes.length === 0) {
    return <p className="text-sm text-muted-foreground">No cycle times finished in this range.</p>;
  }

  const max = Math.max(1, cycleTimeScaleMax(lanes));
  const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const height = lanes.length * ROW_HEIGHT + 8;
  const scaleX = (minutes: number) => PAD_LEFT + Math.min(1, minutes / max) * plotWidth;

  return (
    <div className="flex flex-col gap-2">
      <svg
        role="img"
        aria-labelledby={titleId}
        viewBox={`0 0 ${WIDTH} ${height}`}
        // `none`, not the SVG default ("meet") — same fix as the other
        // charts (see `CumulativeFlowChart`): the rendered box's own aspect
        // (`w-full` × a fixed pixel `height`) rarely matches the viewBox's,
        // and "meet" was letterboxing empty space at the sides instead of
        // spreading the lanes across the card's full width.
        preserveAspectRatio="none"
        className="w-full"
        style={{ height }}
        onMouseLeave={() => setHovered(null)}
      >
        <title id={titleId}>
          Cycle time from in progress to done or needs QA, one dot per pass, by agent
        </title>
        {lanes.map((lane, laneIndex) => {
          const cy = laneIndex * ROW_HEIGHT + ROW_HEIGHT / 2 + 4;
          return (
            <g key={lane.actor}>
              <text x={0} y={cy + 3} className="fill-foreground text-[10px]">
                {lane.label.length > 14 ? `${lane.label.slice(0, 13)}…` : lane.label}
              </text>
              <line x1={PAD_LEFT} x2={WIDTH - PAD_RIGHT} y1={cy} y2={cy} stroke="var(--border)" />
              {lane.passes.map((pass, passIndex) => (
                <circle
                  key={`${pass.taskId}-${pass.finishedAt}`}
                  cx={scaleX(pass.minutes)}
                  cy={cy}
                  r={4}
                  fill="var(--map-ok)"
                  tabIndex={0}
                  aria-label={`${lane.label}, ${pass.reference}: ${formatWaitDuration(pass.minutes)}, finished ${formatDate(pass.finishedAt)}`}
                  onMouseEnter={() => setHovered({ lane: laneIndex, pass: passIndex })}
                  onFocus={() => setHovered({ lane: laneIndex, pass: passIndex })}
                  onBlur={() => setHovered(null)}
                  className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                />
              ))}
            </g>
          );
        })}
      </svg>

      {hovered !== null
        ? (() => {
            const pass = lanes[hovered.lane]!.passes[hovered.pass]!;
            return (
              <div
                role="status"
                className="flex flex-wrap gap-3 rounded-md border border-border bg-card px-3 py-2 text-xs"
              >
                <Link
                  to={`/tasks/${pass.taskId}`}
                  className="font-medium text-primary hover:underline"
                >
                  {pass.reference}
                </Link>
                <span className="text-muted-foreground">
                  {lanes[hovered.lane]!.label} · {formatWaitDuration(pass.minutes)} ·{" "}
                  {formatDate(pass.finishedAt)}
                </span>
              </div>
            );
          })()
        : null}

      <div className="sr-only">
        <table>
          <caption>Cycle time per agent</caption>
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Task</th>
              <th scope="col">Minutes</th>
              <th scope="col">Finished</th>
            </tr>
          </thead>
          <tbody>
            {lanes.flatMap((lane) =>
              lane.passes.map((pass) => (
                <tr key={`${lane.actor}-${pass.taskId}-${pass.finishedAt}`}>
                  <td>{lane.label}</td>
                  <td>{pass.reference}</td>
                  <td>{Math.round(pass.minutes)}</td>
                  <td>{pass.finishedAt}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
