import { type GithubLinkStatus, type TaskLink } from "@estuary/contracts";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useGithubIntegrationQuery, useTaskGithubQuery } from "@/api/github";
import { Skeleton } from "@/components/ui";
import { GithubStatusBadge } from "@/features/tasks/GithubStatusBadge";

/**
 * Where the work lives — PRs, branches, commits, design docs.
 *
 * URLs are agent- and human-written, so each is rendered as an `<a>` only when
 * it is http(s): the contract's `z.url()` accepts any scheme, and a
 * `javascript:` link is a stored XSS one click away. Anything else is shown as
 * text.
 *
 * When the optional GitHub integration is on, a link that resolves to a PR or
 * issue gets a live state badge — open/draft/merged/closed, plus a checks dot
 * for a PR. The integration being off, absent, or erroring never breaks this
 * list: it just renders the links without badges, the same as before this
 * feature existed.
 */
const isWebUrl = (url: string): boolean => {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

export type TaskLinksProps = {
  links: readonly TaskLink[];
  /** Present only on the detail page, where GitHub status makes sense. */
  taskId?: number;
};

export const TaskLinks = ({ links, taskId }: TaskLinksProps) => {
  const integrationQuery = useGithubIntegrationQuery();
  const isGithubEnabled = integrationQuery.data?.enabled === true;

  const githubQuery = useTaskGithubQuery(taskId ?? -1, {
    enabled: taskId !== undefined && isGithubEnabled,
  });

  const byUrl = new Map<string, GithubLinkStatus>(
    (githubQuery.data?.data ?? []).map((entry) => [entry.url, entry]),
  );

  return (
    <ul className="flex flex-col gap-1.5">
      {links.map((link, index) => {
        const github = byUrl.get(link.url);
        return (
          // Index in the key: two links may share a label *and* a URL (an
          // agent appending the same PR twice), and the list is never
          // reordered.
          <li
            key={`${index}:${link.url}`}
            className="flex min-w-0 flex-wrap items-center gap-2 text-sm"
          >
            {isWebUrl(link.url) ? (
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex max-w-full items-center gap-1 text-primary hover:underline"
                title={link.url}
              >
                <span className="truncate">{link.label}</span>
                <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            ) : (
              <span className="break-words text-foreground">
                {link.label}: {link.url}
              </span>
            )}

            {isGithubEnabled && taskId !== undefined ? (
              <GithubLinkStatusSlot
                status={github}
                isLoading={githubQuery.isPending}
                queryFailed={githubQuery.isError}
                onRetry={() => void githubQuery.refetch()}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
};

/**
 * One link's GitHub slot: a skeleton while loading, the badge on success, and
 * a quiet inline retry on failure — never a panel that competes with the rest
 * of the page for a feature that is, by definition, optional.
 */
const GithubLinkStatusSlot = ({
  status,
  isLoading,
  queryFailed,
  onRetry,
}: {
  status: GithubLinkStatus | undefined;
  isLoading: boolean;
  queryFailed: boolean;
  onRetry: () => void;
}) => {
  if (isLoading) return <Skeleton className="h-4 w-16 rounded-full" />;

  if (queryFailed) {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <RefreshCw className="size-3" aria-hidden="true" />
        Retry GitHub status
      </button>
    );
  }

  if (status === undefined) return null;

  // A link GitHub could not resolve (deleted, private, rate-limited) carries
  // `error` instead of `state` — shown as quiet text, never a red panel.
  if (status.state === null || status.error !== null) {
    return (
      <span className="text-xs text-muted-foreground" title={status.error ?? undefined}>
        GitHub status unavailable
      </span>
    );
  }

  return <GithubStatusBadge state={status.state} checks={status.checks} />;
};
