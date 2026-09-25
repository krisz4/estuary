import {
  TICKET_TITLE_MIN,
  type CreateTicketInput,
  type UpdateTicketInput,
} from "@helpdesk/contracts";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "@/api/http";
import {
  emptyTicketFormValues,
  TicketForm,
  type TicketFormHelpers,
  type TicketFormValues,
} from "@/features/tickets/TicketForm";
import { renderInProviders } from "@/test/harness";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const filled = (overrides: Partial<TicketFormValues> = {}): TicketFormValues => ({
  ...emptyTicketFormValues(),
  title: "Projector shows no signal",
  description: "Swapped the cable and rebooted, still nothing at all.",
  requesterName: "Dana Reyes",
  requesterEmail: "Dana.Reyes@Example.COM",
  ...overrides,
});

type Submitted = (CreateTicketInput | UpdateTicketInput)[];

const renderForm = (props: Partial<Parameters<typeof TicketForm>[0]> = {}) => {
  const submitted: Submitted = [];
  let helpers: TicketFormHelpers | undefined;

  const onSubmit = vi.fn((values, formHelpers: TicketFormHelpers) => {
    submitted.push(values);
    helpers = formHelpers;
  });

  renderInProviders(
    <TicketForm
      mode="create"
      defaultValues={emptyTicketFormValues()}
      isSubmitting={false}
      submitLabel="Create ticket"
      onSubmit={onSubmit}
      onCancel={vi.fn()}
      {...props}
    />,
  );

  return { submitted, onSubmit, getHelpers: () => helpers };
};

describe("TicketForm — validation comes from the contract schema", () => {
  it("shows the schema's own message for a too-short title", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();

    await user.type(screen.getByLabelText(/^title/i), "abc");
    await user.click(screen.getByRole("button", { name: "Create ticket" }));

    // The literal is written out rather than derived from the schema: sharing
    // the source with the code under test is how a message assertion stops
    // being able to fail (BUILD_LOG, recurring shape 1).
    expect(
      await screen.findByText(`Title must be at least ${TICKET_TITLE_MIN} characters`),
    ).toBeInTheDocument();
    expect(await screen.findByText("Title must be at least 5 characters")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits the schema's OUTPUT: email lowercased, empty optionals as null", async () => {
    const user = userEvent.setup();
    const { submitted } = renderForm({ defaultValues: filled() });

    await user.click(screen.getByRole("button", { name: "Create ticket" }));

    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toEqual({
      title: "Projector shows no signal",
      description: "Swapped the cable and rebooted, still nothing at all.",
      priority: "medium",
      category: null,
      requesterName: "Dana Reyes",
      requesterEmail: "dana.reyes@example.com",
      assignee: null,
    });
  });

  /**
   * `createTicketInputSchema` is `.strict()`. A `status` key surviving into the
   * parsed object is a client-side 422 on a form that looks complete.
   */
  it("never sends a status field in create mode", async () => {
    const user = userEvent.setup();
    const { submitted } = renderForm({ defaultValues: filled() });

    expect(screen.queryByLabelText(/^status/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create ticket" }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(Object.keys(submitted[0]!)).not.toContain("status");
  });

  it("renders the status field in edit mode and includes it in the parsed values", async () => {
    const user = userEvent.setup();
    const { submitted } = renderForm({
      mode: "edit",
      submitLabel: "Save changes",
      defaultValues: filled({ status: "in_progress" }),
    });

    expect(screen.getByLabelText(/^status/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({ status: "in_progress" });
  });
});

describe("TicketForm — a failed submit keeps the typed values", () => {
  it("preserves every field after applyServerError", async () => {
    const user = userEvent.setup();
    const { getHelpers } = renderForm({ defaultValues: filled() });

    await user.type(screen.getByLabelText(/assignee/i), "Marcus Feld");
    await user.click(screen.getByRole("button", { name: "Create ticket" }));

    await waitFor(() => expect(getHelpers()).toBeDefined());
    getHelpers()!.applyServerError(
      new Error("network"), // not even an ApiClientError — must still not clear
    );

    expect(screen.getByLabelText(/^title/i)).toHaveValue("Projector shows no signal");
    expect(screen.getByLabelText(/assignee/i)).toHaveValue("Marcus Feld");
  });
});

describe("TicketForm — server details are split, never mapped directly", () => {
  // Built through the real client error type so `validationDetails` — the
  // getter `splitValidationErrors` actually reads — is exercised rather than a
  // hand-faked shape that happens to satisfy the assertion.
  const validationError = (details: Record<string, string[]>) =>
    new ApiClientError({ code: "VALIDATION_ERROR", message: "Invalid", details, status: 422 });

  it("puts a known field's message on that field", async () => {
    const user = userEvent.setup();
    const { getHelpers } = renderForm({ defaultValues: filled() });

    await user.click(screen.getByRole("button", { name: "Create ticket" }));
    await waitFor(() => expect(getHelpers()).toBeDefined());

    getHelpers()!.applyServerError(
      validationError({ requesterEmail: ["Enter a valid email address"] }),
    );

    expect(await screen.findByText("Enter a valid email address")).toBeInTheDocument();
    expect(screen.getByLabelText(/requester email/i)).toHaveAttribute("aria-invalid", "true");
  });

  it("routes `_` and unrendered field names to the summary rather than dropping them", async () => {
    const user = userEvent.setup();
    const { getHelpers } = renderForm({ defaultValues: filled() });

    await user.click(screen.getByRole("button", { name: "Create ticket" }));
    await waitFor(() => expect(getHelpers()).toBeDefined());

    getHelpers()!.applyServerError(
      validationError({
        _: ['Unrecognized key: "createdAt"'],
        resolvedAt: ["Not accepted from a client"],
      }),
    );

    const summary = await screen.findByRole("alert");
    expect(summary).toHaveTextContent('Unrecognized key: "createdAt"');
    expect(summary).toHaveTextContent("Not accepted from a client");
  });

  it("puts one message on the status field for the 409", async () => {
    const user = userEvent.setup();
    const { getHelpers } = renderForm({
      mode: "edit",
      submitLabel: "Save changes",
      defaultValues: filled({ status: "closed" }),
    });

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(getHelpers()).toBeDefined());

    getHelpers()!.setFieldError("status", "Not allowed from here.");
    expect(await screen.findByText("Not allowed from here.")).toBeInTheDocument();
  });
});

describe("TicketForm — dirty reporting", () => {
  it("reports dirty only after a real edit", async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    renderForm({ defaultValues: filled(), onDirtyChange });

    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    await user.type(screen.getByLabelText(/assignee/i), "M");
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
  });
});
