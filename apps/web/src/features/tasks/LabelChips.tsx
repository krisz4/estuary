import { Link } from "react-router-dom";
import { cn } from "@/lib/cn";

/**
 * A task's labels, rendered as small tags.
 *
 * Plain `<span>`s by default; when `linkTo` is given each label becomes a link
 * that filters the list by it — used on the list rows, where clicking a label
 * is the fast path into "show me the rest of these". The detail page and the
 * map render them unlinked; there is nowhere for the click to narrow.
 */
export type LabelChipsProps = {
  labels: readonly string[];
  /** When given, each chip links to `?label=<value>` via this builder. */
  linkTo?: (label: string) => string;
  className?: string;
};

export const LabelChips = ({ labels, linkTo, className }: LabelChipsProps) => {
  if (labels.length === 0) return null;

  return (
    <ul className={cn("flex flex-wrap items-center gap-1", className)}>
      {labels.map((label) =>
        linkTo === undefined ? (
          <li key={label}>
            <LabelTag label={label} />
          </li>
        ) : (
          <li key={label}>
            <Link
              to={linkTo(label)}
              onClick={(event) => event.stopPropagation()}
              className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Filter by label: ${label}`}
            >
              <LabelTag label={label} interactive />
            </Link>
          </li>
        ),
      )}
    </ul>
  );
};

const LabelTag = ({ label, interactive = false }: { label: string; interactive?: boolean }) => (
  <span
    className={cn(
      "inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5",
      "text-xs whitespace-nowrap text-muted-foreground",
      interactive && "transition-colors hover:border-primary hover:text-foreground",
    )}
  >
    {label}
  </span>
);
