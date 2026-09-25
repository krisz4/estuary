import { expect, test, type Locator, type Page } from "@playwright/test";

import { createTask, getTask, pickOption } from "./helpers";

/**
 * The board: ten status columns in four lanes, and the one assertion no
 * component test can make — that a real mouse drag moves a task.
 *
 * `@dnd-kit` is driven entirely by pointer geometry. Its `MouseSensor` waits for
 * 6px of movement before a press becomes a drag, and its collision detection
 * asks every droppable for a bounding rect — in jsdom every rect is 0×0, so a
 * simulated drag there proves the test's own arithmetic and nothing about the
 * app. The component suite therefore drives the *other* entry point into the
 * same `move()` (the card's status select), and this spec drives the pointer.
 *
 * The mutating tests create their own task and open the board with `?q=` its
 * title, so each column holds at most that one card and every drag has an
 * unambiguous source and target.
 */

/** One status column — a `<section>` labelled with its status and live count. */
const column = (page: Page, status: string): Locator =>
  page.getByRole("region", { name: new RegExp(`^${status} —`) });

/** One lane — Plan, Doing, Waiting, Closed — labelled by its heading. */
const lane = (page: Page, name: string): Locator => page.getByRole("region", { name, exact: true });

const cardIn = (page: Page, status: string, reference: string): Locator =>
  column(page, status).getByRole("listitem").filter({ hasText: reference });

/**
 * A press-move-release drag, in steps.
 *
 * `steps` is not decoration: a single jump from source to target is one
 * `mousemove`, and the sensor needs a move *after* activation to know where the
 * pointer went — one event does both at once and the drop lands wherever the
 * library last believed the cursor was. Ten intermediate moves is what a real
 * hand produces and what the collision detection is written against.
 *
 * The card is grabbed by its **title**, a few pixels in from the left edge: the
 * listeners are on the whole card, but its lower half is the status select,
 * which stops `pointerdown` so that a press on it opens the listbox instead.
 */
const dragTo = async (page: Page, card: Locator, target: Locator): Promise<void> => {
  await card.scrollIntoViewIfNeeded();
  const from = await card.boundingBox();
  const to = await target.boundingBox();
  expect(from, "the card has no layout").not.toBeNull();
  expect(to, "the target column has no layout").not.toBeNull();

  const startX = from!.x + 24;
  const startY = from!.y + 40;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Past the 6px activation threshold first, so the sensor is dragging before
  // the pointer is over the target.
  await page.mouse.move(startX + 4, startY + 20, { steps: 5 });
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 10 });
  await page.mouse.up();
};

test("renders the four lanes, with Closed collapsed until asked for", async ({ page }) => {
  await page.goto("/tasks/board");

  for (const name of ["Plan", "Doing", "Waiting", "Closed"]) {
    await expect(lane(page, name).getByRole("heading", { level: 2, name })).toBeVisible();
  }

  // Every open status is a column, in its lane.
  const columns: Record<string, string[]> = {
    Plan: ["Backlog", "Needs refinement", "To do"],
    Doing: ["In progress", "Needs QA"],
    Waiting: ["Blocked", "Needs decision", "Needs action"],
  };
  for (const [name, statuses] of Object.entries(columns)) {
    for (const status of statuses) {
      await expect(
        lane(page, name).getByRole("region", { name: new RegExp(`^${status} —`) }),
      ).toBeVisible();
    }
  }

  // Finished work is the pile that only grows: not rendered, not fetched, until opened.
  await expect(column(page, "Done")).toHaveCount(0);
  await lane(page, "Closed")
    .getByRole("button", { name: /^Show closed/ })
    .click();
  await expect(column(page, "Done")).toBeVisible();
  await expect(column(page, "Deferred")).toBeVisible();
  await expect(column(page, "Done").getByRole("listitem").first()).toBeVisible();
});

/**
 * Tall enough that the Waiting lane is on screen without scrolling: a drag
 * whose target is below the fold would be testing dnd-kit's auto-scroll, not
 * the board.
 */
