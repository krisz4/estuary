import { expect, test } from "@playwright/test";

import { columnTexts, PRIORITY_LABEL_RANK, rowReferences, tableRows } from "./helpers";

/**
 * Spec 2 — filter by status, sort by priority, page forward; the URL reflects
 * every step and survives a reload.
 *
 * Read-only by design: it touches nothing, so it can run in any position
 * relative to the mutating specs. It is also the one spec that legitimately
 * wants the seed — 63 rows is what makes a second page exist at all — and it
 * asserts *relationships* (all rows open, priorities non-increasing, page 2
 * disjoint from page 1) rather than particular seeded ticket numbers, so
 * re-rolling the seed does not break it.
 *
 * The reload is the point. `docs/features/Ticket_Query_Filter_Sort_Page.md`
 * makes the URL the single source of list state; a filter kept in React state
 * would pass every step of this spec until the reload, and then serve an
 * unfiltered page 1 from an address that says otherwise.
 *
 * **Every read of the rows goes through `expect.poll`.** The list deliberately
 * keeps the previous rows on screen while the next query is in flight, so a
 * one-shot read after a click is a race — and it is the race that failed this
 * file's first run, against an implementation that was behaving correctly.
 */

const STATUS_COLUMN = 3;
const PRIORITY_COLUMN = 4;

test("filters, sorts, and pages the list through the URL, and survives a reload", async ({
  page,
}) => {
  await page.goto("/tickets");
  await expect(tableRows(page).first()).toBeVisible();

  /* ---------------- Filter ---------------- */

  /*
    The chip's own `<input type="checkbox">` is `sr-only` — a 1px box under the
    styled `<span>` that is the visible control — so `.check()` on it is a click
    the label intercepts. Clicking the label's text is both what a user does and
    what actually toggles the input, and scoping it to the `Status` fieldset (a
    `group` named by its legend) keeps it off the identically-labelled chips in
    the priority and category groups.
  */
  const statusFilter = page.getByRole("group", { name: "Status" });
  await statusFilter.getByText("Open", { exact: true }).click();
  await expect(statusFilter.getByRole("checkbox", { name: "Open", exact: true })).toBeChecked();

  await expect(page).toHaveURL(/[?&]status=open(&|$)/);
  await expect(page.getByRole("button", { name: "Remove filter: Status: Open" })).toBeVisible();

  await expect
    .poll(async () => {
      const statuses = await columnTexts(page, STATUS_COLUMN);
      // `[]` would satisfy "every row is open" vacuously, so the emptiness is
      // folded into the polled value rather than asserted separately after it.
      return statuses.length > 0 && statuses.every((status) => status === "Open");
    })
    .toBe(true);

  /* ---------------- Sort ------------------ */

  await page.getByRole("button", { name: "Sort by priority, descending" }).click();

  await expect(page).toHaveURL(/[?&]sort=priority%3Adesc(&|$)/);
  // Sorting resets to page 1 — a filter or sort change may shrink the result
  // set below the current page (`useTicketListParams`).
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

    **Asserted across both pages, not within page 1**, and that is not thoroughness
    for its own sake. Checked on page 1 alone this assertion does not
    discriminate: with the seeded data the open subset is 3 urgent / 6 high /
    11 medium / 6 low, so a text sort fills page 1 with urgent, medium, and low
    — a sequence that is *already* non-increasing by rank — and puts every
    `high` row on page 2. Swapping `priorityRank` for `priority` in the API's
    sort map was a live probe that passed the page-1 version of this check.
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
