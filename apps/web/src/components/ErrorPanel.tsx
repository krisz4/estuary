import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { errorCopy, errorRequestId } from "@/lib/errorMessages";

/**
 * In-place failure panel with a Retry that calls `refetch()`.
 *
 * Copy comes from `errorCopy()`, keyed off the error *code* — the raw server
 * message is never rendered (`docs/engineering/API_ERROR_CONTRACT.md`
 * § Client mapping). Retry is shown only when the code is retryable: a 404 or a
 * 422 fails identically on a second attempt, and a button that provably cannot
 * help is worse than no button.
 *
 * Never `window.location.reload()`. That throws away the whole cache and the
 * user's scroll position to re-issue one request.
 */
export type ErrorPanelProps = {
  error: unknown;
  onRetry?: () => void;
  /** Shown while the retry is in flight. */
  isRetrying?: boolean;
  className?: string;
};

export const ErrorPanel = ({ error, onRetry, isRetrying = false, className }: ErrorPanelProps) => {
  const copy = errorCopy(error);
  const requestId = errorRequestId(error);

  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-start gap-3 rounded-lg border border-destructive/40",
        "bg-destructive-subtle px-4 py-4 text-destructive-subtle-foreground",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold">{copy.title}</p>
          <p className="text-sm">{copy.description}</p>
          {requestId === undefined ? null : (
            <p className="font-mono text-xs opacity-70">Request ID: {requestId}</p>
          )}
        </div>
      </div>

      {copy.retryable && onRetry !== undefined ? (
        <Button variant="outline" size="sm" onClick={onRetry} isLoading={isRetrying}>
          Retry
        </Button>
      ) : null}
    </div>
  );
};
