import { labelSchema, TASK_LABELS_MAX } from "@estuary/contracts";
import { X } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";
import { fieldClassName } from "@/components/ui";
import { cn } from "@/lib/cn";

/**
 * A chip input for a task's labels.
 *
 * Comma, Enter, or Tab commits the text typed so far as a chip; Backspace on
 * an empty box removes the last one. Each candidate is validated against the
 * contract's `labelSchema` **before** it is added — the same slug rule the
 * server enforces — so a malformed label never makes it into the chip row only
 * to bounce off a 422 on submit. `datalist` supplies suggestions from
 * `GET /tasks/facets`, purely as autocomplete; a label not yet in use is
 * created by typing it, the same relationship the project field has with its
 * own suggestions.
 *
 * Controlled: the caller (via `setValue` in `TaskForm`, the same pattern the
 * status and priority selects use) owns the array.
 */
export type LabelInputProps = {
  id: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
  suggestions?: readonly string[];
  "aria-describedby"?: string | undefined;
  "aria-invalid"?: true | undefined;
};

export const LabelInput = ({
  id,
  value,
  onChange,
  suggestions = [],
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
}: LabelInputProps) => {
  const [text, setText] = useState("");
  const [composeError, setComposeError] = useState<string | undefined>(undefined);
  const listId = useId();

  const commit = (raw: string) => {
    const candidate = raw.trim().toLowerCase();
    if (candidate === "") {
      setText("");
      return;
    }
    if (value.includes(candidate)) {
      setComposeError(undefined);
      setText("");
      return;
    }
    if (value.length >= TASK_LABELS_MAX) {
      setComposeError(`At most ${TASK_LABELS_MAX} labels`);
      return;
    }
    const result = labelSchema.safeParse(candidate);
    if (!result.success) {
      setComposeError(result.error.issues[0]?.message ?? "Not a valid label");
      return;
    }
    setComposeError(undefined);
    onChange([...value, result.data].sort());
    setText("");
  };

  const remove = (label: string) => onChange(value.filter((entry) => entry !== label));

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit(text);
      return;
    }
    if (event.key === "Backspace" && text === "" && value.length > 0) {
      remove(value[value.length - 1]!);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={cn(
          fieldClassName,
          "flex h-auto min-h-10 flex-wrap items-center gap-1.5 py-1.5 sm:min-h-9",
        )}
      >
        {value.map((label) => (
          <span
            key={label}
            className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-foreground"
          >
            {label}
            <button
              type="button"
              onClick={() => remove(label)}
              aria-label={`Remove label ${label}`}
              className="rounded-full text-muted-foreground hover:text-destructive"
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          id={id}
          type="text"
          list={listId}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => commit(text)}
          placeholder={value.length === 0 ? "web, bug, apps/api…" : undefined}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          className="min-w-[8rem] flex-1 border-0 bg-transparent p-0 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      <datalist id={listId}>
        {suggestions
          .filter((suggestion) => !value.includes(suggestion))
          .map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
      </datalist>
      {composeError === undefined ? null : (
        <p className="text-xs text-destructive" role="alert">
          {composeError}
        </p>
      )}
    </div>
  );
};
