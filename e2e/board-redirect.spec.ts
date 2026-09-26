import { expect, test } from "@playwright/test";

/**
 * The Kanban board was retired in favor of the Map (Estuary,
 * `docs/pages/Tasks_Map.md`). `/tasks/board` redirects rather than 404s,
 * preserving the query string, so a bookmark or a link shared before the
 * retirement still lands somewhere useful. See `router.tsx`'s `BoardRedirect`.
 */
test("redirects /tasks/board to /tasks/map, keeping the query string", async ({ page }) => {
  await page.goto("/tasks/board?status=todo&priority=high");

  await expect(page).toHaveURL(/\/tasks\/map\?.*status=todo/);
  await expect(page).toHaveURL(/\/tasks\/map\?.*priority=high/);
});
