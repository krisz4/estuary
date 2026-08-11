import { pathToFileURL } from "node:url";

import {
  TICKET_PRIORITIES,
  type TicketCategory,
  type TicketPriority,
  type TicketStatus,
} from "@helpdesk/contracts";

import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { applyTicketRanks } from "../services/ticket-status.js";
import {
  AGENT_COMMENTS,
  ASSIGNEES,
  COMMENT_COUNT_WEIGHTS,
  PRIORITY_WEIGHTS,
  PRNG_SEED,
  REQUESTERS,
  REQUESTER_COMMENTS,
  SEED_TICKET_COUNT,
  SEED_WINDOW_DAYS,
  STATUS_WEIGHTS,
  TICKET_TEMPLATES,
  UNASSIGNED_SHARE,
  type Weighted,
} from "./seed-data.js";

/**
 * `db:seed` — 63 realistic tickets and their comment threads.
 *
 * **It lives under `src/`, not under `prisma/`, and that is a build constraint
 * rather than a preference.** `tsconfig.build.json` has `rootDir: "src"`, and
 * `docs/operations/DOCKER.md` requires the seed to be *compiled* into the
 * runtime image — `tsx` is a devDependency and is not installed there. A file
 * outside `rootDir` cannot be added to the build at all, so the choice was
 * between moving it here and shipping a TypeScript runner into production.
 * `prisma/` keeps the schema and the migrations; the `prisma.seed` hook in
 * `package.json` names this file, which is all Prisma needs.
 *
 * Spec: `docs/features/Seed_Data.md`. The four rules that shape this file:
 *
 * 1. **Reproducible.** One fixed PRNG seed drives every draw, and no draw reads
 *    the clock. Two developers running `db:seed` get the same 63 tickets, which
 *    is what makes a screenshot in a bug report worth anything.
 * 2. **Idempotent.** The script deletes everything first, `sqlite_sequence`
 *    included, so re-seeding produces the same ids rather than appending a
 *    second set with different ticket numbers.
 * 3. **Guarded by `ALLOW_SEED`, not `NODE_ENV`.** The Docker image legitimately
 *    runs a production build *and* wants demo data.
 * 4. **Ranks are written through `applyTicketRanks()`** — see the block comment
 *    on `SeedTicketWrite` below, which is the mechanism rather than the promise.
 *
 * Tests never consume this data. They build their own fixtures against a temp
 * database (`docs/engineering/TESTING.md`); the tests in `src/seed/seed.test.ts`
 * are about the seed itself, which is a different thing.
 */

/* ------------------------------------------------------------------ *
 * Write shapes
 * ------------------------------------------------------------------ */

/**
 * **`statusRank` and `priorityRank` are deliberately absent from this type**,
 * exactly as they are absent from `TicketWriteData` in `services/ticket.service.ts`.
 *
 * The seed is the write path most likely to bypass `applyTicketRanks()`: it is
 * the one place that constructs a complete ticket row by hand, and Prisma would
 * happily accept `statusRank: 2` sitting next to `status: "resolved"`. Leaving
 * the fields off the type means the only way a rank reaches Prisma from here is
 * the helper adding it — enforced by the compiler, not by this comment.
 *
 * What it costs to get wrong is worse than a wrong sort order. Since stage 7 the
 * status and priority filters push the **rank** predicate as well as the text
 * one, so a row whose `statusRank` still holds the column default is matched by
 * no status filter at all: it disappears from every filtered list page and from
 * `meta.total`, while reading back perfectly over `GET /tickets/:id`.
 */
export interface SeedTicketWrite {
  title: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  category: TicketCategory | null;
  requesterName: string;
  requesterEmail: string;
  assignee: string | null;
  createdAt: Date;
  /**
   * Written explicitly even though the column is `@updatedAt`. Prisma stamps
   * `now()` on create unless a value is supplied, which would leave all 63
   * tickets sharing one `updatedAt` and make `?sort=updatedAt:desc` look broken.
   */
  updatedAt: Date;
  resolvedAt: Date | null;
  closedAt: Date | null;
}

export interface SeedCommentWrite {
  authorName: string;
  body: string;
  createdAt: Date;
}

export interface SeedTicket {
  ticket: SeedTicketWrite;
  comments: SeedCommentWrite[];
}

/* ------------------------------------------------------------------ *
 * Deterministic randomness
 * ------------------------------------------------------------------ */

/**
 * mulberry32 — a 32-bit PRNG that is four lines long, has no dependencies, and
 * is identical on every platform and Node version. `Math.random()` is none of
 * those things, and reproducibility is the point.
 */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const pick = <T>(random: () => number, values: readonly T[]): T => {
  const value = values[Math.floor(random() * values.length)];
  // `noUncheckedIndexedAccess` is on; the index is in range by construction, but
  // an empty pool would otherwise be `undefined` written into a NOT NULL column.
  if (value === undefined) throw new Error("Cannot pick from an empty pool");
  return value;
};

