import { expect, test } from "@playwright/test";

import { activity, createTask, getTask, getTaskEvents, pickOption, statusPicker } from "./helpers";

/**
 * "You": the name a browser's writes are attributed to.
 *
 * There are no accounts. A person says who they are once, in the header's
 * session dialog, and from then on every request carries
 * `X-Actor: human:<slug>` — so the activity log can tell their changes from an
 * agent's. Nothing about that is visible in a mocked component test: the
 * header is set by the fetch client from a persisted store, and only the
 * *server's* record proves it was sent. So this spec asks the API who wrote
 * what, rather than trusting what the page renders.
 *
 * Each Playwright test gets a fresh browser context, so the name set here is
 * in this test's `localStorage` only and cannot leak into another spec.
 */
test("attributes writes to the name set under You, and remembers it across a reload", async ({
  page,
  request,
}) => {
  const task = await createTask(request);
  const actor = "human:ada-lovelace";
  const body = "Checked the logs; the retry storm starts at 02:00 UTC.";

  await page.goto(`/tasks/${task.id}`);
  await expect(page.getByRole("heading", { level: 1, name: task.title })).toBeVisible();

  // Anonymous until told otherwise.
  await expect(page.getByText("Posting as")).toContainText("Anonymous");

  /* --------------------------- Set the name ---------------------------- */

  await page.getByRole("banner").getByRole("button", { name: "You", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "You" });
  const nameField = dialog.getByLabel("Your name");
  await nameField.fill("Ada Lovelace");
  // The slug is shown before it is saved, so nobody is surprised by it later.
  await expect(dialog).toContainText(`Your changes are recorded as ${actor}.`);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  const you = page.getByRole("banner").getByRole("button", { name: "ada-lovelace" });
  await expect(you).toBeVisible();
  await expect(page.getByText("Posting as")).toContainText("ada-lovelace");

  /* ------------------------ Write as that person ----------------------- */

  await page.getByRole("textbox", { name: "Comment" }).fill(body);
  await page.getByRole("button", { name: "Add comment" }).click();
  await expect(page.getByRole("list", { name: "Comment thread" })).toContainText(body);

  // Criteria are already there, so To do asks for nothing: a direct transition.
  await pickOption(page, statusPicker(page), "To do");
  await expect(statusPicker(page)).toHaveText("To do");

  await expect(activity(page)).toContainText(/ada-lovelace\s*moved it from Backlog to To do/);

  /* ---------------------- What the server recorded --------------------- */

  const stored = await getTask(request, task.id);
  expect(stored.comments).toMatchObject([{ body, author: actor }]);

  const { data: events } = await getTaskEvents(request, task.id);
  expect(events.map((event) => [event.type, event.actor])).toEqual([
    ["task.created", "human:anonymous"],
    ["comment.created", actor],
    ["task.status_changed", actor],
  ]);

  /* ------------------------------ Reload ------------------------------- */

  // Persisted to `localStorage`: the next session writes as the same person.
  await page.reload();
  await expect(
    page.getByRole("banner").getByRole("button", { name: "ada-lovelace" }),
  ).toBeVisible();
  await expect(page.getByText("Posting as")).toContainText("ada-lovelace");
});
