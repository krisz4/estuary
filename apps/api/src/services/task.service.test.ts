import {
  createTicketInputSchema,
  hasAtLeastOneField,
  TICKET_STATUSES,
  updateTicketInputSchema,
  type CreateTicketInput,
  type TicketStatus,
  type UpdateTicketInput,
} from "@helpdesk/contracts";
import { describe, expect, it } from "vitest";

import { ApiError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { makeComment, makeTicket } from "../test/factories.js";
import { ALLOWED_TRANSITIONS } from "./ticket-status.js";
import {
  createTicket,
  deleteTicket,
  getTicket,
  getTicketFacets,
  updateTicket,
} from "./ticket.service.js";

/**
 * Service tests against a real (temp) SQLite file. Required cases come from
 * `docs/engineering/TESTING.md` § Tickets and § Status lifecycle.
 *
 * Two conventions worth stating, because they are what make these tests able to
 * fail:
 *
 * 1. **Input is parsed through the contract schemas**, exactly as the route will
 *    do it. `assignee: ""` becoming `null` is a schema transform, and a test that
 *    handed the service a pre-cooked `null` would assert nothing about the path
 *    a client actually takes.
 * 2. **Rank columns are asserted by sorting, never by reading the column.**
 *    Reading `priorityRank` back passes even when a second write path bypasses
 *    `applyTicketRanks()` and writes it by hand; only an `orderBy` on the column
 *    proves the ordering the feature promises.
 */

/* ------------------------------------------------------------------ *
 * Input helpers — the real schemas, not hand-built objects
 * ------------------------------------------------------------------ */

const createInput = (overrides: Record<string, unknown> = {}): CreateTicketInput =>
  createTicketInputSchema.parse({
    title: "Laptop will not connect to the VPN",
    description: "Fails with error 809 since the Tuesday update. Rebooted and reinstalled already.",
    requesterName: "Dana Whitfield",
    requesterEmail: "Dana.Whitfield@Example.com",
    ...overrides,
  });

const updateInput = (input: Record<string, unknown>): UpdateTicketInput =>
  updateTicketInputSchema.parse(input);

/** Assert a thrown value is our `ApiError` with the expected code and status. */
const expectApiError = async (
  run: () => Promise<unknown>,
  code: string,
  status: number,
): Promise<ApiError> => {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }

  // `toBeInstanceOf(ApiError)` also rules out a raw Prisma error leaking
  // through — the difference between an explicit existence check and a `P2025`
  // that happens to be mapped downstream.
  expect(thrown).toBeInstanceOf(ApiError);
  const error = thrown as ApiError;
  expect(error.code).toBe(code);
  expect(error.status).toBe(status);
  return error;
};

/** Priorities in stored order under a `priorityRank` sort. */
const prioritiesByRank = async (direction: "asc" | "desc") =>
  (await prisma.ticket.findMany({ orderBy: { priorityRank: direction } })).map((t) => t.priority);

/** Statuses in stored order under a `statusRank` sort. */
const statusesByRank = async (direction: "asc" | "desc") =>
  (await prisma.ticket.findMany({ orderBy: { statusRank: direction } })).map((t) => t.status);

/* ------------------------------------------------------------------ *
 * Create
 * ------------------------------------------------------------------ */

