import { expect, test } from "@playwright/test";

import {
  activity,
  ANONYMOUS,
  createTask,
  escapeRegExp,
  getTask,
  getTaskEvents,
  pickOption,
  statusPicker,
} from "./helpers";

/**
 * The detail page's workflow: status changes that need words, a typed comment,
 * and the activity timeline that records both.
 *
 * Status is not a field here — every change is `POST /tasks/:id/transition`,
 * and the targets this spec picks (**Blocked**, **Deferred**) each require a
 * payload, so the picker opens `TransitionDialog` instead of posting. Deferred
 * is submitted empty first: the dialog must refuse with its own copy and stay
 * open with nothing lost.
 *
 * The **reload** at the end is what separates this from the component tests,
 * which cover the same UI against a mocked network. Only a round trip through a
 * real database can tell an optimistic update apart from a persisted one.
 */
test("moves a task through dialogs that ask for a reason, comments with a kind, and records it all", async ({
  page,
  request,
}) => {
  const task = await createTask(request, { priority: "high" });
  const blockedReason = "Waiting on the vendor to rotate the staging API key.";
  const deferredReason = "Parked until the Q3 vendor contract is renewed.";
  const progress = "Reproduced locally; the failing call is the token refresh.";

  await page.goto(`/tasks/${task.id}`);
  await expect(page.getByRole("heading", { level: 1, name: task.title })).toBeVisible();
  await expect(statusPicker(page)).toHaveText("Backlog");

  /* ------------------------------ → Blocked ------------------------------ */

  await pickOption(page, statusPicker(page), "Blocked");

  const blockedDialog = page.getByRole("dialog", { name: `Move ${task.reference} to Blocked` });
  await expect(blockedDialog).toBeVisible();
  await blockedDialog.getByLabel("Why is it blocked?").fill(blockedReason);
  await blockedDialog.getByRole("button", { name: "Move to Blocked" }).click();

  await expect(blockedDialog).toBeHidden();
  await expect(statusPicker(page)).toHaveText("Blocked");
  await expect(page.getByRole("region", { name: "Blocked because…" })).toContainText(blockedReason);

  /* ------------------------------ → Deferred ----------------------------- */

  await pickOption(page, statusPicker(page), "Deferred");

  const deferredDialog = page.getByRole("dialog", { name: `Move ${task.reference} to Deferred` });
  const parkedField = deferredDialog.getByLabel(/^Why is it parked\?/);

  // Refused client-side with the dialog's own copy; nothing is posted.
  await deferredDialog.getByRole("button", { name: "Move to Deferred" }).click();
  await expect(deferredDialog.getByText("Say why it is being parked")).toBeVisible();
  await expect(parkedField).toHaveAttribute("aria-invalid", "true");
  // Asked of the API: the page behind a modal is `aria-hidden`, and the point
  // is that nothing was written, not what the obscured picker says.
  expect((await getTask(request, task.id)).status).toBe("blocked");

  await parkedField.fill(deferredReason);
  await deferredDialog.getByRole("button", { name: "Move to Deferred" }).click();

  await expect(deferredDialog).toBeHidden();
  await expect(statusPicker(page)).toHaveText("Deferred");
  // The note is replaced on every transition — the blocker is history now.
  await expect(page.getByRole("region", { name: "Deferred because…" })).toContainText(
    deferredReason,
  );
  await expect(page.getByRole("region", { name: "Blocked because…" })).toHaveCount(0);

  /* ------------------------ Comment, with a kind ------------------------- */

  /*
    By role, not `getByLabel("Comment")`: the thread's own `<section>` is
    labelled "Comments", and a label lookup matches that region as well.
  */
  const commentBody = page.getByRole("textbox", { name: "Comment" });
  await commentBody.fill(progress);
  await pickOption(page, page.getByRole("combobox", { name: "Kind" }), "Progress");
  await page.getByRole("button", { name: "Add comment" }).click();

  const thread = page.getByRole("list", { name: "Comment thread" });
  const comment = thread.getByRole("listitem").filter({ hasText: progress });
  await expect(comment).toBeVisible();
  await expect(comment).toContainText("Progress");
  await expect(comment).toContainText("Anonymous");

  // Cleared on success — and only then.
  await expect(commentBody).toHaveValue("");

  /* ------------------------------ Timeline ------------------------------- */

  /*
    Newest first. Read as a whole list rather than one `toContainText` per
    line, so an event recorded twice — or in the wrong order — fails too.
  */
  const expectedTimeline = [
    /Human Anonymous\s*logged progress/,
    new RegExp(
      `Human Anonymous\\s*moved it from Blocked to Deferred\\s*“${escapeRegExp(deferredReason)}”`,
    ),
    new RegExp(
      `Human Anonymous\\s*moved it from Backlog to Blocked\\s*“${escapeRegExp(blockedReason)}”`,
    ),
    /Human Anonymous\s*created the task in Backlog/,
  ];
  await expect(activity(page).getByRole("listitem")).toHaveText(expectedTimeline);

  /* ------------------------------- Reload -------------------------------- */

  await page.reload();

  await expect(statusPicker(page)).toHaveText("Deferred");
  await expect(page.getByRole("list", { name: "Comment thread" })).toContainText(progress);
  await expect(activity(page).getByRole("listitem")).toHaveText(expectedTimeline);

  // And the server agrees on every point, including who did it.
  const stored = await getTask(request, task.id);
  expect(stored.status).toBe("deferred");
  expect(stored.statusNote).toBe(deferredReason);
  expect(stored.comments).toMatchObject([{ body: progress, kind: "progress", author: ANONYMOUS }]);

  const { data: events } = await getTaskEvents(request, task.id);
  expect(events.map((event) => [event.type, event.actor])).toEqual([
    ["task.created", ANONYMOUS],
    ["task.status_changed", ANONYMOUS],
    ["task.status_changed", ANONYMOUS],
    ["comment.created", ANONYMOUS],
  ]);
});
