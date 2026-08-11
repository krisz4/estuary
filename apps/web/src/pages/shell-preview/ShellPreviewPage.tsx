import { type PaginatedTickets } from "@helpdesk/contracts";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, API_BASE_URL } from "@/api/http";
import { queryKeys } from "@/api/queryKeys";
import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
  Skeleton,
  Textarea,
} from "@/components/ui";
import { errorCopy, errorRequestId } from "@/lib/errorMessages";
import { formatCount, priorityOptions } from "@/lib/formatting";
import { useDocumentTitle } from "@/lib/useDocumentTitle";

/**
 * **Temporary — replaced by the real list page in stage 11.**
 *
 * This is the stage-10 gate made executable rather than a screenshot: it
 * fetches `GET /tickets` through the real `http.ts` and the real query client
 * and renders `meta.total`, which proves in one screen that the base URL is
 * right, that CORS passes, that the envelope unwraps, and that a non-2xx maps
 * to mapped copy instead of raw server text.
 *
 * The primitive strip below it exists for the other half of the gate: it puts
 * every token-bearing component on screen at once, so switching theme surfaces
 * a token that was only defined in one block. `tests/design-tokens.test.ts` is
 * the assertion; this is where a human confirms it looks right — and the two
 * are not the same claim. The token test passed while every toast rendered in
 * Sonner's light palette on a dark page, because the toast never consumed a
 * token at all.
 */
export const ShellPreviewPage = () => {
  useDocumentTitle("Tickets");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [priority, setPriority] = useState<string>("medium");

  const ticketsQuery = useQuery({
    queryKey: queryKeys.tickets.list({}),
    queryFn: ({ signal }) => api.get<PaginatedTickets>("/tickets", { signal }),
  });

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">Tickets</h1>
        <p className="text-sm text-muted-foreground">
          Stage 10 shell. The filterable list lands in stage 11 — this page only proves the client,
          the router, and the tokens work.
        </p>
      </header>

      <section
        aria-labelledby="api-check"
        aria-busy={ticketsQuery.isFetching}
        className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 md:p-6"
      >
        <h2 id="api-check" className="text-base font-semibold text-foreground">
          API connectivity
        </h2>
        <p className="text-xs text-muted-foreground">
          <code className="font-mono">{API_BASE_URL}/tickets</code>
        </p>

        {ticketsQuery.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-4 w-64" />
          </div>
        ) : ticketsQuery.isError ? (
          <ErrorPanel error={ticketsQuery.error} onRetry={() => void ticketsQuery.refetch()} />
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-3xl font-semibold tabular-nums text-foreground">
              {ticketsQuery.data.meta.total.toLocaleString()}
            </p>
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {formatCount(ticketsQuery.data.meta.total, "ticket")} in the database ·{" "}
              {formatCount(ticketsQuery.data.data.length, "row")} on page{" "}
              {ticketsQuery.data.meta.page} of {ticketsQuery.data.meta.totalPages}
            </p>
          </div>
        )}
      </section>

      <section aria-labelledby="primitives" className="flex flex-col gap-4">
        <h2 id="primitives" className="text-base font-semibold text-foreground">
          Primitives
        </h2>

        <div className="flex flex-wrap gap-2">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button isLoading>Loading</Button>
          <Button disabled>Disabled</Button>
        </div>

        <div className="flex flex-wrap gap-2">
          <Badge tone="neutral" dot>
            Closed
          </Badge>
          <Badge tone="info" dot>
            In progress
          </Badge>
          <Badge tone="success" dot>
            Resolved
          </Badge>
          <Badge tone="warning" dot>
            High
          </Badge>
          <Badge tone="destructive" dot>
            Urgent
          </Badge>
          <Badge tone="primary" dot>
            Open
          </Badge>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title" help="At least 5 characters." required>
            {(field) => <Input {...field} placeholder="Printer on floor 2 is jammed" />}
          </Field>

          <Field label="Priority">
            {(field) => (
              <Select
                {...field}
                options={priorityOptions}
                value={priority}
                onValueChange={setPriority}
              />
            )}
          </Field>

          <Field label="Description" error="Description must be at least 10 characters" required>
            {(field) => <Textarea {...field} rows={4} defaultValue="too short" />}
          </Field>

          <Field label="Loading" help="Skeletons match the shape of the real content.">
            {() => (
              <div className="flex flex-col gap-2 pt-1">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            )}
          </Field>
        </div>

        <div className="flex flex-wrap gap-2">
          {/*
            The neutral toast is the one that consumes our `--normal-*` override
            in index.css — `richColors` gives success/error Sonner's own filled
            palettes. It needs its own button, or the only case our CSS actually
            paints is the one nothing on this page can render.
          */}
          <Button variant="outline" onClick={() => toast("Neutral toast")}>
            Show neutral toast
          </Button>
          <Button variant="outline" onClick={() => toast.success("Toast from Sonner")}>
            Show toast
          </Button>
          <Button
            variant="outline"
            onClick={() => toast.error("Destructive toast", { description: "With a description." })}
          >
            Show error toast
          </Button>
          <Button variant="destructive" onClick={() => setConfirmOpen(true)}>
            Open dialog
          </Button>
        </div>

        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete this ticket?</DialogTitle>
              <DialogDescription>
                This cannot be undone. The ticket and all of its comments are removed permanently.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                {/* The safe action takes focus, per the design guidelines. */}
                <Button variant="outline" autoFocus>
                  Cancel
                </Button>
              </DialogClose>
              <Button variant="destructive" onClick={() => setConfirmOpen(false)}>
                Delete ticket
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </section>
    </div>
  );
};

/**
 * The in-place error panel shape stages 11–12 reuse: mapped copy, a Retry that
 * calls `refetch()`, and the `requestId` in small text so a 500 can be quoted.
 * Never `window.location.reload()`.
 */
const ErrorPanel = ({ error, onRetry }: { error: unknown; onRetry: () => void }) => {
  const copy = errorCopy(error);
  const requestId = errorRequestId(error);

  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-2 rounded-md border border-destructive/40 bg-destructive-subtle p-4"
    >
      <p className="flex items-center gap-2 text-sm font-medium text-destructive-subtle-foreground">
        <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
        {copy.title}
      </p>
      <p className="text-sm text-destructive-subtle-foreground/90">{copy.description}</p>
      {requestId === undefined ? null : (
        <p className="font-mono text-xs text-muted-foreground">Request {requestId}</p>
      )}
      {copy.retryable ? (
        <Button variant="outline" size="sm" onClick={onRetry} className="mt-1">
          <RefreshCw aria-hidden="true" />
          Retry
        </Button>
      ) : null}
    </div>
  );
};
