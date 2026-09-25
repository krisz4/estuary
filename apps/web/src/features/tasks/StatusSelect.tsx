import { type TaskStatus } from "@helpdesk/contracts";
import { Field, Select } from "@/components/ui";
import { isTaskStatus, statusChangeErrorMessage } from "@/lib/statusTransition";
import { statusOptions } from "@/lib/formatting";

/**
 * The inline status control on the task detail page.
 *
 * Status is not editable in the edit form at all — every change is a
 * `POST /tasks/:taskId/transition`, and several targets need a payload (a
 * reason, a question, a summary). So this control only *reports the pick*: the
 * page decides whether it posts straight away or opens `TransitionDialog`
 * (`transitionNeedsInput`). The control is disabled while a move is in flight,
 * so a second pick cannot race the first.
 *
 * A failed move's message comes from `statusChangeErrorMessage`, which names
 * the claim holder for a `TASK_ALREADY_CLAIMED` rather than only saying no.
 */

export type StatusSelectProps = {
  value: TaskStatus;
  onChange: (status: TaskStatus) => void;
  isPending?: boolean;
  /** The last failed status change, or `null`. Cleared by the caller on retry. */
  error?: unknown;
};

export const StatusSelect = ({ value, onChange, isPending = false, error }: StatusSelectProps) => (
  <Field label="Status" error={statusChangeErrorMessage(error)}>
    {(field) => (
      <Select<TaskStatus>
        options={statusOptions}
        value={value}
        disabled={isPending}
        onValueChange={(next) => {
          // Radix hands back a bare string. Parsing it through the contract enum
          // keeps an impossible value out of a PATCH body typed as if it could
          // not happen. `next !== value` is what stops Radix's initial
          // synchronisation from firing a no-op PATCH on mount.
          if (isTaskStatus(next) && next !== value) onChange(next);
        }}
        id={field.id}
        aria-describedby={field["aria-describedby"]}
        aria-invalid={field["aria-invalid"]}
        className="sm:w-full"
      />
    )}
  </Field>
);