describe("createTicket", () => {
  it("returns an integer id, its reference, and the open/medium defaults", async () => {
    const ticket = await createTicket(createInput());

    expect(Number.isInteger(ticket.id)).toBe(true);
    expect(ticket.id).toBeGreaterThan(0);
    expect(ticket.reference).toBe(`HD-${String(ticket.id).padStart(6, "0")}`);
    expect(ticket.status).toBe("open");
    expect(ticket.priority).toBe("medium");
    expect(ticket.resolvedAt).toBeNull();
    expect(ticket.closedAt).toBeNull();
    expect(ticket.comments).toEqual([]);
    expect(ticket.commentCount).toBe(0);
  });

  it("stores the requester email lowercased so exact-match filtering can find it", async () => {
    const ticket = await createTicket(createInput());

    // SQLite `equals` is case-sensitive and the connector has no
    // `mode: "insensitive"`, so the canonical value is the only filterable one.
    expect(ticket.requesterEmail).toBe("dana.whitfield@example.com");
  });

  it("stores an empty assignee and category as null, never as an empty string", async () => {
    const ticket = await createTicket(createInput({ assignee: "", category: "" }));

    expect(ticket.assignee).toBeNull();
    expect(ticket.category).toBeNull();

    // Read the row, not the response: an empty string here would make the ticket
    // match neither `assigneeIsNull=true` nor any name filter.
    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(row.assignee).toBeNull();
    expect(row.category).toBeNull();
  });

  it("rejects a client-supplied id or createdAt at the contract boundary", async () => {
    // `.strict()` is what keeps these out of the service's input type at all —
    // the service has no branch for them because it can never receive them.
    expect(createTicketInputSchema.safeParse({ ...createInput(), id: 7 }).success).toBe(false);
    expect(
      createTicketInputSchema.safeParse({ ...createInput(), createdAt: "2026-01-01T00:00:00.000Z" })
        .success,
    ).toBe(false);
  });

  it("sorts by severity rather than alphabetically after creating through the service", async () => {
    await createTicket(createInput({ priority: "high" }));
    await createTicket(createInput({ priority: "low" }));
    await createTicket(createInput({ priority: "urgent" }));
    await createTicket(createInput({ priority: "medium" }));

    // Asserted by sorting: reading priorityRank back would pass even if some
    // other write path had set it by hand.
    expect(await prioritiesByRank("desc")).toEqual(["urgent", "high", "medium", "low"]);
  });

  it("writes a status rank that sorts a new ticket ahead of resolved work", async () => {
    await makeTicket({ status: "closed" });
    await makeTicket({ status: "resolved" });
    await createTicket(createInput());

    expect(await statusesByRank("asc")).toEqual(["open", "resolved", "closed"]);
  });
});

/* ------------------------------------------------------------------ *
 * Read
 * ------------------------------------------------------------------ */

describe("getTicket", () => {
  it("returns the ticket with its comments oldest-first", async () => {
    const ticket = await makeTicket();
    await makeComment({ ticketId: ticket.id, body: "second", createdAt: new Date(2026, 0, 2) });
    await makeComment({ ticketId: ticket.id, body: "first", createdAt: new Date(2026, 0, 1) });

    const loaded = await getTicket(ticket.id);

    expect(loaded.comments.map((c) => c.body)).toEqual(["first", "second"]);
    expect(loaded.commentCount).toBe(2);
  });

  it("orders comments created in the same millisecond by insertion order", async () => {
    const ticket = await makeTicket();
    const sameInstant = new Date("2026-08-11T10:00:00.000Z");
    await makeComment({ ticketId: ticket.id, body: "a", createdAt: sameInstant });
    await makeComment({ ticketId: ticket.id, body: "b", createdAt: sameInstant });
    await makeComment({ ticketId: ticket.id, body: "c", createdAt: sameInstant });

    const loaded = await getTicket(ticket.id);

    // Without the `id` tiebreaker this order is arbitrary and differs per read.
    expect(loaded.comments.map((c) => c.body)).toEqual(["a", "b", "c"]);
  });

  it("serializes dates as ISO strings and omits the rank columns", async () => {
    const ticket = await makeTicket();
    const loaded = await getTicket(ticket.id);

    expect(loaded.createdAt).toBe(ticket.createdAt.toISOString());
    expect(loaded).not.toHaveProperty("statusRank");
    expect(loaded).not.toHaveProperty("priorityRank");
  });

  it("throws TICKET_NOT_FOUND for an id that does not exist", async () => {
    await expectApiError(() => getTicket(999), "TICKET_NOT_FOUND", 404);
  });
});

/* ------------------------------------------------------------------ *
 * Update — field semantics
 * ------------------------------------------------------------------ */

