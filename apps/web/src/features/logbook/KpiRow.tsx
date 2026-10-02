import { type HistoryResponse } from "@estuary/contracts";
import { buildKpiTiles, type KpiKey } from "@/features/logbook/kpis";
import { Sparkline } from "@/features/logbook/Sparkline";
import { Skeleton } from "@/components/ui";
import { cn } from "@/lib/cn";

const TILE_COLOR: Record<KpiKey, string> = {
  shipped: "var(--map-water-edge)",
  created: "var(--map-ink-3)",
  medianWait: "var(--map-pool-attn)",
  qaPassRate: "var(--map-ok)",
};

export type KpiRowProps = {
  data: HistoryResponse | undefined;
  isPending: boolean;
};

/**
 * The four "at a glance" tiles: same tile shape as the map's `Briefing` tide
 * numbers (mono value, label below, a left border in the metric's own
 * colour) plus a tiny sparkline over the range's buckets underneath.
 */
export const KpiRow = ({ data, isPending }: KpiRowProps) => {
  if (isPending) {
    return (
      <div
        className="grid grid-cols-2 gap-3 min-[560px]:grid-cols-4"
        aria-busy="true"
        aria-label="Loading"
      >
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-20 w-full rounded-lg" />
        ))}
      </div>
    );
  }
  if (data === undefined) return null;

  const tiles = buildKpiTiles(data);

  return (
    <dl className="grid grid-cols-2 gap-3 min-[560px]:grid-cols-4">
      {tiles.map((tile) => (
        <div
          key={tile.key}
          className={cn(
            "flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2.5 shadow-raised",
            "border-l-2",
          )}
          style={{ borderLeftColor: TILE_COLOR[tile.key] }}
        >
          <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {tile.label}
          </dt>
          <dd className="font-mono text-xl leading-none font-bold tabular-nums text-foreground">
            {tile.value}
          </dd>
          <Sparkline points={tile.sparkline} color={TILE_COLOR[tile.key]} />
        </div>
      ))}
    </dl>
  );
};
