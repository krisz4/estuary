import { expect, test } from "@playwright/test";

import { uniqueTitle } from "./helpers";

/**
 * Spec 1 — create a ticket, land on its detail page, find it at the top of the
 * list.
 *
 * The one spec that drives the **create form** rather than the API: it is the
 * proof that the form, its zod resolver, the POST, and the redirect all agree.
 * Every other spec builds its fixtures over HTTP for exactly that reason — this
 * one already covers the form, and repeating it elsewhere would only widen the
 * surface a failure could come from.
 *
 * "At the top of the list" is a real assertion rather than a decoration: the
 * default sort is `createdAt:desc`, and a ticket created a second ago is the
 * newest row there is. It is what proves the list is not serving a cached page
 * from before the mutation — the invalidation in `useCreateTicketMutation`.
 */
test("creates a ticket from the form and shows it at the top of the list", async ({ page }) => {
  const title = uniqueTitle("create");

  await page.goto("/tickets");

  // Through the header button, which is how a user actually reaches the form —
  // and the only thing that carries the return state onto it.
  await page.getByRole("link", { name: "New ticket" }).click();
  await expect(page).toHaveURL(/\/tickets\/new$/);

  await page.getByLabel("Title").fill(title);
  await page
    .getByLabel("Description")
    .fill("The printer on floor 3 jams on every duplex job.\nSingle-sided prints are fine.");
  await page.getByLabel("Requester name").fill("Dana Whitfield");
  await page.getByLabel("Requester email").fill("Dana.Whitfield@Example.com");

  await page.getByRole("button", { name: "Create ticket" }).click();

  // Redirected to the created ticket, whose id is in the URL.
  await expect(page).toHaveURL(/\/tickets\/\d+$/);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();

  const reference = (
    await page
      .getByText(/^HD-\d{6}$/)
      .first()
      .innerText()
  ).trim();
  expect(reference).toMatch(/^HD-\d{6}$/);

  // The email is lowercased on write (`docs/features/Tickets.md` § Rules), so
  // this also pins that the value round-trips through the API rather than being
  // echoed back from the form's own state.
  await expect(page.getByRole("link", { name: "dana.whitfield@example.com" })).toBeVisible();

  // Defaults the form never asked about.
  await expect(page.getByRole("combobox", { name: "Status" })).toHaveText("Open");
  await expect(page.getByText("Unassigned")).toBeVisible();

  /*
    Back to the list through the app's own header link — a client-side
    navigation, not a `page.goto`. A full reload would start from an empty query
    cache and prove nothing about invalidation; this way the list is served by
    the same TanStack Query cache the mutation had to invalidate, which is where
    "created it, and the list still shows the old page" actually lives.
  */
  await page.getByRole("link", { name: "Helpdesk" }).click();
  await expect(page).toHaveURL(/\/tickets$/);

  const firstRow = page.locator("table tbody tr").first();
  await expect(firstRow).toContainText(reference);
  await expect(firstRow).toContainText(title);
});