describe("updateTicket", () => {
  it("leaves untouched fields alone on a partial update", async () => {
    const created = await createTicket(
      createInput({ assignee: "Marcus Feld", category: "access" }),
    );

    const updated = await updateTicket(created.id, updateInput({ title: "VPN still failing" }));

    expect(updated.title).toBe("VPN still failing");
    expect(updated.description).toBe(created.description);
    expect(updated.assignee).toBe("Marcus Feld");
    expect(updated.category).toBe("access");
    expect(updated.requesterEmail).toBe(created.requesterEmail);
    expect(updated.status).toBe("open");
  });

  it("clears the assignee to null when it is patched to an empty string", async () => {
    const created = await createTicket(createInput({ assignee: "Marcus Feld" }));

    const updated = await updateTicket(created.id, updateInput({ assignee: "" }));

    expect(updated.assignee).toBeNull();

    // The regression this guards: stored as "", the ticket would appear under
    // neither `assigneeIsNull=true` nor `assignee=<any name>`.
    const unassigned = await prisma.ticket.findMany({ where: { assignee: null } });
    expect(unassigned.map((t) => t.id)).toEqual([created.id]);
  });

  it("keeps the priority rank in step with the priority it patched", async () => {
    const a = await createTicket(createInput({ priority: "low" }));
    await createTicket(createInput({ priority: "high" }));

    await updateTicket(a.id, updateInput({ priority: "urgent" }));

    // By sorting: a bypassed `applyTicketRanks()` leaves the old rank and this
    // order comes back reversed.
    expect(await prioritiesByRank("desc")).toEqual(["urgent", "high"]);
  });

  it("throws TICKET_NOT_FOUND for an unknown id instead of surfacing a Prisma error", async () => {
    // Existence is checked before the write; the assertion that the thrown value
    // is an `ApiError` is what distinguishes that from relying on `P2025`.
    await expectApiError(
      () => updateTicket(4242, updateInput({ title: "Does not matter" })),
      "TICKET_NOT_FOUND",
      404,
    );
  });

  it("performs no write for an empty patch body", async () => {
    // `{}` is valid to the schema on purpose; the route turns it into
    // AT_LEAST_ONE_FIELD (422), which is its own code with no field details.
    expect(hasAtLeastOneField(updateInput({}))).toBe(false);

    const past = new Date("2020-01-01T00:00:00.000Z");
    const ticket = await makeTicket({ updatedAt: past });

    const result = await updateTicket(ticket.id, updateInput({}));

    expect(result.updatedAt).toBe(past.toISOString());
  });
});

/* ------------------------------------------------------------------ *
 * Update — status lifecycle
 * ------------------------------------------------------------------ */

