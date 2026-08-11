import { AlertCircle } from "lucide-react";
import { type Ref } from "react";
import { cn } from "@/lib/cn";

/**
 * The assertive summary above a form.
 *
 * It exists for two different jobs and both are load-bearing:
 *
 * 1. **Announcing a failed submit.** The design guidelines ask for
 *    `aria-live="assertive"` on form errors — a sighted user sees three red
 *    fields at once, a screen-reader user gets nothing at all unless something
 *    speaks.
 * 2. **Catching messages that have no field.** A server `VALIDATION_ERROR` can
 *    name a key this form does not render (`_`, or a field added API-side).
 *    `splitValidationErrors` routes those here rather than dropping them, and
 *    this is the only surface that guarantees they are read.
 *
 * The live region is always mounted, never conditionally rendered. A region that
 * appears at the same moment its content does is frequently not announced —
 * assistive technology has to be observing the node *before* it changes.
 */
export const FormErrorSummary = ({
  messages,
  className,
  ref,
}: {
  messages: readonly string[];
  className?: string;
  /**
   * The region is the **fallback focus target** after a server rejection whose
   * messages name no rendered field (see `TicketForm`). `tabIndex={-1}` makes it
   * focusable programmatically without putting it in the tab order.
   */
  ref?: Ref<HTMLDivElement>;
}) => (
  <div
    ref={ref}
    tabIndex={-1}
    aria-live="assertive"
    className={cn("empty:hidden outline-none", className)}
  >
    {messages.length === 0 ? null : (
      <div
        role="alert"
        className={cn(
          "flex items-start gap-2 rounded-md border border-destructive/40",
          "bg-destructive-subtle px-3 py-2 text-sm text-destructive-subtle-foreground",
        )}
      >
        <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="flex flex-col gap-0.5">
          <p className="font-medium">
            {messages.length === 1 ? "There is a problem" : `There are ${messages.length} problems`}
          </p>
          <ul className="list-inside list-disc">
            {/*
              Index keys, deliberately. `splitValidationErrors` flattens every
              unrecognised `details` key into one array, so two fields rejected
              with the *same* message — `{ resolvedAt: ["Not accepted from a
              client"], closedAt: ["Not accepted from a client"] }`, which the
              update schema produces — collide on a message key. This list is
              rendered from a fresh array on every submit and is never reordered
              or filtered, which is exactly the case where the index is stable.
            */}
            {messages.map((message, index) => (
              <li key={index}>{message}</li>
            ))}
          </ul>
        </div>
      </div>
    )}
  </div>
);
