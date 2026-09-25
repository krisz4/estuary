import { expect, test } from "@playwright/test";

import { AGENT, createTask, getTask, uniqueTitle, updateTask } from "./helpers";

/**
 * Optimistic concurrency, from the browser: an agent edits a task while a human
 * has its edit form open.
 *
 * The form sends `expectedVersion` — the version it was loaded at — so the
 * human's save is refused with `VERSION_CONFLICT` instead of silently
 * overwriting the agent's change. The page must say so, keep everything the
 * human typed, and offer to reload; after reloading, a save goes through and
 * carries the agent's change forward rather than clobbering it.
 *
 * Agents editing tasks all day is the normal case here, not an edge case, and
 * this is the one place the whole chain — form baseline, PATCH body, 409
 * envelope, notice — is exercised against a real server.
 */
test("refuses a save over an agent's concurrent edit, keeps the typed values, and saves after a reload", async ({
  page,
  request,
}) => {
  const task = await createTask(
    request,
    { description: "The export endpoint has no rate limit." },
    { actor: AGENT },
  );
  const agentDescription =
    "The export endpoint has no rate limit. Seen dropping batch jobs at 02:00.";
  const humanTitle = uniqueTitle("edited");

  await page.goto(`/tasks/${task.id}/edit`);

  const title = page.getByLabel("Title");
  const description = page.getByLabel("Description");
  await expect(title).toHaveValue(task.title);

  /* --------------- The agent writes while the form is open --------------- */

  const agentVersion = await updateTask(
    request,
    task.id,
    { description: agentDescription },
    { actor: AGENT },
  );
  expect(agentVersion.version).toBe(task.version + 1);

  /* ----------------------- The human saves over it ----------------------- */

  await title.fill(humanTitle);
  await page.getByRole("button", { name: "Save changes" }).click();

  const conflict = page.getByRole("alert").filter({
    hasText: "This task changed while you were editing",
  });
  await expect(conflict).toBeVisible();

  // Still on the form, with what was typed.
  await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}/edit$`));
  await expect(title).toHaveValue(humanTitle);

  // Nothing was written over the agent's change.
  const afterConflict = await getTask(request, task.id);
  expect(afterConflict).toMatchObject({
    title: task.title,
    description: agentDescription,
    version: agentVersion.version,
  });

  /* ------------------------ Reload, then save again ---------------------- */

  await conflict.getByRole("button", { name: "Reload task" }).click();
  await expect(conflict).toBeHidden();

  // Reloading replaces the form with the server's copy — the notice said it would.
  await expect(description).toHaveValue(agentDescription);
  await expect(title).toHaveValue(task.title);

  await title.fill(humanTitle);
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`));
  await expect(page.getByRole("heading", { level: 1, name: humanTitle })).toBeVisible();

  // The human's title *and* the agent's description: only the changed field was sent.
  const saved = await getTask(request, task.id);
  expect(saved).toMatchObject({
    title: humanTitle,
    description: agentDescription,
    version: agentVersion.version + 1,
  });
});
