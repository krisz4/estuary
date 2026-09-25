import { expect, test } from "@playwright/test";

import { tableRows } from "./helpers";

/**
 * The list at 360px renders the card layout.
 *
 * Responsive is a requirement, and this is the assertion no component test can
 * make: `TaskCardList` and `TaskTable` are two different components chosen by
 * a `matchMedia` result, and jsdom's `matchMedia` is whatever the test stubs it
 * to be. Only a real viewport decides which of the two actually renders.
 *
 * 360px because that is the floor the design guidelines set — the narrowest
 * width every page must work at, and the one the overflow check is about.
 */
test.use({ viewport: { width: 360, height: 800 } });

test("renders the card layout, not a table, on a 360px viewport", async ({ page }) => {
  await page.goto("/tasks");

  const cards = page.getByRole("link").filter({ hasText: /^TASK-\d{6}/ });
  await expect(cards.first()).toBeVisible();

  // The table is not merely hidden — it is not rendered at all, which is what
  // keeps a screen reader from meeting a second copy of the list.
  await expect(page.locator("table")).toHaveCount(0);
  await expect(tableRows(page)).toHaveCount(0);

  // The whole card is one link, so the tap target is the card rather than the
  // reference text inside it.
  const card = cards.first();
  await expect(card).toContainText(/^TASK-\d{6}/);
  expect((await card.boundingBox())?.height ?? 0).toBeGreaterThan(44);

  // Filters move behind a button below `md`; inline chips at this width would
  // push the tasks themselves below the fold.
  await expect(page.getByRole("button", { name: /^Filters/ })).toBeVisible();

  // Nothing scrolls sideways. This is the check the design guidelines actually
  // ask for, and the one a screenshot of a *passing* layout can still hide.
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);

  // A card navigates to its task.
  const reference = (await card.innerText()).match(/TASK-\d{6}/)?.[0];
  await card.click();
  await expect(page).toHaveURL(/\/tasks\/\d+$/);
  await expect(page.getByText(reference ?? "TASK-").first()).toBeVisible();
});
