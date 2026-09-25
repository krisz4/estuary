import { expect, test } from "@playwright/test";

import { createTicket, getTicketStatus, tableRows, uniqueTitle } from "./helpers";

/**
 * Spec 4 — create a ticket, delete it behind the confirm dialog, and confirm it
 * is gone from the list.
 *
 * The ticket is this spec's own, and that is not a formality here: a delete is a
 * hard delete that cascades to comments, so a spec that removed a seeded row
 * would change what every later spec — and every later *run* — sees.
 *
 * The route through the list is deliberate. Reaching the detail page by
 * `page.goto` would leave the query cache with no list entry at all, and then
 * "the row is gone afterwards" would hold whether or not the mutation
 * invalidated anything — a passing assertion about nothing. Arriving from the
 * list is also what a user does.
 */
test("deletes a ticket after confirmation and removes it from the list", async ({
  page,
  request,
}) => {
  const ticket = await createTicket(request, { title: uniqueTitle("delete") });

  /*
    Page 1 of the default view is where this ticket is: it was created seconds
    ago and the default sort is `createdAt:desc`, so it is the newest row there
    is. Everything below depends on that, which is why it is asserted rather
    than assumed.
  */
  await page.goto("/tickets");
  const row = tableRows(page).filter({ hasText: ticket.reference });
  await expect(row).toHaveCount(1);

  await row.getByRole("link", { name: ticket.reference }).click();
  await expect(page).toHaveURL(new RegExp(`/tickets/${ticket.id}$`));

  await page.getByRole("button", { name: "Delete" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(`Delete ${ticket.reference}?`);
  // The confirmation names the consequence, which is the only thing making it a
  // gate rather than a speed bump.
  await expect(dialog).toContainText("This can't be undone.");

  await dialog.getByRole("button", { name: "Delete ticket" }).click();

  // Back on the list, with the dialog gone.
  await expect(page).toHaveURL(/\/tickets(\?|$)/);
  await expect(dialog).toBeHidden();

  /*
    Gone from the list the delete navigated back to, without a reload.

    Scoped to the table rather than the page: the success toast names the ticket
    too, and an unscoped `getByText(reference)` would spend four seconds waiting
    for sonner's timer and then report the toast's disappearance as the list
    having updated.

    This is the assertion that needs `useDeleteTicketMutation` to invalidate
    `tickets.lists()`. The browser is looking at the same query key it had
    cached on the way in, and `staleTime` is 30 s — long enough that a missing
    invalidation puts the deleted row back on screen rather than being papered
    over by a refetch that was going to happen anyway.
  */
  await expect(tableRows(page).filter({ hasText: ticket.reference })).toHaveCount(0);

  /*
    Searched for by reference — `q` matches `HD-000042` as well as free text.
    A *different* query key, so unlike the assertion above this one is about the
    server: the row is absent because the DELETE was committed, not because a
    cache entry was dropped.
  */
  await page.getByRole("searchbox", { name: "Search tickets" }).fill(ticket.reference);
  await expect(page).toHaveURL(new RegExp(`[?&]q=${ticket.reference}(&|$)`));
  await expect(page.getByText("No tickets match these filters")).toBeVisible();
  await expect(tableRows(page)).toHaveCount(0);

  // And gone from the API too, not merely absent from a cached list page.
  expect(await getTicketStatus(request, ticket.id)).toBe(404);

  // The detail URL now renders the not-found state instead of a stale ticket.
  await page.goto(`/tickets/${ticket.id}`);
  await expect(page.getByText("This ticket doesn't exist")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: ticket.title })).toBeHidden();
});
