import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  ticketListQuerySchema,
  type TicketPriority,
  type TicketStatus,
} from "@helpdesk/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../lib/prisma.js";
import { listTickets } from "../services/ticket-query.js";
import { PRIORITY_RANK, STATUS_RANK } from "../services/ticket-status.js";
import { PRNG_SEED, SEED_TICKET_COUNT, SEED_WINDOW_DAYS, TICKET_TEMPLATES } from "./seed-data.js";
import { buildSeedTickets, isSeedAllowed, seedDatabase } from "./index.js";

/**
 * The seed, tested. Not *used* — no other suite reads seeded data, and that stays
 * true (`docs/engineering/TESTING.md`). This file runs the seed against the
 * worker's temp database, which `beforeEach` truncates like any other.
 *
 * The assertion that matters most is the rank one, and it is asserted **by
 * sorting**. Reading `statusRank` back and comparing it to `STATUS_RANK[status]`
 * would pass just as happily if the seed wrote the column itself, which is
 * exactly the write path this stage was warned about.
 */

const NOW = new Date("2026-08-11T12:00:00.000Z");

/* ------------------------------------------------------------------ *
 * Generation — no database
 * ------------------------------------------------------------------ */

describe("buildSeedTickets", () => {
  const rows = buildSeedTickets(NOW);

  it(`generates ${SEED_TICKET_COUNT} tickets, one per template`, () => {
    expect(rows).toHaveLength(SEED_TICKET_COUNT);
    expect(TICKET_TEMPLATES).toHaveLength(SEED_TICKET_COUNT);
    expect(new Set(rows.map((row) => row.ticket.title)).size).toBe(SEED_TICKET_COUNT);
  });

  it("is reproducible — the same `now` produces byte-identical output", () => {
    expect(JSON.stringify(buildSeedTickets(NOW))).toEqual(JSON.stringify(buildSeedTickets(NOW)));
  });

  it("depends on the PRNG seed, so 'reproducible' is not 'constant'", () => {
    expect(JSON.stringify(buildSeedTickets(NOW, PRNG_SEED + 1))).not.toEqual(
      JSON.stringify(buildSeedTickets(NOW)),
    );
  });

  it("hands out ticket numbers in chronological order", () => {
    const times = rows.map((row) => row.ticket.createdAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it(`spreads createdAt across ${SEED_WINDOW_DAYS} days rather than clustering at now`, () => {
    const ages = rows.map((row) => (NOW.getTime() - row.ticket.createdAt.getTime()) / 86_400_000);

    expect(Math.min(...ages)).toBeGreaterThan(0);
    expect(Math.max(...ages)).toBeLessThanOrEqual(SEED_WINDOW_DAYS);
    // Every ticket created within a week of each other would still "spread".
    expect(Math.max(...ages) - Math.min(...ages)).toBeGreaterThan(SEED_WINDOW_DAYS * 0.7);
  });

  /**
   * The realised distribution, not the weight table. The weights are an input;
   * 63 draws from them is a small enough sample that an arbitrary PRNG seed
   * lands well off the documented shape — the first one tried produced 7
   * `in_progress` tickets against an expectation of 16. These bands are what make
   * `PRNG_SEED` a decision rather than a coincidence.
   */
  it("matches the status distribution in Seed_Data.md", () => {
    const counts = countBy(rows.map((row) => row.ticket.status));

    expect(counts.open).toBeGreaterThanOrEqual(22);
    expect(counts.open).toBeLessThanOrEqual(28);
    expect(counts.in_progress).toBeGreaterThanOrEqual(13);
    expect(counts.in_progress).toBeLessThanOrEqual(20);
    expect(counts.resolved).toBeGreaterThanOrEqual(10);
    expect(counts.resolved).toBeLessThanOrEqual(16);
    expect(counts.closed).toBeGreaterThanOrEqual(6);
    expect(counts.closed).toBeLessThanOrEqual(12);
  });

  it("weights priority toward medium and keeps urgent to a handful", () => {
    const counts = countBy(rows.map((row) => row.ticket.priority));

    expect(counts.medium).toBeGreaterThan(counts.low ?? 0);
    expect(counts.medium).toBeGreaterThan(counts.high ?? 0);
    expect(counts.urgent).toBeGreaterThanOrEqual(4);
    expect(counts.urgent).toBeLessThanOrEqual(10);
  });

  it("leaves about 30% unassigned so assigneeIsNull=true has results", () => {
    const unassigned = rows.filter((row) => row.ticket.assignee === null).length;

    expect(unassigned / rows.length).toBeGreaterThan(0.24);
    expect(unassigned / rows.length).toBeLessThan(0.36);
  });

  it("creates 0–6 comments per ticket, averaging about 3", () => {
    const counts = rows.map((row) => row.comments.length);
    const total = counts.reduce((sum, count) => sum + count, 0);

    expect(Math.min(...counts)).toBe(0);
    expect(Math.max(...counts)).toBeLessThanOrEqual(6);
    expect(total / rows.length).toBeGreaterThan(2.4);
    expect(total / rows.length).toBeLessThan(3.6);
  });

  /**
   * The reason `getTicket` orders comments by `[createdAt asc, id asc]`. Without
   * a collision in the data, dropping that `id` tiebreaker would break nothing
   * visible and the regression would ship — see `docs/features/Comments.md`.
   */
  it("puts several comments in the same millisecond on purpose", () => {
    const colliding = rows.filter((row) => {
      const times = row.comments.map((comment) => comment.createdAt.getTime());
      return new Set(times).size !== times.length;
    });

    expect(colliding.length).toBeGreaterThanOrEqual(5);
  });

  /**
   * Run across many datasets, not just the one that ships. A structural rule
   * that holds for `PRNG_SEED` by luck is not a rule.
   */
  it.each([1, 7, 99, 4242, PRNG_SEED])("holds its lifecycle invariants for seed %i", (seed) => {
    for (const { ticket, comments } of buildSeedTickets(NOW, seed)) {
      const active = ticket.status === "open" || ticket.status === "in_progress";

      if (active) {
        expect(ticket.resolvedAt).toBeNull();
        expect(ticket.closedAt).toBeNull();
      }
      if (ticket.status === "resolved") {
        expect(ticket.resolvedAt).not.toBeNull();
        expect(ticket.closedAt).toBeNull();
      }
      if (ticket.status === "closed") {
        // "closed implies resolved" — the same backfill `applyStatusSideEffects` does.
        expect(ticket.resolvedAt).not.toBeNull();
        expect(ticket.closedAt).not.toBeNull();
        expect(ticket.resolvedAt!.getTime()).toBeLessThanOrEqual(ticket.closedAt!.getTime());
      }

      expect(ticket.createdAt.getTime()).toBeLessThanOrEqual(ticket.updatedAt.getTime());
      expect(ticket.updatedAt.getTime()).toBeLessThanOrEqual(NOW.getTime());
      expect(ticket.requesterEmail).toBe(ticket.requesterEmail.toLowerCase());

      for (const comment of comments) {
        expect(comment.createdAt.getTime()).toBeGreaterThan(ticket.createdAt.getTime());
        expect(comment.createdAt.getTime()).toBeLessThanOrEqual(NOW.getTime());
      }
    }
  });
});

describe("isSeedAllowed", () => {
  it("permits seeding outside production without any flag", () => {
    expect(isSeedAllowed("development", false)).toBe(true);
    expect(isSeedAllowed("test", false)).toBe(true);
  });

  it("refuses production unless ALLOW_SEED says otherwise", () => {
    expect(isSeedAllowed("production", false)).toBe(false);
    expect(isSeedAllowed("production", true)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * The seed writes ranks through the helper
 * ------------------------------------------------------------------ */

describe("the seed never writes a rank column itself", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");

  /** Comments describe the rule; only code should be searched for violations. */
  const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "");

  it("routes its ticket writes through applyTicketRanks", () => {
    expect(code).toMatch(/applyTicketRanks\(/);
  });

  /**
   * The behavioural test below catches a seed that skips the helper and leaves
   * the column defaults. It does **not** catch a seed that computes the ranks
   * itself and happens to get them right — which reads as correct until someone
   * changes `TICKET_STATUSES` and only one of the two copies moves. This is that
   * second case.
   */
  it("mentions neither statusRank nor priorityRank outside a comment", () => {
    expect(code).not.toMatch(/\bstatusRank\b/);
    expect(code).not.toMatch(/\bpriorityRank\b/);
  });
});

/* ------------------------------------------------------------------ *
 * Against the database
 * ------------------------------------------------------------------ */

describe("seedDatabase", () => {
  beforeEach(async () => {
    await seedDatabase({ now: NOW });
  });

  it(`writes ${SEED_TICKET_COUNT} tickets and their comments`, async () => {
    expect(await prisma.ticket.count()).toBe(SEED_TICKET_COUNT);
    expect(await prisma.comment.count()).toBeGreaterThan(100);
  });

  it("leaves ids to autoincrement, starting at 1", async () => {
    const ids = (
      await prisma.ticket.findMany({ select: { id: true }, orderBy: { id: "asc" } })
    ).map((row) => row.id);

    expect(ids[0]).toBe(1);
    expect(ids.at(-1)).toBe(SEED_TICKET_COUNT);
  });

  it("is idempotent — re-seeding replaces rather than appends, and reuses the ids", async () => {
    const before = await prisma.ticket.findMany({ orderBy: { id: "asc" } });
    const commentsBefore = await prisma.comment.count();

    // `beforeEach` already ran one seed; this is the second against a full table.
    await seedDatabase({ now: NOW });

    const after = await prisma.ticket.findMany({ orderBy: { id: "asc" } });

    expect(after).toHaveLength(SEED_TICKET_COUNT);
    expect(await prisma.comment.count()).toBe(commentsBefore);
    // Ids restart at 1 rather than continuing from 64, so HD-000042 stays the
    // same ticket across runs — which is what makes the fixed PRNG seed useful.
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after.map((row) => row.title)).toEqual(before.map((row) => row.title));
  });

  /**
   * **The rank invariant, asserted by sorting.** Ordering by `statusRank` must
   * produce the same sequence as ordering by the contract enum's index — which
   * is only true if the column agrees with the string beside it.
   */
  it("orders by statusRank exactly as the lifecycle enum orders", async () => {
    const rows = await prisma.ticket.findMany({
      orderBy: [{ statusRank: "asc" }, { id: "asc" }],
      select: { id: true, status: true },
    });

    const expected = [...rows].sort(
      (a, b) =>
        STATUS_RANK[a.status as TicketStatus] - STATUS_RANK[b.status as TicketStatus] ||
        a.id - b.id,
    );

    expect(rows.map((row) => row.id)).toEqual(expected.map((row) => row.id));
    // …and the sequence is not accidentally sorted for some other reason.
    expect(new Set(rows.map((row) => row.status)).size).toBeGreaterThan(1);
  });

  it("orders by priorityRank exactly as the severity enum orders", async () => {
    const rows = await prisma.ticket.findMany({
      orderBy: [{ priorityRank: "desc" }, { id: "desc" }],
      select: { id: true, priority: true },
    });

    const expected = [...rows].sort(
      (a, b) =>
        PRIORITY_RANK[b.priority as TicketPriority] - PRIORITY_RANK[a.priority as TicketPriority] ||
        b.id - a.id,
    );

    expect(rows.map((row) => row.id)).toEqual(expected.map((row) => row.id));
    expect(rows[0]?.priority).toBe("urgent");
  });

  /**
   * The consequence a wrong rank actually has, since stage 7 pushed the rank
   * predicate into the status and priority filters: a rank-drifted row matches
   * **no** status filter, so it vanishes from every filtered list page and from
   * `meta.total` while still reading back perfectly over `GET /tickets/:id`.
   *
   * Summing the four filtered totals back to 63 is what proves no seeded ticket
   * is unreachable.
   */
  it("leaves every seeded ticket reachable through a status filter", async () => {
    const totals = await Promise.all(
      TICKET_STATUSES.map(async (status) => {
        const page = await listTickets(parseListQuery({ status: [status] }));
        return page.meta.total;
      }),
    );

    expect(totals.reduce((sum, total) => sum + total, 0)).toBe(SEED_TICKET_COUNT);
  });

  it("leaves every seeded ticket reachable through a priority filter", async () => {
    const totals = await Promise.all(
      TICKET_PRIORITIES.map(async (priority) => {
        const page = await listTickets(parseListQuery({ priority: [priority] }));
        return page.meta.total;
      }),
    );

    expect(totals.reduce((sum, total) => sum + total, 0)).toBe(SEED_TICKET_COUNT);
  });

  it("gives assigneeIsNull=true and the assignee facet something to return", async () => {
    const unassigned = await listTickets(parseListQuery({ assigneeIsNull: true }));
    const assignees = await prisma.ticket.groupBy({
      by: ["assignee"],
      where: { assignee: { not: null } },
    });

    expect(unassigned.meta.total).toBeGreaterThan(10);
    expect(assignees.length).toBeGreaterThanOrEqual(5);
  });

  it("pages: three full pages and a fourth at the default page size", async () => {
    const first = await listTickets(parseListQuery({}));

    expect(first.data).toHaveLength(20);
    expect(first.meta.total).toBe(SEED_TICKET_COUNT);
    expect(first.meta.totalPages).toBe(4);
    expect(first.meta.hasNextPage).toBe(true);
    expect(first.meta.hasPrevPage).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const countBy = <T extends string>(values: T[]): Record<T, number> =>
  values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {}) as Record<T, number>;

/**
 * The list service takes an already-validated query, so tests build one through
 * the real schema rather than casting a partial object into place — the same
 * reason the factories write through Prisma instead of through a service.
 */
function parseListQuery(input: Record<string, unknown>) {
  return ticketListQuerySchema.parse(input);
}
