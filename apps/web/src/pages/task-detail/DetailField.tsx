import { type ReactNode } from "react";

/**
 * One label/value pair in the ticket summary.
 *
 * A `<dt>`/`<dd>` pair rather than two `<div>`s: the summary is a definition
 * list in both layouts (a grid above `md`, a stack below it), and the semantics
 * are what let a screen reader pair "Assignee" with "Unassigned" instead of
 * reading eight labels and then eight values.
 */
export const DetailField = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex flex-col gap-0.5">
    <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
    <dd className="text-sm break-words text-foreground">{children}</dd>
  </div>
);
