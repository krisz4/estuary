import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { type CreateTicketInput, type Ticket } from "@helpdesk/contracts";

import { API_BASE_URL } from "./env";

/**
 * Shared spec helpers.
 *
 * The rule these exist to serve is in `docs/engineering/TESTING.md`: **every
 * spec that mutates creates its own ticket and acts on that one.** No spec edits
 * or deletes a seeded row, because the suite shares one database and the first
 * spec to delete `HD-000007` makes every later run's failure depend on which
 * order the files happened to run in.
 *
 * Fixtures are built over the **API**, not through the create form. Spec 1 is
 * the one that proves the form works; specs 3 and 4 are about commenting,
 * status, and deletion, and driving six form fields to get there would make them
 * fail for a reason they are not testing.
 *
 * The imports from `@helpdesk/contracts` are **types only**, on purpose: a value
 * import would make `pnpm test:e2e` depend on the package having been built,
 * and the E2E script deliberately does not run through turbo's build graph.
 */

/**
 * Priority badge labels in rank order — the *rendered* spelling, not the wire
 * value, because this is read back off the page.
 *
 * Written as a literal rather than derived from `TICKET_PRIORITIES` and the web
 * app's label map: spec 2 asserts that `sort=priority:desc` puts urgent first,
 * and deriving the expected order from the same tables the page renders from
 * would let both sides degrade together (see the note on shared helpers in
 * `docs/engineering/BUILD_LOG.md`).
 */
export const PRIORITY_LABEL_RANK: Record<string, number> = {
  Low: 0,
  Medium: 1,
  High: 2,
  Urgent: 3,
};

/**
 * A title no other spec, run, or seeded row can collide with.
 *
 * Collisions matter more than they look: several specs find their own ticket by
 * searching for it, and `?q=` matches substrings of both title and description.
 */
export const uniqueTitle = (label: string): string =>
  `E2E ${label} ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const ticketPayload = (overrides: Partial<CreateTicketInput> = {}): CreateTicketInput =>
  ({
    title: uniqueTitle("fixture"),
    description: "Created by the end-to-end suite. Safe to delete.",
    priority: "medium",
    requesterName: "Dana Whitfield",
    requesterEmail: "dana.whitfield@example.com",
    ...overrides,
  }) as CreateTicketInput;

/**
 * POST a ticket straight to the API and return it.
 *
 * The status assertion is here rather than in the caller so a fixture that fails
 * to be created reports *that*, instead of surfacing three lines later as a
 * detail page rendering its not-found state.
 */
export const createTicket = async (
  request: APIRequestContext,
  overrides: Partial<CreateTicketInput> = {},
): Promise<Ticket> => {
  const response = await request.post(`${API_BASE_URL}/tickets`, {
    data: ticketPayload(overrides),
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as Ticket;
};

/** `GET /tickets/:id` without going through the UI — used to assert a delete stuck. */
export const getTicketStatus = async (
  request: APIRequestContext,
  ticketId: number,
): Promise<number> => (await request.get(`${API_BASE_URL}/tickets/${ticketId}`)).status();

/**
 * The list page's rows, as one locator regardless of which layout is rendered.
 *
 * Above `md` the list is a `<table>`; below it, a `<ul>` of card links — two
 * different components, not one component with a media query, so a spec that
 * wants "the rows" has to say which. Everything except spec 5 runs at the
 * desktop viewport and uses `tableRows`.
 */
export const tableRows = (page: Page) => page.locator("table tbody tr");

/**
 * The trimmed text of one column across every row on the current page, in order.
 *
 * Read through `expect.poll` at the call sites rather than once, because the
 * list **keeps the previous page's rows on screen while the next one loads**
 * (`keepPreviousData`, dimmed and `aria-busy`, per the design guidelines). A
 * single read straight after a click is therefore a genuine race with the
 * refetch — and one that resolves the wrong way often enough to have failed the
 * first run of this suite.
 */
export const columnTexts = async (page: Page, nth: number): Promise<string[]> =>
  (await tableRows(page).locator(`td:nth-child(${nth})`).allInnerTexts()).map((text) =>
    text.trim(),
  );

/** The `HD-000042` reference cell of every row on the current page, in order. */
export const rowReferences = (page: Page): Promise<string[]> => columnTexts(page, 1);