const weightedPick = <T>(random: () => number, options: readonly Weighted<T>[]): T => {
  const total = options.reduce((sum, option) => sum + option.weight, 0);
  let threshold = random() * total;

  for (const option of options) {
    threshold -= option.weight;
    if (threshold < 0) return option.value;
  }

  const last = options.at(-1);
  if (last === undefined) throw new Error("Cannot pick from an empty weight table");
  return last.value;
};

/* ------------------------------------------------------------------ *
 * Generation
 * ------------------------------------------------------------------ */

const MS_PER_DAY = 86_400_000;

/** Raises a drawn priority to a template's floor. "Site-wide outage, low" reads as a bug. */
const atLeast = (drawn: TicketPriority, floor: TicketPriority | undefined): TicketPriority => {
  if (floor === undefined) return drawn;
  return TICKET_PRIORITIES.indexOf(drawn) >= TICKET_PRIORITIES.indexOf(floor) ? drawn : floor;
};

/**
 * The whole dataset, as plain objects. Pure: same `now` in, same rows out, and
 * nothing here touches Prisma — which is what lets the distribution be asserted
 * without a database.
 *
 * Rows come back **sorted by `createdAt` ascending**, so autoincrement hands out
 * ticket numbers in chronological order. `HD-000001` being the oldest ticket is
 * how a real system behaves, and it is free here.
 *
 * `seed` defaults to the shipped constant and exists so tests can assert the
 * *structural* invariants (a `closed` ticket carries both timestamps, no comment
 * predates its ticket) across many datasets rather than only the one that ships.
 * Production callers never pass it.
 */
export function buildSeedTickets(now: Date, seed: number = PRNG_SEED): SeedTicket[] {
  const random = createRandom(seed);
  const nowMs = now.getTime();

  const seeded = TICKET_TEMPLATES.map((template, index) => {
    const status = weightedPick(random, STATUS_WEIGHTS);
    const priority = atLeast(weightedPick(random, PRIORITY_WEIGHTS), template.minPriority);
    const requester = pick(random, REQUESTERS);
    const assignee = random() < UNASSIGNED_SHARE ? null : pick(random, ASSIGNEES);

    // Spread across the window, never in the future, and never exactly `now` —
    // a ticket created "0 ms ago" renders as an empty relative timestamp.
    const ageMs = Math.floor(random() * SEED_WINDOW_DAYS * MS_PER_DAY) + 60_000;
    const createdAt = new Date(nowMs - ageMs);

    /* Lifecycle timestamps, mirroring what `applyStatusSideEffects` would have
     * produced had the ticket walked the transitions through the API:
     * `resolved` carries a `resolvedAt`; `closed` carries both, and its
     * `resolvedAt` is never later than its `closedAt`. */
    let resolvedAt: Date | null = null;
    let closedAt: Date | null = null;

    if (status === "resolved" || status === "closed") {
      resolvedAt = new Date(createdAt.getTime() + Math.floor(random() * ageMs * 0.6) + 30_000);
    }
    if (status === "closed" && resolvedAt !== null) {
      const remaining = nowMs - resolvedAt.getTime();
      closedAt = new Date(resolvedAt.getTime() + Math.floor(random() * remaining * 0.8) + 30_000);
    }

    /* `updatedAt` is the last thing that happened to the *ticket*, so it is at
     * least the newest lifecycle timestamp. Active tickets get an edit somewhere
     * in their life, which keeps `?sort=updatedAt:desc` a different order from
     * `?sort=createdAt:desc` rather than a copy of it. */
    const lastLifecycle = closedAt ?? resolvedAt ?? createdAt;
    const drift = Math.floor(random() * (nowMs - lastLifecycle.getTime()) * 0.4);
    const updatedAt = new Date(lastLifecycle.getTime() + drift);

    const ticket: SeedTicketWrite = {
      title: template.title,
      description: template.description,
      status,
      priority,
      category: template.category,
      requesterName: requester.name,
      requesterEmail: requester.email,
      assignee,
      createdAt,
      updatedAt,
      resolvedAt,
      closedAt,
    };

    return {
      ticket,
      comments: buildComments(random, index, ticket, nowMs),
    };
  });

  return seeded.sort((a, b) => a.ticket.createdAt.getTime() - b.ticket.createdAt.getTime());
}

/**
 * A ticket's thread: 0–6 comments, oldest first, all after the ticket's own
 * `createdAt` and none in the future.
 *
 * **Every third eligible thread has two comments landing in the same
 * millisecond, on purpose.** `createdAt` alone is not a total order over
 * comments, so the read path orders by `[createdAt asc, id asc]`; without a
 * collision in the data, dropping that `id` tiebreaker would break nothing
 * visible and the regression would ship. See `docs/features/Comments.md`.
 */
