import { expect, test, type Locator, type Page } from "@playwright/test";

import { createTicket, getTicketStatus } from "./helpers";

/**
 * Spec 6 — the board, and the one assertion no component test can make: that a
 * real mouse drag moves a ticket.
 *
 * `@dnd-kit` is driven entirely by pointer geometry. Its `MouseSensor` waits for
 * 6px of movement before a press becomes a drag, and its collision detection
 * asks every droppable for a bounding rect — in jsdom every rect is 0×0, so a
 * simulated drag there proves the test's own arithmetic and nothing about the
 * app. The component suite therefore drives the *other* entry point into the
 * same `move()` (the card's status select), and this spec drives the pointer.
 *
 * It creates its own ticket, like every other mutating spec, and finds it with
 * `?q=` so the board shows one card per column and the drag has an unambiguous
 * target.
 */

/** The `<section>` for one column — labelled with its status and live count. */
const column = (page: Page, status: string): Locator =>
  page.getByRole("region", { name: new RegExp(`^${status} —`) });

/**
 * A press-move-release drag, in steps.
 *
 * `steps` is not decoration: a single jump from source to target is one
 * `mousemove`, and the sensor needs a move *after* activation to know where the
 * pointer went — one event does both at once and the drop lands wherever the
 * library last believed the cursor was. Ten intermediate moves is what a real
 * hand produces and what the collision detection is written against.
 */
const dragTo = async (page: Page, card: Locator, target: Locator): Promise<void> => {
  const from = await card.boundingBox();
  const to = await target.boundingBox();
  expect(from, "the card has no layout").not.toBeNull();
  expect(to, "the target column has no layout").not.toBeNull();

  await page.mouse.move(from!.x + from!.width / 2, from!.y + 12);
  await page.mouse.down();
  // Past the 6px activation threshold first, so the sensor is dragging before
  // the pointer is over the target.
  await page.mouse.move(from!.x + from!.width / 2, from!.y + 32, { steps: 5 });
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 10 });
  await page.mouse.up();
};

test("drags a ticket from Open to In progress, and the move persists", async ({
  page,
  request,
}) => {
  const ticket = await createTicket(request);

  await page.goto(`/tickets/board?q=${encodeURIComponent(ticket.title)}`);

  const openColumn = column(page, "Open");
  const inProgressColumn = column(page, "In progress");

  const card = openColumn.getByRole("listitem").filter({ hasText: ticket.reference });
  await expect(card).toBeVisible();
  await expect(openColumn).toHaveAccessibleName("Open — 1 ticket");

  await dragTo(page, card, inProgressColumn);

  await expect(
    inProgressColumn.getByRole("listitem").filter({ hasText: ticket.reference }),
  ).toBeVisible();
  await expect(openColumn.getByRole("listitem")).toHaveCount(0);

  // The counts move with the card, not only the card.
  await expect(inProgressColumn).toHaveAccessibleName("In progress — 1 ticket");
  await expect(openColumn).toHaveAccessibleName("Open — 0 tickets");

  /*
    The reload is what separates a persisted move from an optimistic one. The
    board holds an in-flight move in local state on purpose, so without this the
    assertions above would pass just as well against a PATCH that 500'd.
  */
  await page.reload();
  await expect(
    column(page, "In progress").getByRole("listitem").filter({ hasText: ticket.reference }),
  ).toBeVisible();

  expect(await getTicketStatus(request, ticket.id)).toBe(200);
});

test("moves a ticket with the keyboard, through the card's status select", async ({
  page,
  request,
}) => {
  const ticket = await createTicket(request);

  await page.goto(`/tickets/board?q=${encodeURIComponent(ticket.title)}`);

  const card = column(page, "Open").getByRole("listitem").filter({ hasText: ticket.reference });
  await expect(card).toBeVisible();

  // The accessible path is a real select, not a floating card moved by arrow
  // keys — see the note in `BoardCard.tsx`.
  await page
    .getByRole("combobox", { name: `Move ticket ${ticket.reference} to another status` })
    .click();
  await page.getByRole("option", { name: "Resolved" }).click();

  await expect(
    column(page, "Resolved").getByRole("listitem").filter({ hasText: ticket.reference }),
  ).toBeVisible();

  await page.reload();
  await expect(
    column(page, "Resolved").getByRole("listitem").filter({ hasText: ticket.reference }),
  ).toBeVisible();
});

/**
 * The board is the one screen in the app that scrolls sideways *on purpose* — a
 * kanban column is a queue, and four of them do not fit on a phone. What must
 * not scroll sideways is the **document**: the columns scroll inside their own
 * container, exactly as the design guidelines require of any wide content.
 */
test.describe("at 375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("scrolls the columns inside their own container, not the page", async ({ page }) => {
    await page.goto("/tickets/board");

    await expect(column(page, "Open")).toBeVisible();

    const documentOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(documentOverflow).toBeLessThanOrEqual(1);

    // The board itself, on the other hand, has more content than fits — which is
    // what makes the fourth column reachable.
    const scroller = page.locator("div.overflow-x-auto").first();
    const canScroll = await scroller.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
    expect(canScroll).toBe(true);
  });
});

/**
 * The status filter picks **columns** on this screen rather than filtering rows
 * inside them, which is the one place the board reads the shared URL state
 * differently from the list. Worth an end-to-end check because it is the kind of
 * decision a later refactor "corrects" by accident.
 */
test("shows only the filtered statuses as columns, and keeps filters across the view switch", async ({
  page,
}) => {
  await page.goto("/tickets/board?status=open&status=closed&priority=high");

  await expect(column(page, "Open")).toBeVisible();
  await expect(column(page, "Closed")).toBeVisible();
  await expect(page.getByRole("region", { name: /^Resolved —/ })).toHaveCount(0);

  await page.getByRole("link", { name: "List" }).click();

  await expect(page).toHaveURL(/\/tickets\?.*priority=high/);
  await expect(page.locator("table")).toBeVisible();

  await page.getByRole("link", { name: "Board" }).click();
  await expect(page).toHaveURL(/\/tickets\/board\?.*priority=high/);
});
