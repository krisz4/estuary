import { type LucideIcon } from "lucide-react";
import { type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The "there is nothing here" panel.
 *
 * The design guidelines make one demand of this component that is easy to miss:
 * **"nothing exists" and "nothing matches" are different states with different
 * actions.** Offering "Create the first task" to someone whose filter is
 * simply too narrow is the wrong answer, and offering "Clear filters" to someone
 * with an empty database is a dead end. The caller picks; this renders.
 */
export type EmptyStateProps = {
  icon?: LucideIcon;
  title: string;
  description: string;
  /** The next action. Optional only because not every empty state has one. */
  action?: ReactNode;
  className?: string;
};

export const EmptyState = ({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) => (
  <div
    className={cn(
      "flex flex-col items-center gap-3 rounded-lg border border-dashed border-border",
      "px-6 py-12 text-center",
      className,
    )}
  >
    {Icon === undefined ? null : (
      <Icon className="size-8 text-muted-foreground" aria-hidden="true" />
    )}
    <div className="flex flex-col gap-1">
      <p className="text-base font-semibold text-foreground">{title}</p>
      <p className="mx-auto max-w-prose text-sm text-muted-foreground">{description}</p>
    </div>
    {action}
  </div>
);
