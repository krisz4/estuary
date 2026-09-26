import { type TaskStatus } from "@helpdesk/contracts";
import { LOGBOOK_ZONES, ZONE_STATUSES, zoneOfStatus, type LogbookZone } from "@/features/logbook/zones";

/**
 * Every chart on this page draws from the same "Estuary" `--map-*` tokens the
 * floor uses for its own stations — `--map-ink-3` (neutral, planning),
 * `--map-ok` (the "moved forward" colour the tide scrubber already uses for
 * `in_progress`/`needs_qa`/`done`), `--map-pool-attn` (a waiting-dock pool),
 * `--map-pool-block` (a blocked pool) — so a reader who has looked at the map
 * recognises the Logbook's colours immediately, and both stay correct in dark
 * mode for free (the tokens already are). Shipped gets its own hue,
 * `--map-water-edge` (the river's edge, closest to the mouth), so it never
 * reads as indistinguishable from the Build bay's `--map-ok` in the stacked
 * flow chart.
 */
export const ZONE_COLOR_VAR: Record<LogbookZone, string> = {
  planning: "--map-ink-3",
  build: "--map-ok",
  waiting: "--map-pool-attn",
  shipped: "--map-water-edge",
};

/** Solid stroke / fill pair for a zone band. */
export const zoneColor = (zone: LogbookZone): { stroke: string; fill: string } => {
  const v = ZONE_COLOR_VAR[zone];
  return { stroke: `var(${v})`, fill: `color-mix(in oklch, var(${v}) 55%, transparent)` };
};

/**
 * The all-statuses CFD view stays inside the same four hues: each status gets
 * its zone's colour at a distinct opacity step, so "which zone" reads at a
 * glance and "which status" is still legible in the legend text (colour never
 * carries meaning alone).
 */
export const statusColor = (status: TaskStatus): { stroke: string; fill: string } => {
  // `blocked` breaks out of its zone's shading: the map already colours a
  // blocked pool `--map-pool-block` (distinct from the amber `--map-pool-attn`
  // every other Waiting dock status shares), and the all-statuses view is
  // exactly where that distinction — "blocked" versus "merely waiting" — is
  // the whole point of switching views for.
  if (status === "blocked") {
    return { stroke: "var(--map-pool-block)", fill: "color-mix(in oklch, var(--map-pool-block) 55%, transparent)" };
  }
  const zone = zoneOfStatus(status);
  const siblings = ZONE_STATUSES[zone];
  const index = siblings.indexOf(status);
  const step = siblings.length <= 1 ? 1 : 0.45 + (0.55 * index) / (siblings.length - 1);
  const v = ZONE_COLOR_VAR[zone];
  return {
    stroke: `var(${v})`,
    fill: `color-mix(in oklch, var(${v}) ${Math.round(step * 70)}%, transparent)`,
  };
};

export { LOGBOOK_ZONES };
