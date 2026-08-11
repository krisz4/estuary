import { Link, useParams } from "react-router-dom";
import { Button } from "@/components/ui";
import { useDocumentTitle } from "@/lib/useDocumentTitle";

/**
 * **Temporary — deleted in stages 11 and 12.**
 *
 * The route table is a stage-10 deliverable, and one of its gate items is that
 * `/tickets/new` is declared *before* `/tickets/:ticketId` so `new` is never
 * parsed as an id. That ordering cannot be demonstrated against routes that do
 * not exist yet, so each future page gets a stub that names the stage that will
 * replace it — and, for `/tickets/:ticketId`, echoes the id it matched, which is
 * what makes the ordering visible rather than asserted.
 */
export const StagePlaceholderPage = ({
  title,
  stage,
  summary,
}: {
  title: string;
  stage: string;
  summary: string;
}) => {
  const { ticketId } = useParams();
  useDocumentTitle(title);

  return (
    <div className="mx-auto flex max-w-2xl flex-col items-start gap-3 py-8">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Not built yet · {stage}
      </p>
      <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
      <p className="text-sm text-muted-foreground">{summary}</p>
      {ticketId === undefined ? null : (
        <p className="text-sm text-muted-foreground">
          Matched route parameter <code className="font-mono text-foreground">ticketId</code>:{" "}
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
            {ticketId}
          </span>
        </p>
      )}
      <Button asChild variant="outline" className="mt-2">
        <Link to="/tickets">Back to tickets</Link>
      </Button>
    </div>
  );
};
