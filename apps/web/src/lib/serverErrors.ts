import { type FieldValues, type Path, type UseFormSetError } from "react-hook-form";
import { splitValidationErrors } from "@/lib/errorMessages";

/**
 * Server `VALIDATION_ERROR` details → react-hook-form field errors.
 *
 * **This is the one place a form is allowed to touch `details`.** Mapping the
 * object straight onto fields is the documented trap: the server files a
 * pathless zod issue under the key `_` (stage 8 constraint in
 * `docs/history/BUILD_LOG.md`), and any key that is not a field this form
 * renders — a query parameter, a field added API-side later — has exactly the
 * same shape. `setError("_", …)` on an unregistered name is dropped by
 * react-hook-form **silently**, so the user gets a rejected submit with nothing
 * highlighted and no message anywhere.
 *
 * `splitValidationErrors` does the partition against the caller's own field
 * list; everything it does not recognise comes back here as `formErrors` for the
 * summary, which is the only presentation that cannot lose a message.
 *
 * Returns the messages that belong in the summary. An empty array means every
 * message landed on a field.
 *
 * ## Focus is deliberately *not* set here
 *
 * `setError`'s `shouldFocus` calls `.focus()` on the field's **registered input
 * ref**, and the task form's selects (`status`, `priority`) are Radix Selects
 * driven by `setValue` with no registered ref at all. Spending the flag on the
 * first matching key therefore aimed focus at nothing whenever that key was a
 * select — `{ priority: […], project: […] }` moved focus nowhere, because
 * `priority` consumed the flag and `project` was already past `isFirst`.
 *
 * The caller focuses instead, by the rendered `aria-invalid` in DOM order, which
 * is the only ordering that includes the controls that are not inputs. See
 * `TaskForm`'s `focusFirstInvalid`.
 */
export const applyServerValidationErrors = <TValues extends FieldValues>(
  error: unknown,
  knownFields: readonly Path<TValues>[],
  setError: UseFormSetError<TValues>,
): string[] => {
  const { fieldErrors, formErrors } = splitValidationErrors(
    error,
    knownFields as readonly string[],
  );

  // Ordered by the form's own field list, not by `Object.keys(details)`, so the
  // messages are applied in the order they are read on screen.
  for (const name of knownFields) {
    const messages = fieldErrors[name];
    if (messages === undefined || messages[0] === undefined) continue;

    setError(name, { type: "server", message: messages[0] }, { shouldFocus: false });
  }

  return formErrors;
};
