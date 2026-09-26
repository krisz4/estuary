import { parseSearchTerms } from "@helpdesk/contracts";
import { Fragment } from "react";

/**
 * Wraps every occurrence of a search term in `<mark>`, case-insensitively.
 *
 * Uses the contracts' own `parseSearchTerms` — the same split the server runs
 * on `q` — so what lights up here is exactly what the server matched on, not
 * a client guess that could disagree with it (a quoted phrase, for instance).
 *
 * Purely additive: no terms (`q` unset) renders the text unchanged, and a
 * term that matches nothing highlights nothing rather than throwing.
 */
export const HighlightText = ({ text, query }: { text: string; query: string | undefined }) => {
  if (query === undefined || query.trim() === "") return <>{text}</>;

  const terms = parseSearchTerms(query).filter((term) => term.length > 0);
  if (terms.length === 0) return <>{text}</>;

  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  const parts = text.split(pattern);

  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <mark key={index} className="rounded-sm bg-warning-subtle text-warning-subtle-foreground">
            {part}
          </mark>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
