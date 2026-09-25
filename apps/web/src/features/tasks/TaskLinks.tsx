import { type TaskLink } from "@helpdesk/contracts";
import { ExternalLink } from "lucide-react";

/**
 * Where the work lives — PRs, branches, commits, design docs.
 *
 * URLs are agent- and human-written, so each is rendered as an `<a>` only when
 * it is http(s): the contract's `z.url()` accepts any scheme, and a
 * `javascript:` link is a stored XSS one click away. Anything else is shown as
 * text.
 */
const isWebUrl = (url: string): boolean => {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

export const TaskLinks = ({ links }: { links: readonly TaskLink[] }) => (
  <ul className="flex flex-col gap-1.5">
    {links.map((link, index) => (
      // Index in the key: two links may share a label *and* a URL (an agent
      // appending the same PR twice), and the list is never reordered.
      <li key={`${index}:${link.url}`} className="min-w-0 text-sm">
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
      </li>
    ))}
  </ul>
);
