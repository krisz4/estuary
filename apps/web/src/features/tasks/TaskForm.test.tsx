import { TASK_TITLE_MIN, type CreateTaskInput, type UpdateTaskInput } from "@estuary/contracts";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "@/api/http";
import {
  emptyTaskFormValues,
  TaskForm,
  type TaskFormHelpers,
  type TaskFormValues,
} from "@/features/tasks/TaskForm";
import { renderInProviders } from "@/test/harness";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const filled = (overrides: Partial<TaskFormValues> = {}): TaskFormValues => ({
  ...emptyTaskFormValues(),
  title: "Add rate limiting to exports",
  description: "Exports time out under load; throttle per client.",
  project: "Estuary",
  ...overrides,
});

/** Edit mode's values: the same, minus `status`, which the edit form never holds. */
const filledForEdit = (overrides: Partial<TaskFormValues> = {}): TaskFormValues => {
  const { status: _status, ...rest } = filled(overrides);
  return rest;
};

type Submitted = (CreateTaskInput | UpdateTaskInput)[];

const renderForm = (props: Partial<Parameters<typeof TaskForm>[0]> = {}) => {
  const submitted: Submitted = [];
  let helpers: TaskFormHelpers | undefined;

  const onSubmit = vi.fn((values, formHelpers: TaskFormHelpers) => {
    submitted.push(values);
    helpers = formHelpers;
  });

  renderInProviders(
    <TaskForm
      mode="create"
      defaultValues={emptyTaskFormValues()}
      isSubmitting={false}
      submitLabel="Create task"
      onSubmit={onSubmit}
      onCancel={vi.fn()}
      {...props}
    />,
  );

  return { submitted, onSubmit, getHelpers: () => helpers };
};