function buildComments(
  random: () => number,
  ticketIndex: number,
  ticket: SeedTicketWrite,
  nowMs: number,
): SeedCommentWrite[] {
  const count = weightedPick(random, COMMENT_COUNT_WEIGHTS);
  if (count === 0) return [];

  const startMs = ticket.createdAt.getTime();
  // Threads run out before the ticket goes quiet, not up to the current second.
  const spanMs = Math.max(nowMs - startMs, 2 * 60_000) * 0.8;

  const offsets = Array.from({ length: count }, () => Math.floor(random() * spanMs) + 60_000).sort(
    (a, b) => a - b,
  );

  if (count >= 3 && ticketIndex % 3 === 0) {
    // Two agents replying to the same thread in the same tick — rare in wall
    // time, routine under a script, and the only thing that exercises the
    // tiebreaker.
    offsets[2] = offsets[1] ?? offsets[2] ?? 0;
  }

  const agent = ticket.assignee ?? pick(random, ASSIGNEES);

  return offsets.map((offset, index) => {
    // Alternating so a thread reads as a conversation; the agent opens it.
    const fromAgent = index % 2 === 0;
    return {
      authorName: fromAgent ? agent : ticket.requesterName,
      body: pick(random, fromAgent ? AGENT_COMMENTS : REQUESTER_COMMENTS),
      createdAt: new Date(startMs + offset),
    };
  });
}

/* ------------------------------------------------------------------ *
 * The guard
 * ------------------------------------------------------------------ */

/**
 * Seeding wipes the database, so it is refused where "wipe the database" is
 * least likely to be what was meant.
 *
 * **The switch is `ALLOW_SEED`, and `NODE_ENV` only decides the default.** A
 * production build is exactly what the Docker image runs, and that image ships
 * demo data — keying the refusal on `NODE_ENV=production` alone would make the
 * container unable to seed at all, and the workaround would be lying about
 * `NODE_ENV`, which turns off verbose errors as a side effect.
 *
 * Pure and exported so this decision is testable without setting environment
 * variables in a worker that has already parsed them.
 */
export const isSeedAllowed = (nodeEnv: string, allowSeed: boolean): boolean =>
  allowSeed || nodeEnv !== "production";

export class SeedNotAllowedError extends Error {
  constructor() {
    super(
      "Refusing to seed: NODE_ENV=production and ALLOW_SEED is not set. " +
        "Seeding deletes every ticket and comment first. Set ALLOW_SEED=true to proceed " +
        "(see docs/engineering/ENVIRONMENT_VARIABLES.md).",
    );
    this.name = "SeedNotAllowedError";
  }
}

/* ------------------------------------------------------------------ *
 * The write
 * ------------------------------------------------------------------ */

export interface SeedResult {
  tickets: number;
  comments: number;
}

/**
 * Wipe, then insert.
 *
 * `sqlite_sequence` is reset alongside the delete so a re-seed reuses ids 1–63
 * rather than continuing from 64. Without it "reproducible" would hold for the
 * *content* of the tickets and not for their numbers, and `HD-000042` would mean
 * a different ticket on every run — including in the screenshots the fixed PRNG
 * seed exists to make comparable.
 *
 * One transaction: 63 tickets with their nested threads either all land or none
 * do, so an interrupted seed cannot leave a half-populated database that looks
 * fine until someone pages to the end.
 */
export async function seedDatabase(options: { now?: Date } = {}): Promise<SeedResult> {
  if (!isSeedAllowed(env.NODE_ENV, env.ALLOW_SEED)) throw new SeedNotAllowedError();

  const rows = buildSeedTickets(options.now ?? new Date());

  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('DELETE FROM "Comment"');
      await tx.$executeRawUnsafe('DELETE FROM "Ticket"');
      await tx.$executeRawUnsafe(`DELETE FROM sqlite_sequence WHERE name IN ('Ticket', 'Comment')`);

      let comments = 0;

      for (const row of rows) {
        await tx.ticket.create({
          data: {
            // The only route a rank takes into this insert. See `SeedTicketWrite`.
            ...applyTicketRanks(row.ticket),
            comments: { create: row.comments },
          },
          select: { id: true },
        });
        comments += row.comments.length;
      }

      return { tickets: rows.length, comments };
    },
    // 63 inserts plus ~190 nested ones on a cold SQLite file comfortably fits,
    // but the default 5 s interactive timeout is tight enough on a loaded CI box
    // to be worth not thinking about again.
    { timeout: 30_000 },
  );
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

/**
 * Run only when this file is the process entrypoint, so importing it from a test
 * does not seed anything. `prisma db seed` and `tsx src/seed/index.ts` both come
 * through here.
 */
const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  const startedAt = Date.now();

  try {
    const result = await seedDatabase();
    logger.info("Seed complete", {
      ...result,
      expectedTickets: SEED_TICKET_COUNT,
      durationMs: Date.now() - startedAt,
      database: env.DATABASE_URL,
    });
  } catch (err) {
    logger.error("Seed failed", { err });
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
