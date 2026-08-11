import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Label + control + help/error, with the ARIA wiring done once.
 *
 * The accessibility baseline in the design guidelines asks for a real
 * `<label for>`, `aria-invalid` on the field, and the message linked through
 * `aria-describedby`. Wiring that per form means three ids invented by hand at
 * every call site, and the one that gets forgotten is `aria-describedby` —
 * which fails invisibly, because the message is on screen and only a screen
 * reader can tell it is unlinked.
 *
 * `children` is a render prop rather than a plain node so the generated ids
 * reach the control without the caller repeating them.
 *
 * **Error replaces help text**, per the guidelines, rather than stacking below
 * it — two messages under one input is ambiguous about which one to act on.
 */
export type FieldRenderProps = {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
  required: boolean | undefined;
};

export type FieldProps = {
  label: string;
  /** Shown below the control until an error replaces it. */
  help?: ReactNode;
  error?: string | undefined;
  required?: boolean;
  className?: string;
  children: (props: FieldRenderProps) => ReactNode;
};

export const Field = ({ label, help, error, required, className, children }: FieldProps) => {
  const baseId = useId();
  const id = `${baseId}-control`;
  const helpId = `${baseId}-help`;
  const errorId = `${baseId}-error`;

  const describedBy = error !== undefined ? errorId : help !== undefined ? helpId : undefined;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
        {required === true ? (
          <span className="ml-1 text-destructive" aria-hidden="true">
            *
          </span>
        ) : null}
        {required === true ? <span className="sr-only"> (required)</span> : null}
      </label>

      {children({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error !== undefined ? true : undefined,
        required,
      })}

      {error !== undefined ? (
        <p id={errorId} className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : help !== undefined ? (
        <p id={helpId} className="text-xs text-muted-foreground">
          {help}
        </p>
      ) : null}
    </div>
  );
};
