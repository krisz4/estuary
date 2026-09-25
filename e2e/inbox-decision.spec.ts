import { expect, test } from "@playwright/test";

import {
  activity,
  AGENT,
  agentAsksForDecision,
  ANONYMOUS,
  getStats,
  getTask,
  inboxItem,
  inboxLabel,
  inboxLink,
  statusPicker,
} from "./helpers";

/**
 * Agent in the loop: an agent takes a task, gets stuck, and asks; a human
 * answers from the inbox; the task goes back to the queue with the answer on it.
 *
 * The agent's half runs over the API as `agent:e2e-bot`, the way an agent
 * actually drives the system — file a ready task, `POST /tasks/next` to take
 * it, then transition to `needs_user_decision` with a question and options.
 * The human's half is the browser.
 *
 * **The badge count is compared with `GET /tasks/stats`, not with a literal.**
 * `needsAttention` is global — the seed contributes to it and so does every
 * other spec that leaves a task waiting on a human — so the only stable
 * assertion is "the header says what the server says", before and after the
 * answer. One worker (`playwright.config.ts`) is what keeps the number still
 * between the read and the assertion.
 */
test("answers an agent's question from the inbox, and the task returns to To do with the answer", async ({
  page,
  request,
}) => {
  const question = "Which rate-limiting strategy should the export endpoint use?";
  const note = "Keep the old endpoint working for one release.";

  const task = await agentAsksForDecision(request, {
    question,
    context: "Exports spike at month end; the current limiter drops legitimate batch jobs.",
    options: [
      { label: "Token bucket", description: "Smooth bursts; one more Redis key per client." },
      { label: "Fixed window", description: "Simplest; allows a burst at each window edge." },
    ],
    recommendedOption: "Token bucket",
  });
  expect(task.status).toBe("needs_user_decision");

  const { needsAttention } = await getStats(request);

  /* ------------------------------- Inbox -------------------------------- */

  await page.goto("/inbox");

  await expect(inboxLink(page)).toHaveAccessibleName(inboxLabel(needsAttention));

  const item = inboxItem(page, task);
  await expect(item).toBeVisible();
  // In the Decisions group, from the agent, with its question and options.
  await expect(
    page.getByRole("region", { name: /^Decisions \(\d+\)$/ }).getByRole("article", {
      name: task.title,
    }),
  ).toBeVisible();
  await expect(item).toContainText("e2e-bot");
  await expect(item.getByRole("heading", { name: question })).toBeVisible();
  const options = item.getByRole("list", { name: "Options" });
  await expect(options.getByRole("button")).toHaveCount(2);
  await expect(options.getByRole("button", { name: /^Token bucket/ })).toContainText("Recommended");

  /*
    Not the recommended option, on purpose: an answer that happened to match
    the recommendation would pass against a UI that ignored which button was
    clicked.
  */
  await item.getByLabel("Add a note, or answer in your own words").fill(note);
  await options.getByRole("button", { name: /^Fixed window/ }).click();

  // Answered → the task leaves the inbox, and the badge drops by one.
  await expect(item).toHaveCount(0);
  await expect(inboxLink(page)).toHaveAccessibleName(inboxLabel(needsAttention - 1));

  /* --------------------------- The task itself -------------------------- */

  await page.goto(`/tasks/${task.id}`);

  await expect(statusPicker(page)).toHaveText("To do");
  await expect(page.getByRole("region", { name: "Latest note" })).toContainText(
    `Decision: Fixed window — ${note}`,
  );

  const pastDecisions = page.getByRole("region", { name: "Past decisions" });
  await expect(pastDecisions).toContainText(question);
  await expect(pastDecisions).toContainText("Chose: Fixed window");
  await expect(pastDecisions).toContainText(`Note: ${note}`);
  await expect(pastDecisions).toContainText("Answered by");

  // Leaving `in_progress` dropped the agent's claim: the task is up for grabs.
  await expect(page.getByText("Being worked on")).toHaveCount(0);

  const timeline = activity(page);
  await expect(timeline).toContainText("answered: Fixed window");
  await expect(timeline).toContainText("asked for a decision");

  const stored = await getTask(request, task.id);
  expect(stored).toMatchObject({ status: "todo", claim: null, openDecision: null });
  expect(stored.decisions).toMatchObject([
    {
      question,
      status: "answered",
      choice: "Fixed window",
      note,
      requestedBy: AGENT,
      answeredBy: ANONYMOUS,
    },
  ]);
});
