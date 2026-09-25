import { expect, test } from "@playwright/test";

import {
  columnTexts,
  OPEN_STATUS_LABELS,
  PRIORITY_LABEL_RANK,
  rowReferences,
  tableRows,
} from "./helpers";

/**
 * Filter to open work, sort by priority, page forward; the URL reflects every
 * step and survives a reload.
 *
 * Read-only by design: it touches nothing, so it can run in any position
 * relative to the mutating specs. It is also the one spec that legitimately
 * wants the seed — a second page of open work exists only because the seed
 * makes one — and it asserts *relationships* (every row open, priorities
 * non-increasing across a page boundary, page 2 disjoint from page 1) rather
 * than particular seeded task numbers, so re-rolling the seed does not break it.
 *
 * The reload is the point. `docs/features/Task_Query_Filter_Sort_Page.md`
 * makes the URL the single source of list state; a filter kept in React state
 * would pass every step of this spec until the reload, and then serve an
 * unfiltered page 1 from an address that says otherwise.
 *
 * **Every read of the rows goes through `expect.poll`.** The list deliberately
 * keeps the previous rows on screen while the next query is in flight, so a
 * one-shot read after a click is a race.
 */

const STATUS_COLUMN = 3;
const PRIORITY_COLUMN = 4;

test("filters, sorts, and pages the list through the URL, and survives a reload", async ({
  page,
}) => {
  await page.goto("/tasks");
  await expect(tableRows(page).first()).toBeVisible();

  /* ---------------- Filter ---------------- */

  /*
    "Open work" is a preset beside the Status legend: every status except Done
    and Deferred, in one click. It writes the same repeated `status` param the
    individual chips do, so the chips light up with it.
  */
  const statusFilter = page.getByRole("group", { name: "Status" });
  const openWork = statusFilter.getByRole("button", { name: "Open work" });
  await openWork.click();
  await expect(openWork).toHaveAttribute("aria-pressed", "true");
  await expect(statusFilter.getByRole("checkbox", { name: "Backlog", exact: true })).toBeChecked();
  await expect(statusFilter.getByRole("checkbox", { name: "Done", exact: true })).not.toBeChecked();

  await expect(page).toHaveURL(/[?&]status=backlog(&|$)/);
  await expect(page).toHaveURL(/[?&]status=needs_qa(&|$)/);
  await expect(page).not.toHaveURL(/[?&]status=(done|deferred)(&|$)/);

  await expect
    .poll(async () => {
      const statuses = await columnTexts(page, STATUS_COLUMN);
      // `[]` would satisfy "every row is open" vacuously, so the emptiness is
      // folded into the polled value rather than asserted separately after it.
      return statuses.length > 0 && statuses.every((status) => OPEN_STATUS_LABELS.includes(status));
    })
    .toBe(true);

  /* ---------------- Sort ------------------ */

  await page.getByRole("button", { name: "Sort by priority, descending" }).click();

  await expect(page).toHaveURL(/[?&]sort=priority%3Adesc(&|$)/);
  // Sorting resets to page 1 — a filter or sort change may shrink the result
  // set below the current page (`useTaskListParams`).
  await expect(page).not.toHaveURL(/[?&]page=/);

  // Highest first, which is what "Priority: high to low" promises and what
  // someone triaging a queue opens the page for.
  await expect.poll(async () => (await columnTexts(page, PRIORITY_COLUMN))[0]).toBe("Urgent");

  const firstPagePriorities = await columnTexts(page, PRIORITY_COLUMN);
  const firstPageReferences = await rowReferences(page);
  expect(firstPageReferences.length).toBeGreaterThan(0);

  /* ---------------- Page ------------------ */

  await page.getByRole("button", { name: "Next page" }).click();

  await expect(page).toHaveURL(/[?&]page=2(&|$)/);
  /*
    The pager's own text is the settle signal for the rows: both are rendered
    from the same `data`, so "Showing 21–…" cannot appear while page 1's rows
    are still on screen.
  */
  await expect(page.getByRole("navigation", { name: "Pagination" })).toContainText(/Showing 21–/);

  const secondPageReferences = await rowReferences(page);
  expect(secondPageReferences.length).toBeGreaterThan(0);
  // No row appears on two pages — the `id` tiebreaker behind a non-unique sort
  // key, seen from the browser rather than from a service test.
  expect(secondPageReferences.filter((ref) => firstPageReferences.includes(ref))).toEqual([]);

  /* ---------------- Sort order, across the page boundary ---------------- */

  /*
    Non-increasing by *rank*, which is the whole reason the API carries a
    `priorityRank` column: sorted as text, the order is urgent, medium, low,
    high — `high` last, not second.

    **Asserted across both pages, not within page 1.** On one page a text sort
    can happen to produce a sequence that is already non-increasing by rank
    (urgent, medium, low — with every `high` row pushed to page 2); only the
    boundary between pages shows the difference.
  */
  const priorities = [...firstPagePriorities, ...(await columnTexts(page, PRIORITY_COLUMN))];
  const ranks = priorities.map((label) => {
    const rank = PRIORITY_LABEL_RANK[label];
    expect(rank, `unrecognised priority label ${JSON.stringify(label)}`).not.toBeUndefined();
    return rank as number;
  });
  expect(ranks.length).toBeGreaterThan(firstPagePriorities.length);
  expect(ranks).toEqual([...ranks].sort((a, b) => b - a));

  /* ---------------- Reload ---------------- */

  const url = page.url();
  await page.reload();

  expect(page.url()).toBe(url);
  await expect(tableRows(page).first()).toBeVisible();
  await expect.poll(() => rowReferences(page)).toEqual(secondPageReferences);
});
