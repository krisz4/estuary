import { type TaskStatus, type TransitionInput } from "@estuary/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "@/api/http";
import { TransitionDialog, validateTransition } from "@/features/tasks/TransitionDialog";
import { makeSummary, renderInProviders } from "@/test/harness";

/**
 * The dialog renders exactly the payload its target needs, validates it with
 * the contract, and never closes or clears on a failed submit.
 *
 * `onSubmit` is a spy rather than a mocked hook: the dialog's contract with
 * its callers *is* "hand me a valid `TransitionInput`, and tell me if it
 * failed" — the map and the detail page each run the mutation their own way.
 */

afterEach(() => {
  vi.clearAllMocks();
});

const task = makeSummary({ acceptanceCriteria: null });

const renderDialog = (
  target: TaskStatus,
  props: {
    onSubmit?: (input: TransitionInput) => Promise<unknown>;
    initialError?: unknown;
    acceptanceCriteria?: string | null;
  } = {},
) => {
  const onSubmit = vi.fn(props.onSubmit ?? (() => Promise.resolve()));
  const onCancel = vi.fn();
  renderInProviders(
    <TransitionDialog
      task={{ ...task, acceptanceCriteria: props.acceptanceCriteria ?? null }}
      target={target}
      onSubmit={onSubmit}
      onCancel={onCancel}
      initialError={props.initialError}
    />,
  );
  return { onSubmit, onCancel, dialog: screen.getByRole("dialog") };
};

const submitButton = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", { name: /^(Move to|Ask for a decision)/ });

describe("TransitionDialog — the fields each target needs", () => {
  it.each([
    ["needs_refinement", ["What is unclear or missing?"]],
    ["todo", ["Acceptance criteria"]],
    ["blocked", ["Why is it blocked?", "Waits on tasks"]],
    [
      "needs_user_decision",
      ["Question", "Context", "Option 1 description", "Option 2 description"],
    ],
    ["needs_user_action", ["What does the human need to do?"]],
    ["needs_qa", ["Summary"]],
    ["deferred", ["Why is it parked?"]],
    ["done", ["Note"]],
  ] as const)("renders exactly what %s needs", (target, labels) => {
    const { dialog } = renderDialog(target);

    for (const label of labels) {
      expect(within(dialog).getByLabelText(new RegExp(`^${label}`))).toBeInTheDocument();
    }
    // Nothing from another target leaks in.
    const all = within(dialog).queryAllByRole("textbox");
    expect(all.length).toBeGreaterThanOrEqual(labels.length);
    if (target !== "blocked") expect(within(dialog).queryByLabelText(/waits on tasks/i)).toBeNull();
    if (target !== "needs_qa") expect(within(dialog).queryByLabelText(/^summary/i)).toBeNull();
  });
});

