import { type GITHUB_CHECK_STATES, type GithubItemState } from "@helpdesk/contracts";
import { Badge, type BadgeTone } from "@/components/ui";
import { cn } from "@/lib/cn";

/** `GITHUB_CHECK_STATES` has no exported type alias, so derive one locally. */
type GithubCheckState = (typeof GITHUB_CHECK_STATES)[number];

const STATE_TONE: Record<GithubItemState, BadgeTone> = {
  open: "success",
  draft: "neutral",
  merged: "info",
  closed: "destructive",
};

const STATE_LABEL: Record<GithubItemState, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

const CHECK_DOT: Record<GithubCheckState, string> = {
  success: "bg-success",
  failure: "bg-destructive",
  pending: "bg-warning",
};

const CHECK_LABEL: Record<GithubCheckState, string> = {
  success: "Checks passing",
  failure: "Checks failing",
  pending: "Checks pending",
};

/**
 * One GitHub PR/issue's live state, next to the link it belongs to: an
 * open/draft/merged/closed pill, plus a small coloured dot for a PR's combined
 * check status (issues and links GitHub could not resolve carry no `checks`).
 */
export const GithubStatusBadge = ({
  state,
  checks,
}: {
  state: GithubItemState;
  checks: GithubCheckState | null;
}) => (
  <span className="inline-flex items-center gap-1">
    <Badge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>
    {checks === null ? null : (
      <span
        className={cn("size-2 rounded-full", CHECK_DOT[checks])}
        role="img"
        aria-label={CHECK_LABEL[checks]}
        title={CHECK_LABEL[checks]}
      />
    )}
  </span>
);
