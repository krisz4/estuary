import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/**
 * Shared field chrome. Exported so `Textarea` and the `Select` trigger look
 * identical to an `Input` without three copies of the class list drifting
 * apart — a form where the select is one pixel taller than the inputs beside it
 * is the kind of thing that reads as unfinished.
 */
export const fieldClassName = cn(
  "w-full rounded-md border border-input bg-card text-foreground",
  "px-3 py-2",
  "placeholder:text-muted-foreground",
  "transition-colors",
  "disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60",
  // Colour is never the only signal: `aria-invalid` also drives the message
  // rendered by <Field>, so a colour-blind user still gets the text.
  "aria-[invalid=true]:border-destructive",
);

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, type = "text", ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(fieldClassName, "h-10 sm:h-9", className)}
      {...props}
      /*
        AFTER the spread, and falling back to the spread value rather than to
        `undefined`. `<Field>` always passes an `aria-invalid` key through its
        render props, so with this written before `{...props}` an explicit
        `invalid` was overwritten by Field's `undefined` — the attribute
        vanished and `aria-[invalid=true]:border-destructive` never matched.
        Either source alone must still work, so the two are combined.
      */
      aria-invalid={invalid === true ? true : props["aria-invalid"]}
    />
  );
});
