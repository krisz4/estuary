import { expect, test } from "@playwright/test";

import {
  ANONYMOUS,
  getTask,
  pickOption,
  statusPicker,
  tableRows,
  uniqueProject,
  uniqueTitle,
} from "./helpers";

/**
 * Create a task through the form, land on its detail page, find it in the list,
 * and narrow the list to its project.
 *
 * The one spec that drives the **create form** rather than the API: it is the
 * proof that the form, its zod resolver (the contract's own schema), the POST,
 * and the redirect all agree. Every other spec builds its fixtures over HTTP.
 *
 * It starts the task in **To do**, which is the one starting status with a
 * precondition — acceptance criteria — so the first submit is made without them
 * on purpose: the contract's message has to appear on the field, and nothing
 * already typed may be lost (`A failed submit never clears the form`).
 *
 * "At the top of the list" is a real assertion rather than a decoration: the
 * default sort is `createdAt:desc`, and a task created a second ago is the
 * newest row there is. It is what proves the list is not serving a cached page
 * from before the mutation — the invalidation in `useCreateTaskMutation`.
 */
test("creates a To do task with a project and criteria, then finds it by project in the list", async ({
  page,
  request,
}) => {
  const title = uniqueTitle("create");
  const project = uniqueProject("create");
  const criteria = "Duplex jobs print without jamming on floor 3.";

  await page.goto("/tasks");

  // Through the header button, which is how a user actually reaches the form —
  // and the only thing that carries the return state onto it.
  await page.getByRole("link", { name: "New task" }).click();
  await expect(page).toHaveURL(/\/tasks\/new$/);

  await page.getByLabel("Title").fill(title);
  await page
    .getByLabel("Description")
    .fill("The printer on floor 3 jams on every duplex job.\nSingle-sided prints are fine.");
  await page.getByLabel("Project", { exact: true }).fill(project);
  await pickOption(page, page.getByRole("combobox", { name: "Starting status" }), "To do");

  /* ------------- To do without criteria: refused, nothing lost ------------- */

  await page.getByRole("button", { name: "Create task" }).click();

  const criteriaField = page.getByLabel(/^Acceptance criteria/);
  await expect(criteriaField).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByText("Acceptance criteria are required before a task can be todo"),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/tasks\/new$/);
  await expect(page.getByLabel("Title")).toHaveValue(title);
  await expect(page.getByLabel("Project", { exact: true })).toHaveValue(project);

  await criteriaField.fill(criteria);
  await page.getByRole("button", { name: "Create task" }).click();

  /* ---------------------------- Detail page ---------------------------- */

  await expect(page).toHaveURL(/\/tasks\/\d+$/);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();

  const taskId = Number(new URL(page.url()).pathname.split("/").pop());
  const reference = `TASK-${String(taskId).padStart(6, "0")}`;
  // The eyebrow above the title.
  await expect(page.getByText(reference, { exact: true }).first()).toBeVisible();

  await expect(statusPicker(page)).toHaveText("To do");
  await expect(page.getByRole("region", { name: "Acceptance criteria" })).toContainText(criteria);
  await expect(page.getByText(project, { exact: true })).toBeVisible();

  // What the server stored, not what the form echoed back.
  const stored = await getTask(request, taskId);
  expect(stored).toMatchObject({
    reference,
    title,
    status: "todo",
    project,
    acceptanceCriteria: criteria,
    createdBy: ANONYMOUS,
    version: 1,
  });

  /* ------------------------------- List -------------------------------- */

  /*
    Back to the list through the header's own link — a client-side navigation,
    not a `page.goto`. A full reload would start from an empty query cache and
    prove nothing about invalidation.
  */
  await page.getByRole("banner").getByRole("link", { name: "Estuary", exact: true }).click();
  await expect(page).toHaveURL(/\/tasks$/);

  const firstRow = tableRows(page).first();
  await expect(firstRow).toContainText(reference);
  await expect(firstRow).toContainText(title);

  /* -------------------------- Filter by project ------------------------ */

  /*
    Project is a scope, picked in the header's switcher; the filter bar has no
    project control of its own. The switcher's options are the facets, so the
    new project being offered at all is the create mutation's invalidation of
    `facets` at work.
  */
  const projectSwitcher = page.getByRole("combobox", { name: "Current project" });
  await pickOption(page, projectSwitcher, project);

  await expect(page).toHaveURL(new RegExp(`[?&]project=${project}(&|$)`));
  await expect(projectSwitcher).toHaveText(project);
  await expect.poll(() => tableRows(page).count()).toBe(1);
  await expect(tableRows(page).first()).toContainText(reference);

  // The filter is the URL's, so it survives a reload.
  await page.reload();
  await expect.poll(() => tableRows(page).count()).toBe(1);
  await expect(tableRows(page).first()).toContainText(reference);
});
