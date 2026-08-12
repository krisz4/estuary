import { expect, test } from "@playwright/test";

import { createTicket } from "./helpers";

/**
 * Spec 3 — open a ticket, add a comment, change its status, and confirm both
 * survive a reload.
 *
 * It creates its own ticket (over the API — spec 1 owns the form) because both
 * halves mutate. Commenting on a seeded ticket would leave the suite's second
 * run reading a thread the first run wrote.
 *
 * The **reload** is what separates this from the component tests, which already
 * cover the optimistic update and the toast against a mocked network. Only a
 * round trip through a real database can tell an optimistic update apart from a
 * persisted one, and that difference is the entire bug class this spec exists
 * for.
 */
test("adds a comment and changes status, and both persist across a reload", async ({
  page,
  request,
}) => {
  const ticket = await createTicket(request, { priority: "high" });
  const body = "Confirmed on a second machine — it is not user-specific.";

  await page.goto(`/tickets/${ticket.id}`);
  await expect(page.getByRole("heading", { level: 1, name: ticket.title })).toBeVisible();

  /* ---------------- Comment ---------------- */

  await page.getByLabel("Your name").fill("Marcus Feld");
  /*
    By role, not `getByLabel("Comment")`: the thread's own `<section>` is labelled
    "Comments", and a label lookup matches that region as well as the textarea.
  */
  const commentBody = page.getByRole("textbox", { name: "Comment" });
  await commentBody.fill(body);
  await page.getByRole("button", { name: "Add comment" }).click();

  const thread = page.getByRole("list", { name: "Comment thread" });
  await expect(thread.getByText(body)).toBeVisible();
  await expect(thread.getByText("Marcus Feld")).toBeVisible();

  // Cleared on success, and only the body — the author is kept, because the
  // next comment is usually from the same person (`docs/features/Comments.md`).
  await expect(commentBody).toHaveValue("");
  await expect(page.getByLabel("Your name")).toHaveValue("Marcus Feld");

  /* ---------------- Status ----------------- */

  const status = page.getByRole("combobox", { name: "Status" });
  await expect(status).toHaveText("Open");

  await status.click();
  await page.getByRole("option", { name: "In progress" }).click();

  await expect(status).toHaveText("In progress");

  /* ---------------- Reload ----------------- */

  await page.reload();

  await expect(page.getByRole("combobox", { name: "Status" })).toHaveText("In progress");
  await expect(page.getByRole("list", { name: "Comment thread" }).getByText(body)).toBeVisible();
});
