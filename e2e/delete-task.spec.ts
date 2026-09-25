import { expect, test } from "@playwright/test";

import {
  addComment,
  AGENT,
  createTask,
  getTaskEvents,
  getTaskStatus,
  tableRows,
  uniqueTitle,
} from "./helpers";

/**
 * Delete a task behind the confirm dialog, and confirm it is gone — from the
 * list it came from, from a fresh search, and from the API.
 *
 * The task is this spec's own, and that is not a formality here: a delete is a
 * hard delete that cascades to comments and decisions, so a spec that removed a
 * seeded row would change what every later spec — and every later *run* — sees.
 * It carries an agent's comment so the dialog has a consequence to name.
 *
 * The route through the list is deliberate. Reaching the detail page by
 * `page.goto` would leave the query cache with no list entry at all, and then
 * "the row is gone afterwards" would hold whether or not the mutation
 * invalidated anything — a passing assertion about nothing.
 */
test("deletes a task after confirmation and removes it from the list", async ({
  page,
  request,
}) => {
  const task = await createTask(request, { title: uniqueTitle("delete") });
  await addComment(
    request,
    task.id,
    { body: "Looked at this; it is a duplicate.", kind: "note" },
    { actor: AGENT },
  );

  /*
    Page 1 of the default view is where this task is: it was created seconds
    ago and the default sort is `createdAt:desc`, so it is the newest row there
    is. Everything below depends on that, which is why it is asserted rather
    than assumed.
  */
  await page.goto("/tasks");
  const row = tableRows(page).filter({ hasText: task.reference });
  await expect(row).toHaveCount(1);

  await row.getByRole("link", { name: task.reference }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`));

  await page.getByRole("button", { name: "Delete", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: `Delete ${task.reference}?` });
  // The confirmation names the consequences, which is the only thing making it
  // a gate rather than a speed bump.
  await expect(dialog).toContainText("This also deletes its 1 comment.");
  await expect(dialog).toContainText("This can't be undone.");

  // Cancelling first: the dialog closes and nothing happens.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(await getTaskStatus(request, task.id)).toBe(200);

  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await dialog.getByRole("button", { name: "Delete task" }).click();

  // Back on the list, with the dialog gone.
  await expect(page).toHaveURL(/\/tasks(\?|$)/);
  await expect(dialog).toBeHidden();

  /*
    Gone from the list the delete navigated back to, without a reload.

    Scoped to the table rather than the page: the success toast names the task
    too. This is the assertion that needs `useDeleteTaskMutation` to invalidate
    the lists — the browser is looking at the same query key it had cached on
    the way in, and a missing invalidation puts the deleted row back on screen.
  */
  await expect(tableRows(page).filter({ hasText: task.reference })).toHaveCount(0);

  /*
    Searched for by reference — `q` matches `TASK-000042` as well as free text.
    A *different* query key, so unlike the assertion above this one is about the
    server: the row is absent because the DELETE was committed.
  */
  await page.getByRole("searchbox", { name: "Search tasks" }).fill(task.reference);
  await expect(page).toHaveURL(new RegExp(`[?&]q=${task.reference}(&|$)`));
  await expect(page.getByText("No tasks match these filters")).toBeVisible();
  await expect(tableRows(page)).toHaveCount(0);

  // Gone from the API too — but its history is not: events outlive the task.
  expect(await getTaskStatus(request, task.id)).toBe(404);
  const { data: events } = await getTaskEvents(request, task.id);
  expect(events.at(-1)?.type).toBe("task.deleted");

  // The detail URL now renders the not-found state instead of a stale task.
  await page.goto(`/tasks/${task.id}`);
  await expect(page.getByText("This task doesn't exist")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: task.title })).toBeHidden();
});
