import { cn } from "@/lib/cn";

/**
 * The small line above a page title that says where on the estuary you are,
 * in the Map's own voice: an all-caps region word plus an italic place name
 * ("PLAN headwaters", "WAITING the lagoon"). Pages outside the map use it so
 * the whole app speaks one vocabulary. Decorative framing only: the `<h1>`
 * under it still names the page.
 */
export type ReachEyebrowProps = {
  name: string;
  place: string;
  className?: string;
};

export const ReachEyebrow = ({ name, place, className }: ReachEyebrowProps) => (
  <p className={cn("flex items-baseline gap-1.5 text-muted-foreground", className)}>
    <span className="font-mono text-[11px] font-semibold tracking-[0.14em] uppercase">{name}</span>
    <span className="text-xs italic">{place}</span>
  </p>
);
