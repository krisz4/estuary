import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Field, Input, Select, Textarea } from "@/components/ui";

/**
 * These cover the two prop-plumbing bugs that only appear once a primitive is
 * used the way stage 12 will use it — inside `<Field>`, and as a controlled
 * value that can be cleared. Both passed every isolated component test and
 * failed the moment two pieces were combined.
 */

describe("Field + Input/Textarea", () => {
  it("wires label, control, and help text together", () => {
    render(
      <Field label="Title" help="At least 5 characters.">
        {(field) => <Input {...field} />}
      </Field>,
    );

    const input = screen.getByLabelText("Title");
    expect(input).toBeInTheDocument();
    expect(input).toHaveAccessibleDescription("At least 5 characters.");
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("marks the control invalid and links the error when Field has one", () => {
    render(
      <Field label="Title" help="At least 5 characters." error="Title is too short">
        {(field) => <Input {...field} />}
      </Field>,
    );

    const input = screen.getByLabelText("Title");
    expect(input).toHaveAttribute("aria-invalid", "true");
    // Error replaces help text rather than stacking below it.
    expect(input).toHaveAccessibleDescription("Title is too short");
    expect(screen.queryByText("At least 5 characters.")).toBeNull();
  });

  it.each([
    ["Input", (field: object) => <Input {...field} invalid />],
    ["Textarea", (field: object) => <Textarea {...field} invalid />],
  ])("keeps an explicit invalid prop on %s when spread inside Field", (_name, renderControl) => {
    // The regression: Field always passes an `aria-invalid` key, so writing the
    // attribute before `{...props}` let Field's `undefined` erase it.
    render(<Field label="Title">{(field) => renderControl(field)}</Field>);
    expect(screen.getByLabelText("Title")).toHaveAttribute("aria-invalid", "true");
  });

  it.each([
    ["Input", (props: object) => <Input {...props} aria-label="Bare" />],
    ["Textarea", (props: object) => <Textarea {...props} aria-label="Bare" />],
  ])("still honours invalid on a bare %s outside Field", (_name, renderControl) => {
    render(renderControl({ invalid: true }));
    expect(screen.getByLabelText("Bare")).toHaveAttribute("aria-invalid", "true");
  });

  it("marks the field required for assistive technology, not only with an asterisk", () => {
    render(
      <Field label="Title" required>
        {(field) => <Input {...field} />}
      </Field>,
    );
    expect(screen.getByLabelText(/Title/)).toBeRequired();
    expect(screen.getByText("(required)")).toBeInTheDocument();
  });
});

describe("Select", () => {
  const OPTIONS = [
    { value: "open", label: "Open" },
    { value: "closed", label: "Closed" },
  ];

  const ControlledSelect = () => {
    const [value, setValue] = useState<string | undefined>(undefined);
    return (
      <>
        <Select
          options={OPTIONS}
          value={value}
          onValueChange={setValue}
          placeholder="Any status"
          aria-label="Status"
        />
        <button type="button" onClick={() => setValue(undefined)}>
          Clear
        </button>
      </>
    );
  };

  it("shows the placeholder again after the value is cleared to undefined", async () => {
    // Stage 11 clears a filter by setting its state back to undefined. Radix
    // reads a bare `undefined` as "uncontrolled" and keeps its own last value,
    // so the trigger used to keep showing the stale label.
    render(<ControlledSelect />);

    const trigger = screen.getByRole("combobox", { name: "Status" });
    expect(trigger).toHaveTextContent("Any status");

    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole("option", { name: "Closed" }));
    expect(trigger).toHaveTextContent("Closed");

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(trigger).toHaveTextContent("Any status");
    expect(trigger).not.toHaveTextContent("Closed");
  });
});
