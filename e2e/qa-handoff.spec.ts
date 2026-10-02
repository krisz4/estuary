import { expect, test } from "@playwright/test";

import {
  activity,
  AGENT,
  ANONYMOUS,
  claimTask,
  createTask,
  getTask,
  inboxItem,
  statusPicker,
  transitionTask,
  uniqueProject,
  uniqueTitle,
} from "./helpers";

/**
 * The QA hand-off, both ways round.
 *
 * An agent finishes work and moves the task to `needs_qa` with a summary and a
 * PR link. A human sends it back from the inbox with a reason — which is two
 * writes: the task goes to `todo` with the reason as its note, **and** the
 * reason is posted as a `qa_feedback` comment, so it is still in the thread
 * after the next transition replaces the note. The agent picks it up again,
 * re-submits, and this time the human approves it into `done` — the one status
 * an agent cannot move a task to itself.
 *
 * The agent's re-submission lands while the inbox is open; the spec reloads
 * rather than waiting out the 15 s poll, because the poll is not what is under
 * test and waiting for it would make the spec slow for nothing.
 */
test("sends an agent's work back from the inbox with feedback, then approves the re-submission", async ({
  page,
  request,
}) => {
  const pr = { label: "PR #123", url: "https://github.com/example/estuary/pull/123" };
  const firstSummary = "Added rate limiting to /exports. Verify with `pnpm test:api`.";
  const feedback = "The 429 response is missing the Retry-After header.";
  const secondSummary = "Retry-After is now set on every 429; covered by a route test.";

  /* -------------------- Agent: take the work, hand it to QA -------------------- */

  const created = await createTask(
    request,
    { status: "todo", project: uniqueProject("qa"), title: uniqueTitle("qa") },
    { actor: AGENT },
  );
  await claimTask(request, created.id, { actor: AGENT });
  const task = await transitionTask(
    request,
    created.id,
    { to: "needs_qa", summary: firstSummary, links: [pr] },
    { actor: AGENT },
  );
  expect(task.status).toBe("needs_qa");

  /* ------------------------ Human: send it back -------------------------- */

  await page.goto("/inbox");

  const readyForQa = page.getByRole("region", { name: /^Ready for QA \(\d+\)$/ });
  const item = inboxItem(page, task);
  await expect(readyForQa.getByRole("article", { name: task.title })).toBeVisible();
  await expect(item.getByRole("region", { name: "QA summary" })).toContainText(firstSummary);
  await expect(item.getByRole("link", { name: pr.label })).toHaveAttribute("href", pr.url);

  await item.getByRole("button", { name: "Send back" }).click();

  const dialog = page.getByRole("dialog", { name: `Send ${task.reference} back` });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/^What needs fixing\?/).fill(feedback);
  await dialog.getByRole("button", { name: "Send back" }).click();

  await expect(dialog).toBeHidden();
  await expect(item).toHaveCount(0);

  const sentBack = await getTask(request, task.id);
  expect(sentBack).toMatchObject({ status: "todo", statusNote: feedback, claim: null });
  expect(sentBack.comments).toMatchObject([
    { body: feedback, kind: "qa_feedback", author: ANONYMOUS },
  ]);

  /* ------------------ Agent: pick it up again, re-submit ----------------- */

  await claimTask(request, task.id, { actor: AGENT });
  await transitionTask(
    request,
    task.id,
    // The same PR again — links are merged by URL, so this must not duplicate it.
    { to: "needs_qa", summary: secondSummary, links: [pr] },
    { actor: AGENT },
  );

  /* --------------------------- Human: approve ---------------------------- */

  await page.reload();

  await expect(item.getByRole("region", { name: "QA summary" })).toContainText(secondSummary);
  await expect(item.getByRole("link", { name: pr.label })).toHaveCount(1);

  await item.getByRole("button", { name: "Approve" }).click();
  await expect(item).toHaveCount(0);

  const approved = await getTask(request, task.id);
  expect(approved.status).toBe("done");
  expect(approved.completedAt).not.toBeNull();
  expect(approved.links).toEqual([pr]);

  /* ----------------------- The record on the task ------------------------ */

  await page.goto(`/tasks/${task.id}`);

  await expect(statusPicker(page)).toHaveText("Done");

  const feedbackComment = page
    .getByRole("list", { name: "Comment thread" })
    .getByRole("listitem")
    .filter({ hasText: feedback });
  await expect(feedbackComment).toContainText("QA feedback");

  const timeline = activity(page);
  await expect(timeline).toContainText("left QA feedback");
  await expect(timeline).toContainText("moved it from Needs QA to Done");
  await expect(timeline).toContainText("moved it from Needs QA to To do");
});
