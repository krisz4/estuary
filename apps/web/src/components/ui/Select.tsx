import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { forwardRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { fieldClassName } from "@/components/ui/Input";

export type SelectOption<TValue extends string = string> = {
  value: TValue;
  label: string;
  disabled?: boolean;
};

export type SelectProps<TValue extends string = string> = {
  options: readonly SelectOption<TValue>[];
  value: TValue | undefined;
  onValueChange: (value: TValue) => void;
  placeholder?: string;
  /** Rendered before the options; used for "Any status" on the filter bar. */
  children?: ReactNode;
  id?: string;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string | undefined;
  "aria-invalid"?: true | undefined;
};

/**
 * Radix Select, wrapped so a caller passes options rather than composing seven
 * parts.
 *
 * Radix rather than a native `<select>` because the design guidelines ask for it
 * and because a native option list cannot carry a status dot. The cost is real
 * and worth naming: a native select gets the platform picker on iOS, which is
 * genuinely better on a phone. Radix's listbox is keyboard- and touch-operable
 * and is what the dialog already pulls in, so the app has one interaction model
 * instead of two.
 *
 * `position="popper"` with a viewport-height cap keeps a 4-item list from
 * rendering off-screen at 360px, which the default "item-aligned" position does
 * when the trigger sits near the bottom of a short viewport.
 */
export const Select = <TValue extends string = string>({
  options,
  value,
  onValueChange,
  placeholder = "Select…",
  children,
  id,
  name,
  disabled,
  required,
  className,
  ...aria
}: SelectProps<TValue>) => (
  <RadixSelect.Root
    /*
      `value ?? ""`, never a bare `undefined`. Radix's `useControllableState`
      reads `undefined` as "this component is uncontrolled" and hands control
      back to its own internal state — so clearing a filter back to "Any status"
      by setting state to `undefined` left the trigger showing the previous
      label, plus React's controlled→uncontrolled warning. The empty string is
      Radix's own representation of "nothing selected" and shows the placeholder.
      (It is also why no option may use `""` as its value.)
    */
    value={value ?? ""}
    onValueChange={(next) => onValueChange(next as TValue)}
    name={name}
    disabled={disabled}
    required={required}
  >
    <RadixSelect.Trigger
      id={id}
      className={cn(
        fieldClassName,
        "flex h-10 items-center justify-between gap-2 text-left sm:h-9",
        "data-[placeholder]:text-muted-foreground",
        className,
      )}
      {...aria}
    >
      <RadixSelect.Value placeholder={placeholder} />
      <RadixSelect.Icon asChild>
        <ChevronDown className="size-4 shrink-0 opacity-60" aria-hidden="true" />
      </RadixSelect.Icon>
    </RadixSelect.Trigger>

    <RadixSelect.Portal>
      <RadixSelect.Content
        position="popper"
        sideOffset={4}
        className={cn(
          "z-50 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg",
          "max-h-[min(20rem,var(--radix-select-content-available-height))]",
          "min-w-[var(--radix-select-trigger-width)]",
        )}
      >
        <RadixSelect.Viewport className="p-1">
          {children}
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </SelectItem>
          ))}
        </RadixSelect.Viewport>
      </RadixSelect.Content>
    </RadixSelect.Portal>
  </RadixSelect.Root>
);

export const SelectItem = forwardRef<
  HTMLDivElement,
  RadixSelect.SelectItemProps & { children: ReactNode }
>(function SelectItem({ className, children, ...props }, ref) {
  return (
    <RadixSelect.Item
      ref={ref}
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-sm py-2 pr-2 pl-8 text-sm sm:py-1.5",
        "outline-none select-none",
        "data-[highlighted]:bg-muted data-[highlighted]:text-foreground",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <RadixSelect.ItemIndicator>
          <Check className="size-4" aria-hidden="true" />
        </RadixSelect.ItemIndicator>
      </span>
      <RadixSelect.ItemText>{children}</RadixSelect.ItemText>
    </RadixSelect.Item>
  );
});