test.describe("dragging", () => {
  test.use({ viewport: { width: 1280, height: 1200 } });

  test("dropping on Blocked asks why: cancelling puts the card back, confirming moves it", async ({
    page,
    request,
  }) => {
    const task = await createTask(request);
    const reason = "Needs the staging database restored first.";

    await page.goto(`/tasks/board?q=${encodeURIComponent(task.title)}`);

    await expect(cardIn(page, "Backlog", task.reference)).toBeVisible();
    await expect(column(page, "Backlog")).toHaveAccessibleName("Backlog — 1 task");

    /* ----------------------- Drop, then cancel ----------------------- */

    await dragTo(page, cardIn(page, "Backlog", task.reference), column(page, "Blocked"));

    const dialog = page.getByRole("dialog", { name: `Move ${task.reference} to Blocked` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    // Back where it started, and nothing was written.
    await expect(cardIn(page, "Backlog", task.reference)).toBeVisible();
    await expect(column(page, "Blocked").getByRole("listitem")).toHaveCount(0);
    expect((await getTask(request, task.id)).status).toBe("backlog");

    /* ----------------------- Drop, then confirm ---------------------- */

    await dragTo(page, cardIn(page, "Backlog", task.reference), column(page, "Blocked"));

    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Why is it blocked?").fill(reason);
    await dialog.getByRole("button", { name: "Move to Blocked" }).click();
    await expect(dialog).toBeHidden();

    await expect(cardIn(page, "Blocked", task.reference)).toBeVisible();
    await expect(column(page, "Backlog").getByRole("listitem")).toHaveCount(0);
    // The counts move with the card, not only the card.
    await expect(column(page, "Blocked")).toHaveAccessibleName("Blocked — 1 task");
    await expect(column(page, "Backlog")).toHaveAccessibleName("Backlog — 0 tasks");

    /*
      The reload is what separates a persisted move from an optimistic one: the
      board holds an in-flight move in local state on purpose, so without it the
      assertions above would pass just as well against a transition that 500'd.
    */
    await page.reload();
    await expect(cardIn(page, "Blocked", task.reference)).toBeVisible();

    const stored = await getTask(request, task.id);
    expect(stored).toMatchObject({ status: "blocked", statusNote: reason });
  });
});

test("moves a card with its status select — the keyboard path", async ({ page, request }) => {
  const task = await createTask(request);

  await page.goto(`/tasks/board?q=${encodeURIComponent(task.title)}`);
  await expect(cardIn(page, "Backlog", task.reference)).toBeVisible();

  // The task has acceptance criteria, so To do needs nothing more: no dialog.
  await pickOption(
    page,
    page.getByRole("combobox", { name: `Move task ${task.reference} to another status` }),
    "To do",
  );

  await expect(cardIn(page, "To do", task.reference)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.reload();
  await expect(cardIn(page, "To do", task.reference)).toBeVisible();
  expect((await getTask(request, task.id)).status).toBe("todo");
});

/**
 * Each lane is a sideways-scrolling row below `lg` — ten columns do not fit a
 * phone. What must not scroll sideways is the **document**: the columns scroll
 * inside their lane, exactly as the design guidelines require of any wide
 * content.
 */
test.describe("at 360px", () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test("scrolls each lane's columns inside the lane, not the page", async ({ page }) => {
    await page.goto("/tasks/board");

    await expect(column(page, "Backlog")).toBeVisible();

    const documentOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(documentOverflow).toBeLessThanOrEqual(1);

    // The lane, on the other hand, has more than fits — which is what makes its
    // third column reachable.
    const scroller = lane(page, "Plan").locator("div.overflow-x-auto");
    const canScroll = await scroller.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
    expect(canScroll).toBe(true);
  });
});

/**
 * The board grows with its content, so the document ends where the board ends.
 * The assertion is on the gap between the last lane and the footer rather than
 * on any height, because that gap is the thing a user would see.
 */
test("leaves no dead space under the board after switching from the list", async ({ page }) => {
  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "Tasks", level: 1 })).toBeVisible();

  await page
    .getByRole("navigation", { name: "Task view" })
    .getByRole("link", { name: "Board" })
    .click();
  await expect(column(page, "Backlog").getByRole("listitem").first()).toBeVisible();

  const gap = await page.evaluate(() => {
    const sections = [...document.querySelectorAll("main section")];
    const boardBottom = Math.max(...sections.map((node) => node.getBoundingClientRect().bottom));
    const footerTop = document.querySelector("footer")!.getBoundingClientRect().top;
    return footerTop - boardBottom;
  });

  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThan(120);
});

/**
 * The status filter picks **columns** on this screen rather than filtering rows
 * inside them — the one place the board reads the shared URL state differently
 * from the list. A filter naming a closed status opens the Closed lane, because
 * selecting a column that stays hidden would look like it did nothing.
 */
test("shows only the filtered statuses as columns, and keeps filters across the view switch", async ({
  page,
}) => {
  await page.goto("/tasks/board?status=todo&status=done&priority=high");

  await expect(column(page, "To do")).toBeVisible();
  await expect(column(page, "Done")).toBeVisible();
  await expect(column(page, "Backlog")).toHaveCount(0);
  await expect(column(page, "Blocked")).toHaveCount(0);

  const views = page.getByRole("navigation", { name: "Task view" });
  await views.getByRole("link", { name: "List" }).click();

  await expect(page).toHaveURL(/\/tasks\?.*priority=high/);
  await expect(page.locator("table")).toBeVisible();

  await views.getByRole("link", { name: "Board" }).click();
  await expect(page).toHaveURL(/\/tasks\/board\?.*priority=high/);
});

/**
 * The view survives leaving the board — the regression the task-view store was
 * added for. Worth doing in a browser: the preference is held in
 * `localStorage`, and the point of persisting it is that it outlives a reload.
 */
test("returns to the board, not the list, after opening a task from it", async ({
  page,
  request,
}) => {
  const task = await createTask(request);

  await page.goto(`/tasks/board?q=${encodeURIComponent(task.title)}`);

  await page.getByRole("link", { name: task.reference }).first().click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`));

  await page.getByRole("link", { name: "Back to tasks" }).click();

  // The filter rides along as it always did; the *view* is what used to be lost.
  await expect(page).toHaveURL(/\/tasks\/board\?.*q=/);
  await expect(cardIn(page, "Backlog", task.reference)).toBeVisible();
});

test("still returns to the board after a reload, and to the list once the user switches back", async ({
  page,
  request,
}) => {
  const task = await createTask(request);

  await page.goto("/tasks/board");
  await expect(column(page, "Backlog")).toBeVisible();
  // A fresh load of the detail page: no history entry to walk back through and
  // no router state — only the stored preference can answer.
  await page.goto(`/tasks/${task.id}`);

  await expect(page.getByRole("link", { name: "Back to tasks" })).toHaveAttribute(
    "href",
    "/tasks/board",
  );

  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "Tasks", level: 1 })).toBeVisible();
  await page.goto(`/tasks/${task.id}`);

  await expect(page.getByRole("link", { name: "Back to tasks" })).toHaveAttribute("href", "/tasks");
});