describe("TransitionDialog — required fields", () => {
  it.each([
    ["needs_refinement", "Say what is unclear or missing"],
    ["needs_user_action", "Say exactly what needs doing, and where"],
    ["needs_qa", "Summarise what changed and how to check it"],
    ["deferred", "Say why it is being parked"],
    // The contract's create-time message, word for word.
    ["todo", "Acceptance criteria are required before a task can be todo"],
  ] as const)("refuses an empty %s with its own message", async (target, message) => {
    const user = userEvent.setup();
    const { onSubmit, dialog } = renderDialog(target);

    await user.click(submitButton(dialog));

    expect(await within(dialog).findByText(message)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("uses the contract's message for a blocked task with neither reason nor tasks", async () => {
    const user = userEvent.setup();
    const { onSubmit, dialog } = renderDialog("blocked");

    await user.click(submitButton(dialog));

    expect(
      await within(dialog).findByText(
        "Say why it is blocked, or name the tasks it waits on in blockedBy",
      ),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not require criteria for To do when the task already has some", async () => {
    const user = userEvent.setup();
    const { onSubmit, dialog } = renderDialog("todo", { acceptanceCriteria: "Returns 429." });

    await user.click(submitButton(dialog));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ to: "todo" }));
  });
});

describe("TransitionDialog — payloads", () => {
  it("posts a blocked move with ids parsed from any reference spelling", async () => {
    const user = userEvent.setup();
    const { onSubmit, dialog } = renderDialog("blocked");

    await user.type(within(dialog).getByLabelText(/waits on tasks/i), "12, #13 TASK-000014 12");
    await user.click(submitButton(dialog));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ to: "blocked", blockedBy: [12, 13, 14] }),
    );
  });

  it("refuses a blocked-by entry that is not a task number", async () => {
    const user = userEvent.setup();
    const { onSubmit, dialog } = renderDialog("blocked");

    await user.type(within(dialog).getByLabelText(/waits on tasks/i), "12, the login one");
    await user.click(submitButton(dialog));

    expect(await within(dialog).findByText(/“the” is not a task number/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("posts a QA hand-off with its links, dropping a blank row", async () => {
    const user = userEvent.setup();
    const { onSubmit, dialog } = renderDialog("needs_qa");

    await user.type(within(dialog).getByLabelText(/^summary/i), "Added a token bucket.");
    await user.click(within(dialog).getByRole("button", { name: "Add link" }));
    await user.click(within(dialog).getByRole("button", { name: "Add link" }));
    await user.type(within(dialog).getByLabelText("Link 1 label"), "PR #12");
    await user.type(within(dialog).getByLabelText("Link 1 URL"), "https://github.com/x/y/pull/12");
    await user.click(submitButton(dialog));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        to: "needs_qa",
        summary: "Added a token bucket.",
        links: [{ label: "PR #12", url: "https://github.com/x/y/pull/12" }],
      }),
    );
  });

  it("puts the contract's URL message on the row that is wrong", async () => {
    const user = userEvent.setup();
    const { onSubmit, dialog } = renderDialog("needs_qa");

    await user.type(within(dialog).getByLabelText(/^summary/i), "Done.");
    await user.click(within(dialog).getByRole("button", { name: "Add link" }));
    await user.type(within(dialog).getByLabelText("Link 1 label"), "PR");
    await user.type(within(dialog).getByLabelText("Link 1 URL"), "not a url");
    await user.click(submitButton(dialog));

    expect(await within(dialog).findByText("Enter a valid URL")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Link 1 URL")).toHaveAttribute("aria-invalid", "true");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("TransitionDialog — the decision builder", () => {
  it("builds a question with options and a recommendation", async () => {
    const user = userEvent.setup();
    const { onSubmit, dialog } = renderDialog("needs_user_decision");

    await user.type(within(dialog).getByLabelText(/^question/i), "Which limiter should we use?");
    await user.type(within(dialog).getByLabelText(/^Option 1\b(?! description)/), "Token bucket");
    await user.type(within(dialog).getByLabelText("Option 1 description"), "Allows bursts.");
    await user.type(within(dialog).getByLabelText(/^Option 2\b(?! description)/), "Fixed window");
    await user.click(within(dialog).getByRole("button", { name: "Add option" }));
    await user.type(within(dialog).getByLabelText(/^Option 3\b(?! description)/), "Leaky bucket");

    // Recommend the second option, then remove the first: the recommendation
    // must follow the row it was on, not slide onto the one that moved up.
    await user.click(within(dialog).getAllByRole("radio", { name: "Recommend this option" })[1]!);
    await user.click(within(dialog).getByRole("button", { name: "Remove option 1" }));

    await user.click(submitButton(dialog));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        to: "needs_user_decision",
        decision: {
          question: "Which limiter should we use?",
          options: [{ label: "Fixed window" }, { label: "Leaky bucket" }],
          recommendedOption: "Fixed window",
        },
      }),
    );
  });

  it("keeps between two and six options", async () => {
    const user = userEvent.setup();
    const { dialog } = renderDialog("needs_user_decision");

    expect(within(dialog).getByRole("button", { name: "Remove option 1" })).toBeDisabled();

    for (let count = 2; count < 6; count += 1) {
      await user.click(within(dialog).getByRole("button", { name: "Add option" }));
    }
    expect(within(dialog).getByRole("button", { name: "Add option" })).toBeDisabled();
    expect(within(dialog).getAllByRole("radio", { name: "Recommend this option" })).toHaveLength(6);
  });

  it("uses the contract's messages for a missing label and duplicate labels", () => {
    const base = {
      to: "needs_user_decision" as const,
      reason: "",
      acceptanceCriteria: "",
      blockedBy: "",
      instructions: "",
      summary: "",
      links: [],
    };

    const missing = validateTransition(
      {
        ...base,
        decision: {
          question: "Which one?",
          context: "",
          options: [
            { label: "A", description: "" },
            { label: "", description: "" },
          ],
          recommendedOption: "",
        },
      },
      false,
    );
    expect(missing).toEqual({
      success: false,
      issues: [{ path: "decision.options.1.label", message: "Option label is required" }],
    });

    const duplicate = validateTransition(
      {
        ...base,
        decision: {
          question: "Which one?",
          context: "",
          options: [
            { label: "A", description: "" },
            { label: "A", description: "" },
          ],
          recommendedOption: "",
        },
      },
      false,
    );
    expect(duplicate).toEqual({
      success: false,
      issues: [{ path: "decision.options", message: "Option labels must be unique" }],
    });
  });
});

describe("TransitionDialog — failures", () => {
  it("maps a server VALIDATION_ERROR onto the field it names and keeps the values", async () => {
    const user = userEvent.setup();
    const { dialog } = renderDialog("deferred", {
      onSubmit: () =>
        Promise.reject(
          new ApiClientError({
            code: "VALIDATION_ERROR",
            message: "raw",
            details: { reason: ["Reason must be at most 5000 characters"] },
            status: 422,
          }),
        ),
    });

    await user.type(within(dialog).getByLabelText(/why is it parked/i), "Next quarter.");
    await user.click(submitButton(dialog));

    expect(
      await within(dialog).findByText("Reason must be at most 5000 characters"),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/why is it parked/i)).toHaveValue("Next quarter.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("puts a non-field failure in the summary, naming the claim holder", async () => {
    const user = userEvent.setup();
    const { dialog } = renderDialog("deferred", {
      onSubmit: () =>
        Promise.reject(
          new ApiClientError({
            code: "TASK_ALREADY_CLAIMED",
            message: "raw",
            details: { claimedBy: "agent:codex", expiresAt: "2026-09-25T12:00:00.000Z" },
            status: 409,
          }),
        ),
    });

    await user.type(within(dialog).getByLabelText(/why is it parked/i), "Next quarter.");
    await user.click(submitButton(dialog));

    expect(await within(dialog).findByText(/agent:codex holds the claim/)).toBeInTheDocument();
    expect(within(dialog).queryByText("raw")).not.toBeInTheDocument();
  });

  it("opens with the error that caused it already on the field", () => {
    const { dialog } = renderDialog("todo", {
      initialError: new ApiClientError({
        code: "VALIDATION_ERROR",
        message: "raw",
        details: {
          acceptanceCriteria: ["Acceptance criteria are required before a task can be todo"],
        },
        status: 422,
      }),
    });

    expect(
      within(dialog).getByText("Acceptance criteria are required before a task can be todo"),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/acceptance criteria/i)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("cancels without submitting", async () => {
    const user = userEvent.setup();
    const { onSubmit, onCancel, dialog } = renderDialog("deferred");

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
