import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { fieldClassName } from "@/components/ui/Input";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, rows = 6, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(fieldClassName, "min-h-24 resize-y", className)}
      {...props}
      /* After the spread, combined with it — see the note in Input.tsx. */
      aria-invalid={invalid === true ? true : props["aria-invalid"]}
    />
  );
});