describe("status lifecycle", () => {
  const legalPairs = TICKET_STATUSES.flatMap((from) =>
    ALLOWED_TRANSITIONS[from].map((to) => [from, to] as const),
  );

  it.each(legalPairs)("moves a ticket from %s to %s", async (from, to) => {
    const ticket = await makeTicket({ status: from });

    const updated = await updateTicket(ticket.id, updateInput({ status: to }));

    expect(updated.status).toBe(to);
  });

  it("rejects closed → resolved with a 409 carrying from, to, and allowed", async () => {
    const ticket = await makeTicket({ status: "closed" });

    const error = await expectApiError(
      () => updateTicket(ticket.id, updateInput({ status: "resolved" })),
      "INVALID_STATUS_TRANSITION",
      409,
    );

    expect(error.details).toEqual({
      from: "closed",
      to: "resolved",
      allowed: ["open", "in_progress"],
    });
  });

  it("leaves the row untouched when a transition is rejected", async () => {
    const past = new Date("2020-01-01T00:00:00.000Z");
    const ticket = await makeTicket({ status: "closed", updatedAt: past });

    await expect(updateTicket(ticket.id, updateInput({ status: "resolved" }))).rejects.toThrow();

    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(row.status).toBe("closed");
    expect(row.updatedAt.toISOString()).toBe(past.toISOString());
  });

  it("does not write when the status patched is the status it already has", async () => {
    const past = new Date("2020-01-01T00:00:00.000Z");
    const ticket = await makeTicket({ status: "in_progress", updatedAt: past });

    const updated = await updateTicket(ticket.id, updateInput({ status: "in_progress" }));

    // `updatedAt` is `@updatedAt`: a write of identical values still moves it and
    // floats the ticket to the top of an `updatedAt` sort with nothing changed.
    // Unchanged is the only assertion that distinguishes "no write" from
    // "wrote the same thing".
    expect(updated.status).toBe("in_progress");
    expect(updated.updatedAt).toBe(past.toISOString());

    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(row.updatedAt.toISOString()).toBe(past.toISOString());
  });

  it("moves updatedAt when a field genuinely changes", async () => {
    // The control for the test above: without it, a broken `updatedAt` (or a
    // fixture Prisma ignored) would make the no-op assertion pass vacuously.
    const past = new Date("2020-01-01T00:00:00.000Z");
    const ticket = await makeTicket({ status: "in_progress", updatedAt: past });

    const updated = await updateTicket(ticket.id, updateInput({ title: "A different title" }));

    expect(updated.updatedAt).not.toBe(past.toISOString());
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(past.getTime());
  });

  it("still writes when a patch carries an unchanged status alongside a changed field", async () => {
    const past = new Date("2020-01-01T00:00:00.000Z");
    const ticket = await makeTicket({ status: "open", updatedAt: past });

    const updated = await updateTicket(
      ticket.id,
      updateInput({ status: "open", priority: "urgent" }),
    );

    expect(updated.priority).toBe("urgent");
    expect(updated.updatedAt).not.toBe(past.toISOString());
  });

  it("stamps resolvedAt when a ticket is resolved", async () => {
    const ticket = await makeTicket({ status: "in_progress" });

    const updated = await updateTicket(ticket.id, updateInput({ status: "resolved" }));

    expect(updated.resolvedAt).not.toBeNull();
    expect(updated.closedAt).toBeNull();
  });

  it("stamps closedAt and backfills resolvedAt when a ticket is closed from open", async () => {
    const ticket = await makeTicket({ status: "open" });

    const updated = await updateTicket(ticket.id, updateInput({ status: "closed" }));

    expect(updated.closedAt).not.toBeNull();
    // "closed implies resolved" stays true for any consumer.
    expect(updated.resolvedAt).not.toBeNull();
  });

  it("keeps the original resolvedAt when closing a resolved ticket", async () => {
    const resolvedAt = new Date("2026-08-01T09:00:00.000Z");
    const ticket = await makeTicket({ status: "resolved", resolvedAt });

    const updated = await updateTicket(ticket.id, updateInput({ status: "closed" }));

    expect(updated.resolvedAt).toBe(resolvedAt.toISOString());
    expect(updated.closedAt).not.toBeNull();
  });

  it("clears resolvedAt when a resolved ticket goes back to in_progress", async () => {
    // The reopen case that gets missed: `resolved` is not terminal, so a rule
    // phrased "from a terminal state" would strand this resolvedAt.
    const ticket = await makeTicket({ status: "resolved" });
    expect(ticket.resolvedAt).not.toBeNull();

    const updated = await updateTicket(ticket.id, updateInput({ status: "in_progress" }));

    expect(updated.resolvedAt).toBeNull();
    expect(updated.closedAt).toBeNull();
  });

  it("clears resolvedAt when a resolved ticket is reopened to open", async () => {
    const ticket = await makeTicket({ status: "resolved" });

    const updated = await updateTicket(ticket.id, updateInput({ status: "open" }));

    expect(updated.resolvedAt).toBeNull();
    expect(updated.closedAt).toBeNull();
  });

  it("clears both timestamps when a closed ticket is reopened", async () => {
    const ticket = await makeTicket({ status: "closed" });
    expect(ticket.resolvedAt).not.toBeNull();
    expect(ticket.closedAt).not.toBeNull();

    const updated = await updateTicket(ticket.id, updateInput({ status: "open" }));

    expect(updated.resolvedAt).toBeNull();
    expect(updated.closedAt).toBeNull();
  });

  it("keeps the status rank in lifecycle order after a status change", async () => {
    // Statuses are assigned so that lifecycle order and insertion (id) order
    // disagree. With ids ascending they would come back closed → in_progress →
    // resolved, so a status written without its rank — leaving every rank at the
    // `open` value and the sort falling back to id order — fails here rather
    // than coincidentally matching.
    const a = await makeTicket({ status: "open" });
    const b = await makeTicket({ status: "open" });
    const c = await makeTicket({ status: "open" });

    await updateTicket(a.id, updateInput({ status: "closed" }));
    await updateTicket(b.id, updateInput({ status: "in_progress" }));
    await updateTicket(c.id, updateInput({ status: "resolved" }));

    // Asserted by sorting: a status written without its rank leaves this order
    // matching the old statuses instead of the new ones.
    expect(await statusesByRank("asc")).toEqual(["in_progress", "resolved", "closed"]);
  });

  it("keeps ranks consistent across a reopen, which writes status and timestamps together", async () => {
    const closed = await makeTicket({ status: "closed" });
    await makeTicket({ status: "in_progress" });

    await updateTicket(closed.id, updateInput({ status: "open" }));

    expect(await statusesByRank("asc")).toEqual(["open", "in_progress"]);
  });

  it("rejects a status outside the enum at the contract boundary", async () => {
    expect(updateTicketInputSchema.safeParse({ status: "archived" }).success).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Delete
 * ------------------------------------------------------------------ */

describe("deleteTicket", () => {
  it("removes the ticket and its comments", async () => {
    const ticket = await makeTicket();
    await makeComment({ ticketId: ticket.id });
    await makeComment({ ticketId: ticket.id });

    await deleteTicket(ticket.id);

    await expectApiError(() => getTicket(ticket.id), "TICKET_NOT_FOUND", 404);
    // Cascade is a database-level FK rule, not application code — so this also
    // proves the migration carries `onDelete: Cascade`.
    expect(await prisma.comment.count()).toBe(0);
  });

  it("leaves other tickets and their comments alone", async () => {
    const doomed = await makeTicket();
    const survivor = await makeTicket();
    await makeComment({ ticketId: survivor.id });

    await deleteTicket(doomed.id);

    expect(await prisma.ticket.count()).toBe(1);
    expect(await prisma.comment.count()).toBe(1);
  });

  it("throws TICKET_NOT_FOUND on a second delete rather than a Prisma error", async () => {
    const ticket = await makeTicket();
    await deleteTicket(ticket.id);

    await expectApiError(() => deleteTicket(ticket.id), "TICKET_NOT_FOUND", 404);
  });

  it("throws TICKET_NOT_FOUND for an id that never existed", async () => {
    await expectApiError(() => deleteTicket(4242), "TICKET_NOT_FOUND", 404);
  });
});

/* ------------------------------------------------------------------ *
 * Facets
 * ------------------------------------------------------------------ */

describe("getTicketFacets", () => {
  it("returns distinct non-null assignees and categories, sorted", async () => {
    await makeTicket({ assignee: "Priya Raman", category: "network" });
    await makeTicket({ assignee: "Marcus Feld", category: "access" });
    await makeTicket({ assignee: "Marcus Feld", category: "network" });

    const facets = await getTicketFacets();

    expect(facets.assignees).toEqual(["Marcus Feld", "Priya Raman"]);
    expect(facets.categories).toEqual(["access", "network"]);
  });

  it("omits null assignees and categories rather than returning a placeholder", async () => {
    await makeTicket({ assignee: null, category: null });
    await makeTicket({ assignee: "Marcus Feld", category: "hardware" });

    const facets = await getTicketFacets();

    expect(facets.assignees).toEqual(["Marcus Feld"]);
    expect(facets.categories).toEqual(["hardware"]);
  });

  it("offers only categories that are actually present, not the whole enum", async () => {
    await makeTicket({ category: "email" });

    const facets = await getTicketFacets();

    // The filter must not offer a value that would return zero rows.
    expect(facets.categories).toEqual(["email"]);
  });

  it("returns empty lists when there are no tickets", async () => {
    expect(await getTicketFacets()).toEqual({ assignees: [], categories: [] });
  });

  it("reflects a value cleared by a patch", async () => {
    const created = await createTicket(createInput({ assignee: "Marcus Feld" }));
    await updateTicket(created.id, updateInput({ assignee: "" }));

    expect((await getTicketFacets()).assignees).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * A row whose status is outside the enum
 * ------------------------------------------------------------------ */

describe("a stored status outside the enum", () => {
  /**
   * `status` is a plain `String` column — the enum lives in zod, not in SQLite
   * (`docs/engineering/DATABASE.md`). Every API write path goes through the
   * schemas, but direct SQL, a `db push` experiment, or a bad migration can
   * still land a value the code has never heard of. That must degrade to the
   * documented 409, not to an unhandled `TypeError` reported as `INTERNAL_ERROR`.
   */
  it("patches to a 409, not a 500", async () => {
    const ticket = await makeTicket({ status: "open" });
    await prisma.$executeRaw`UPDATE Ticket SET status = 'archived' WHERE id = ${ticket.id}`;

    const error = await updateTicket(ticket.id, updateInput({ status: "open" })).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("INVALID_STATUS_TRANSITION");
    expect((error as ApiError).status).toBe(409);

    // And the row is left exactly as it was found.
    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.status).toBe("archived");
  });
});

/* ------------------------------------------------------------------ *
 * Cross-cutting: the rank invariant, over every write path in this stage
 * ------------------------------------------------------------------ */

describe("rank consistency across every stage-6 write path", () => {
  it("sorts correctly after a create, a priority patch, and a status patch", async () => {
    const created = await createTicket(createInput({ priority: "low" }));
    const patched = await createTicket(createInput({ priority: "medium" }));
    await updateTicket(patched.id, updateInput({ priority: "urgent" }));
    const reopened = await makeTicket({ status: "closed", priority: "high" });
    await updateTicket(reopened.id, updateInput({ status: "in_progress" }));

    expect(await prioritiesByRank("desc")).toEqual(["urgent", "high", "low"]);

    const byStatus = await prisma.ticket.findMany({ orderBy: { statusRank: "asc" } });
    expect(byStatus.map((t) => t.status as TicketStatus)).toEqual(["open", "open", "in_progress"]);
    expect(byStatus.map((t) => t.id)).toContain(created.id);
  });
});
