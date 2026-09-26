import { projectColorIndex, type MapLayout } from "@/features/floor/layout";
import { laneColor, readFloorColors } from "@/features/floor/scene";
import { type MapGroupBy } from "@/pages/tasks-map/useFloorParams";

/**
 * The map's legend strip, below the canvas — the prototype's `.legend`.
 * Carries what per-cluster sector labels used to print on every station at
 * once (a visual-QA finding): bead size by priority, the boat/halo glyphs, and
 * — now that sector labels only draw for the hovered/selected cluster — the
 * one place that answers "what colour is what" for the other nine.
 */
export type MapLegendProps = {
  layout: MapLayout;
  groupMode: MapGroupBy;
  projectOrder: readonly string[];
};

const PRIORITY_SIZES: { label: string; size: number }[] = [
  { label: "low", size: 6 },
  { label: "med", size: 9 },
  { label: "high", size: 12 },
  { label: "urgent", size: 15 },
];

export const MapLegend = ({ layout, groupMode, projectOrder }: MapLegendProps) => {
  const colors = readFloorColors();
  const groups = layout.groups.slice(0, 8);
  const overflow = layout.groups.length - groups.length;
  // Matches `beadColorIndex`'s own rule: sorted project order when
  // `group=project` (so the swatch always agrees with the beads it keys),
  // the group's own sector index otherwise.
  const colorIndexFor = (groupKey: string, index: number): number | null =>
    groupMode === "project" ? projectColorIndex(groupKey === "__no_project__" ? null : groupKey, projectOrder) : index;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border bg-map-panel px-4 py-2 font-mono text-[10.5px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        {PRIORITY_SIZES.map(({ label, size }) => (
          <span key={label} className="inline-flex items-center gap-1">
            <span
              className="inline-block rounded-full bg-muted-foreground"
              style={{ width: size, height: size }}
              aria-hidden="true"
            />
            {label}
          </span>
        ))}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg width="22" height="12" viewBox="0 0 22 12" aria-hidden="true">
          <path d="M3 3h13q6 3 0 6H3q-2-3 0-6z" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        agent at work
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="inline-block size-3.5 rounded-full"
          style={{ background: `radial-gradient(circle, ${colors.poolAttn} 40%, transparent 75%)` }}
          aria-hidden="true"
        />
        waits on you
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="inline-block size-3.5 rounded-full"
          style={{ background: `radial-gradient(circle, ${colors.poolBlock} 40%, transparent 75%)` }}
          aria-hidden="true"
        />
        blocked
      </span>
      {groups.length === 0 ? null : (
        <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1 border-l border-border pl-3">
          {groups.map((group) => (
            <span key={group.key} className="inline-flex items-center gap-1">
              <span
                className="inline-block size-2 rounded-full"
                style={{ backgroundColor: laneColor(colorIndexFor(group.key, group.index), colors) }}
                aria-hidden="true"
              />
              {group.label}
            </span>
          ))}
          {overflow > 0 ? <span>+{overflow} more</span> : null}
        </span>
      )}
    </div>
  );
};