describe("TaskForm — validation comes from the contract schema", () => {
  it("shows the schema's own message for a too-short title", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();

    await user.type(screen.getByLabelText(/^title/i), "abc");
    await user.click(screen.getByRole("button", { name: "Create task" }));

    // The literal is written out rather than derived from the schema: sharing
    // the source with the code under test is how a message assertion stops
    // being able to fail (BUILD_LOG, recurring shape 1).
    expect(
      await screen.findByText(`Title must be at least ${TASK_TITLE_MIN} characters`),
    ).toBeInTheDocument();
    expect(await screen.findByText("Title must be at least 5 characters")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits the schema's OUTPUT: project lowercased, empty optionals as null", async () => {
    const user = userEvent.setup();
    const { submitted } = renderForm({ defaultValues: filled() });

    await user.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toEqual({
      title: "Add rate limiting to exports",
      description: "Exports time out under load; throttle per client.",
      status: "backlog",
      priority: "medium",
      project: "estuary",
      assignee: null,
      acceptanceCriteria: null,
      links: [],
      labels: [],
      parentId: null,
    });
  });

  it("turns a typed task number into a parent id", async () => {
    const user = userEvent.setup();
    const { submitted } = renderForm({ defaultValues: filled() });

    await user.type(screen.getByLabelText(/^parent task/i), "TASK-000012");
    await user.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({ parentId: 12 });
  });

  it("refuses a parent that is not a task number", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm({ defaultValues: filled({ parentId: "the login one" }) });

    await user.click(screen.getByRole("button", { name: "Create task" }));

    expect(
      await screen.findByText("Enter a task number — 12, #12, or TASK-000012."),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  /*
    A blank row is an unused "Add link", not an invalid link — and an error on
    a row *after* a blank one must land on that row, not on the row above it.
  */
  it("drops blank link rows and keeps row errors on the row they belong to", async () => {
    const user = userEvent.setup();
    const { onSubmit, submitted } = renderForm({
      defaultValues: filled({
        links: [
          { label: "", url: "" },
          { label: "PR", url: "not a url" },
        ],
      }),
    });

    await user.click(screen.getByRole("button", { name: "Create task" }));

    expect(await screen.findByText("Enter a valid URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Link 2 URL")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Link 1 URL")).not.toHaveAttribute("aria-invalid");
    expect(onSubmit).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText("Link 2 URL"));
    await user.type(screen.getByLabelText("Link 2 URL"), "https://github.com/x/y/pull/1");
    await user.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({
      links: [{ label: "PR", url: "https://github.com/x/y/pull/1" }],
    });
  });

  it("adds and removes link rows", async () => {
    const user = userEvent.setup();
    renderForm({ defaultValues: filled() });

    await user.click(screen.getByRole("button", { name: "Add link" }));
    expect(screen.getByLabelText("Link 1 label")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove link 1" }));
    expect(screen.queryByLabelText("Link 1 label")).not.toBeInTheDocument();
  });

  /**
   * Status is a transition with its own payload after creation, so the edit
   * form has no status control, and `updateTaskInputSchema` — `.strict()`,
   * with no `status` key — would reject one.
   */
  it("has no status field in edit mode, and sends none", async () => {
    const user = userEvent.setup();
    const { submitted } = renderForm({
      mode: "edit",
      submitLabel: "Save changes",
      defaultValues: filledForEdit(),
    });

    expect(screen.queryByLabelText(/status/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(Object.keys(submitted[0]!)).not.toContain("status");
  });
});

describe("TaskForm — a failed submit keeps the typed values", () => {
  it("preserves every field after applyServerError", async () => {
    const user = userEvent.setup();
    const { getHelpers } = renderForm({ defaultValues: filled() });

    await user.type(screen.getByLabelText(/assignee/i), "Marcus Feld");
    await user.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(getHelpers()).toBeDefined());
    getHelpers()!.applyServerError(
      new Error("network"), // not even an ApiClientError — must still not clear
    );

    expect(screen.getByLabelText(/^title/i)).toHaveValue("Add rate limiting to exports");
    expect(screen.getByLabelText(/assignee/i)).toHaveValue("Marcus Feld");
  });
});

describe("TaskForm — server details are split, never mapped directly", () => {
  // Built through the real client error type so `validationDetails` — the
  // getter `splitValidationErrors` actually reads — is exercised rather than a
  // hand-faked shape that happens to satisfy the assertion.
  const validationError = (details: Record<string, string[]>) =>
    new ApiClientError({ code: "VALIDATION_ERROR", message: "Invalid", details, status: 422 });

  it("puts a known field's message on that field", async () => {
    const user = userEvent.setup();
    const { getHelpers } = renderForm({ defaultValues: filled() });

    await user.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(getHelpers()).toBeDefined());

    getHelpers()!.applyServerError(
      validationError({ project: ["Project must be a slug: letters, digits, . _ -"] }),
    );

    expect(
      await screen.findByText("Project must be a slug: letters, digits, . _ -"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^project/i)).toHaveAttribute("aria-invalid", "true");
  });

  it("routes `_` and unrendered field names to the summary rather than dropping them", async () => {
    const user = userEvent.setup();
    const { getHelpers } = renderForm({ defaultValues: filled() });

    await user.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(getHelpers()).toBeDefined());

    getHelpers()!.applyServerError(
      validationError({
        _: ['Unrecognized key: "createdAt"'],
        createdBy: ["Not accepted from a client"],
      }),
    );

    const summary = await screen.findByRole("alert");
    expect(summary).toHaveTextContent('Unrecognized key: "createdAt"');
    expect(summary).toHaveTextContent("Not accepted from a client");
  });

  it("puts a server message on a link row the form renders", async () => {
    const user = userEvent.setup();
    const { getHelpers } = renderForm({
      defaultValues: filled({ links: [{ label: "PR", url: "https://example.com/pr/1" }] }),
    });

    await user.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(getHelpers()).toBeDefined());

    getHelpers()!.applyServerError(validationError({ "links.0.url": ["Enter a valid URL"] }));
    expect(await screen.findByText("Enter a valid URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Link 1 URL")).toHaveAttribute("aria-invalid", "true");
  });
});

describe("TaskForm — dirty reporting", () => {
  it("reports dirty only after a real edit", async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    renderForm({ defaultValues: filled(), onDirtyChange });

    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    await user.type(screen.getByLabelText(/assignee/i), "M");
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
  });
});

describe("TaskForm — labels", () => {
  it("adds a label on Enter, sorted and lowercased, and submits the set", async () => {
    const user = userEvent.setup();
    const { submitted } = renderForm({ defaultValues: filled() });

    const labelBox = screen.getByLabelText("Labels");
    await user.type(labelBox, "Web{Enter}");
    await user.type(labelBox, "bug{Enter}");

    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.getByText("bug")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({ labels: ["bug", "web"] });
  });

  it("removes a label with its own remove button", async () => {
    const user = userEvent.setup();
    renderForm({ defaultValues: filled({ labels: ["bug", "web"] }) });

    await user.click(screen.getByRole("button", { name: "Remove label bug" }));

    expect(screen.queryByText("bug")).not.toBeInTheDocument();
    expect(screen.getByText("web")).toBeInTheDocument();
  });

  it("rejects a malformed label before it becomes a chip", async () => {
    const user = userEvent.setup();
    renderForm({ defaultValues: filled() });

    await user.type(screen.getByLabelText("Labels"), "has space{Enter}");

    expect(await screen.findByText(/Label must be a slug/)).toBeInTheDocument();
    expect(screen.queryByText("has space")).not.toBeInTheDocument();
  });
});
