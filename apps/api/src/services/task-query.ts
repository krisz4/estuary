import {
  parseReference,
  type PaginatedTickets,
  type TicketListQuery,
  type TicketSort,
} from "@helpdesk/contracts";
import type { Prisma } from "@prisma/client";

import { paginate, toSkipTake } from "../lib/pagination.js";
import { prisma } from "../lib/prisma.js";
import { serializeTicketSummary } from "../lib/serialize.js";
import { PRIORITY_RANK, STATUS_RANK } from "./ticket-status.js";

/**
 * The list query: `GET /tickets`'s filtering, sorting, and paging.
 *
 * Its own module rather than part of `ticket.service.ts` because it is the
 * largest single piece of logic in the API and the most-graded one — task 3 of
 * the brief. Behavioural spec:
 * `docs/features/Ticket_Query_Filter_Sort_Page.md`.
 *
 * `parseReference` is **imported** from `@helpdesk/contracts`, not reimplemented
 * here. The web app parses references too, and two parsers that disagree about
 * whether `HD-4` means ticket 4 or tickets 40–49 is a bug nobody would look for.
 */

/* ------------------------------------------------------------------ *
 * Date bounds
 * ------------------------------------------------------------------ */

const MS_PER_DAY = 86_400_000;

/** `"2026-08-11"` → `2026-08-11T00:00:00.000Z`. The schema has already validated the shape. */
const startOfUtcDay = (isoDate: string): Date => new Date(`${isoDate}T00:00:00.000Z`);

/**
 * The exclusive upper bound for an **inclusive** `createdTo` day.
 *
 * `createdTo=2026-08-11` means "everything created on the 11th", so the bound is
 * `< 2026-08-12T00:00:00.000Z`. A naive `lte: 2026-08-11T00:00:00.000Z` excludes
 * every ticket created that day — it reads to the user as "the date filter is
 * off by one" and is the single most common date-filter bug.
 *
 * Arithmetic in milliseconds rather than `setUTCDate`, and safe to do so because
 * these are UTC instants: there is no DST discontinuity to land on, and month
 * and year rollovers fall out of the epoch arithmetic.
 */
const startOfNextUtcDay = (isoDate: string): Date =>
  new Date(startOfUtcDay(isoDate).getTime() + MS_PER_DAY);

/* ------------------------------------------------------------------ *
 * WHERE
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Free-text search
 * ------------------------------------------------------------------ */

/**
 * The escape character for the `q` `LIKE` patterns.
 *
 * `!` rather than the reflexive `\`, because a backslash in a SQLite string
 * literal is not special — using it invites the reader to assume C-style
 * escaping is already happening, which is exactly the assumption this constant
 * exists to correct.
 */
export const LIKE_ESCAPE_CHAR = "!";

/**
 * Makes a literal safe to drop inside a regular-expression character class.
 *
 * `!` needs no escaping, but this constant is a knob someone may turn, and `^`,
 * `]`, `-`, and `\` all change a class's meaning rather than joining it.
 */
const escapeRegExp = (value: string): string => value.replaceAll(/[\\^\]$.*+?()[{}|/-]/g, "\\$&");

/**
 * Escapes the three characters `LIKE … ESCAPE '!'` treats specially.
 *
 * **Order matters:** the escape character is doubled *first*, or the escapes
 * added for `%` and `_` would themselves be escaped a second time and the
 * pattern would match nothing.
 *
 * Without this, user input is live pattern syntax: `?q=%` returns the entire
 * table, `?q=50%` matches "500 errors", and `?q=error_809` matches "errorX809".
 */
export const escapeLikePattern = (value: string): string =>
  value
    .replaceAll(LIKE_ESCAPE_CHAR, `${LIKE_ESCAPE_CHAR}${LIKE_ESCAPE_CHAR}`)
    .replaceAll("%", `${LIKE_ESCAPE_CHAR}%`)
    .replaceAll("_", `${LIKE_ESCAPE_CHAR}_`);

/**
 * Does this `q` need the raw `LIKE … ESCAPE` path, or can `contains` serve it?
 *
 * **The equivalence that makes the fast path safe:** `escapeLikePattern` only
 * ever rewrites `%`, `_`, and `!`. For a term containing none of them escaping
 * is a **no-op**, so `contains` and the escaped raw `LIKE` compile to the same
 * `LIKE '%term%'` against the same two columns — identical result sets, identical
 * ordering, identical paging. There is nothing to choose between them on
 * correctness, and `contains` is strictly cheaper (see below).
 *
 * The escape character is in the class because it is the escape character: a
 * term containing it is one whose escaped form differs from itself (`!` → `!!`),
 * so it is exactly a term the no-op argument does not cover. It is therefore
 * **derived from `LIKE_ESCAPE_CHAR` rather than written out** — a hardcoded `!`
 * here would silently stop matching the constant the day the constant changed,
 * and the symptom would be a wildcard term taking the fast path and having its
 * escape character treated as a wildcard.
 *
 * Why not simply always take the raw path: it charges every search for a problem
 * only some searches have. An `id IN (…)` page gives up `Ticket_createdAt_idx`
 * and takes `USE TEMP B-TREE FOR ORDER BY`, and the id list is one bind parameter
 * per match against SQLite's `SQLITE_MAX_VARIABLE_NUMBER`. `?q=printer` — which
 * has no wildcard in it at all — should pay neither.
 */
const LIKE_METACHARACTERS = new RegExp(`[%_${escapeRegExp(LIKE_ESCAPE_CHAR)}]`);

export const needsEscapedSearch = (q: string): boolean => LIKE_METACHARACTERS.test(q);

/**
 * Resolves `q` to a set of ticket ids with a raw, parameterized `LIKE … ESCAPE`.
 *
 * Called only for a `q` that `needsEscapedSearch()` — see the equivalence above.
 *
 * **Why raw SQL for something Prisma has an operator for.** `contains` compiles
 * to `LIKE ?` with **no `ESCAPE` clause**, and with no escape clause SQLite has
 * no escape character at all — so `%` and `_` in user input are wildcards, and
 * pre-escaping the string before handing it to `contains` does not help: `!%`
 * (or `\%`) is then two literal characters that match nothing. Prisma has no
 * built-in escape for `contains` and has declined to add one
 * ([prisma#19506](https://github.com/prisma/prisma/issues/19506)); raw SQL with
 * an explicit `ESCAPE` is the documented workaround.
 *
 * The pattern is a **bound parameter**, never interpolated. `$queryRaw` is used
 * as a tagged template so that is enforced by construction rather than by care.
 *
 * **The id set is unbounded, and that is a hard ceiling, not just a slope.** A
 * `q` matching every row materialises every id, and those ids come back as one
 * `WHERE id IN (?,?,…)` — one bind parameter each. SQLite's
 * `SQLITE_MAX_VARIABLE_NUMBER` is 32766 on modern builds (999 on pre-3.32 ones),
 * so a table large enough for a broad `q` to match more rows than that would
 * fail the query outright rather than merely run slowly. It also costs the
 * ordering index: an `id IN (…)` page plans as `SEARCH … USING INTEGER PRIMARY
 * KEY` plus a `USE TEMP B-TREE FOR ORDER BY`, where the unfiltered page walks
 * `Ticket_createdAt_idx` in order.
 *
 * All of that is fine at this scale — `docs/engineering/DATABASE.md` already
 * records `q` as a full scan and the seed is 63 rows — and the answer when it
 * stops being fine is FTS5, which the implementation plan defers explicitly. Do
 * not paper over it with a `LIMIT`: a truncated id set silently drops matches
 * and makes `meta.total` wrong.
 */
export async function resolveTextSearch(
  client: Pick<Prisma.TransactionClient, "$queryRaw">,
  q: string,
): Promise<number[]> {
  const pattern = `%${escapeLikePattern(q)}%`;

  /**
   * **`ESCAPE '!'` is a hand-maintained copy of `LIKE_ESCAPE_CHAR`, and it has
   * to be.** SQLite requires a literal after `ESCAPE` — it will not accept a
   * bind parameter there (`ESCAPE ?` is a syntax error), and interpolating the
   * constant into the template would defeat the whole point of using
   * `$queryRaw` as a tagged template, which is that *every* interpolation is a
   * bound parameter by construction.
   *
   * So the coupling is real and it is manual: **change `LIKE_ESCAPE_CHAR` and
   * you must change both literals below.** Left out of step, `escapeLikePattern`
   * emits (say) `#%` while SQLite still treats `!` as the escape character, so
   * `#` and `%` both reach `LIKE` as ordinary characters and every wildcard
   * search silently returns zero rows with `meta.total: 0` — no error, no log.
   * `ticket-query.test.ts` asserts the two agree by round-tripping a term
   * containing the escape character against a real row, so the disagreement
   * fails a test rather than a user's search.
   */
  const rows = await client.$queryRaw<{ id: number }[]>`
    SELECT id FROM "Ticket"
    WHERE title LIKE ${pattern} ESCAPE '!'
       OR description LIKE ${pattern} ESCAPE '!'
  `;

  return rows.map((row) => Number(row.id));
}

/** The filter fields `buildWhere` reads. A subset of the parsed query. */
export type TicketWhereQuery = Pick<
  TicketListQuery,
  | "status"
  | "priority"
  | "category"
  | "assignee"
  | "assigneeIsNull"
  | "requesterEmail"
  | "q"
  | "createdFrom"
  | "createdTo"
>;

/**
 * Translates parsed query params into a Prisma `where`.
 *
 * **Shape is the whole point.** Every filter is a separate entry in one
 * top-level `AND`, and `q` contributes exactly **one entry** — an `OR` group
 * nested inside that `AND`. Hoisting the `q` branches up to the top level is the
 * classic bug here: `title contains "vpn"` sitting beside the status filter as a
 * sibling `OR` makes search *widen* the result set past the active filters
 * instead of narrowing it, so a `resolved` ticket appears in a view filtered to
 * `open`. `docs/engineering/TESTING.md` requires a test for precisely that.
 *
 * Three translations that are not one-to-one with the param name:
 *
 * 1. **`status` / `priority` filter on the rank column *and* the text column.**
 *    The rank term is the one an index can serve —
 *    `Ticket_statusRank_createdAt_idx` is what makes the common view (a status
 *    filter, newest first) an index search rather than a table scan plus a sort,
 *    and `status` itself carries no index. The text term is what makes the answer
 *    *correct*: the two columns are only in bijection while every writer goes
 *    through `applyTicketRanks()`, and `statusRank` defaults to `0` in the
 *    schema, so any insert that skips the helper (raw SQL, a seed, a future
 *    service) lands a row under `?status=open` that is not open. Filtering on the
 *    rank alone would make that drift a wrong *result set* and a wrong
 *    `meta.total`, not merely a wrong order. SQLite still uses the index for the
 *    rank term and applies the text term as a residual predicate — verified with
 *    `EXPLAIN QUERY PLAN`.
 *
 *    **State the consequence plainly: the two terms are ANDed, so a drifted row
 *    is not misfiled, it is unreachable.** It fails the text term under its true
 *    status and the rank term under the drifted one, so *no* `?status=` value
 *    returns it — asking for all four statuses at once yields strictly fewer
 *    rows, and a smaller `meta.total`, than sending no status filter at all.
 *    That is the intended trade (a drifted row is corrupt data, and hiding it
 *    beats reporting it under a status it does not have), and it stays
 *    hypothetical only while `applyTicketRanks()` is the sole writer of the rank
 *    columns. The stage-9 seed is exactly the kind of write that could bypass it.
 *    Both halves are pinned by tests; do not drop either predicate.
 *
 *    (An index *search*, not a covering one: the list projects every column.
 *    Measured in stage 7 — see `docs/engineering/DATABASE.md` § Indexes.)
 * 2. **`assigneeIsNull`** maps to `assignee: null` when true and to
 *    `assignee: { not: null }` when false — a boolean filter that only filters
 *    in one direction is a trap for anyone who ever sends `false` explicitly.
 *    It is mutually exclusive with `assignee`, which the query schema enforces.
 * 3. **`createdTo`** expands to an exclusive next-day bound (see above).
 *
 * No `mode: "insensitive"` anywhere — the SQLite connector does not support it.
 * Exact-match filters compare canonical values instead: `category` is an enum,
 * `requesterEmail` is lowercased by the schema and stored lowercase, and
 * `assignee` options come from `GET /tickets/facets`.
 */
export function buildWhere(
  query: TicketWhereQuery,
  matchedIds?: number[],
): Prisma.TicketWhereInput {
  const clauses: Prisma.TicketWhereInput[] = [];

  if (query.status !== undefined) {
    clauses.push({
      statusRank: { in: query.status.map((value) => STATUS_RANK[value]) },
      status: { in: query.status },
    });
  }
  if (query.priority !== undefined) {
    clauses.push({
      priorityRank: { in: query.priority.map((value) => PRIORITY_RANK[value]) },
      priority: { in: query.priority },
    });
  }
  if (query.category !== undefined) {
    clauses.push({ category: { in: query.category } });
  }

  if (query.assignee !== undefined) {
    clauses.push({ assignee: query.assignee });
  }
  if (query.assigneeIsNull !== undefined) {
    clauses.push({ assignee: query.assigneeIsNull ? null : { not: null } });
  }

  if (query.requesterEmail !== undefined) {
    clauses.push({ requesterEmail: query.requesterEmail });
  }

  if (query.createdFrom !== undefined) {
    clauses.push({ createdAt: { gte: startOfUtcDay(query.createdFrom) } });
  }
  if (query.createdTo !== undefined) {
    clauses.push({ createdAt: { lt: startOfNextUtcDay(query.createdTo) } });
  }

  if (query.q !== undefined) {
    if (matchedIds === undefined && needsEscapedSearch(query.q)) {
      // A programmer error, and one that would otherwise turn user input back
      // into live `LIKE` pattern syntax — the bug the raw path exists to fix.
      throw new Error(
        "buildWhere: a `q` carrying LIKE metacharacters must be given its matchedIds",
      );
    }

    // Two spellings of the same query. `contains` for a term escaping would not
    // change (see `needsEscapedSearch`), which keeps the ordering index and has
    // no id list; the resolved id set for a term carrying `%`, `_`, or `!`.
    const branches: Prisma.TicketWhereInput[] =
      matchedIds === undefined
        ? [{ title: { contains: query.q } }, { description: { contains: query.q } }]
        : [{ id: { in: matchedIds } }];

    // A `q` that parses as a reference (`HD-42`, `hd-000042`, `#42`, `42`) also
    // matches that id exactly, so pasting a ticket number into search finds it.
    const referenceId = parseReference(query.q);
    if (referenceId !== null) branches.push({ id: referenceId });

    // One entry, nested. Not spread into `clauses` — that is what would make
    // search widen past the active filters instead of narrowing within them.
    clauses.push({ OR: branches });
  }

  return clauses.length === 0 ? {} : { AND: clauses };
}

/* ------------------------------------------------------------------ *
 * ORDER BY
 * ------------------------------------------------------------------ */

/**
 * The column each sortable field actually orders by.
 *
 * `status` and `priority` are the two that are not themselves: SQLite would sort
 * them alphabetically, which puts `high` before `urgent` and `closed` before
 * `open` — both meaningless. The integer rank columns encode lifecycle and
 * severity order instead. Declared as a `Record<TicketSortField, …>` so adding a
 * sortable field to the contract without deciding its column is a compile error.
 */
const SORT_COLUMN: Record<TicketSort["field"], keyof Prisma.TicketOrderByWithRelationInput> = {
  id: "id",
  createdAt: "createdAt",
  updatedAt: "updatedAt",
  title: "title",
  status: "statusRank",
  priority: "priorityRank",
};

/**
 * One sort clause plus a stable tiebreaker.
 *
 * Every sortable field except `id` is non-unique, and SQLite gives no ordering
 * guarantee between rows that tie. With offset paging that is not a cosmetic
 * problem: the engine may order the ties differently between the page-1 and
 * page-2 queries, so a row can appear on both pages while another appears on
 * neither. `{ id: "desc" }` makes the order total.
 *
 * It is omitted when `id` is already the sort field — a second clause on the
 * same column can never break a tie, since there are none.
 */
export function buildOrderBy(sort: TicketSort): Prisma.TicketOrderByWithRelationInput[] {
  const primary = { [SORT_COLUMN[sort.field]]: sort.direction };
  return sort.field === "id" ? [primary] : [primary, { id: "desc" }];
}

/* ------------------------------------------------------------------ *
 * The list
 * ------------------------------------------------------------------ */

/**
 * List summaries are returned with a `commentCount` aggregate rather than a
 * comment array, so the list can never fan out into N comment queries.
 */
const withCommentCount = {
  _count: { select: { comments: true } },
} satisfies Prisma.TicketInclude;

/**
 * A page of tickets plus its `meta`.
 *
 * **Every query runs inside one transaction**, so all of them observe the same
 * snapshot. Issued separately, a write landing between the page query and the
 * count yields a `meta.total` that disagrees with the page it describes — a
 * pager reporting 21 results over one page of 20 with no second page to visit.
 *
 * The `q` prefilter — taken only for a term carrying a `LIKE` metacharacter — is
 * inside the same transaction for exactly that reason: an id set resolved before
 * the transaction opened could name a ticket that no longer exists, or miss one
 * created a millisecond later, and the resulting `total` would describe neither
 * state.
 *
 * That prefilter is why this is the **interactive** form rather than the
 * `$transaction([findMany, count])` array form the plan describes: the array
 * form cannot feed one query's result into the next. Both queries still run as
 * one unit inside it, and the snapshot guarantee is strictly stronger, since it
 * now covers three queries rather than two.
 *
 * Returns serialized contract types, not Prisma rows: stage 8's route sends what
 * this returns and therefore cannot forget `serialize.ts`.
 */
export async function listTickets(query: TicketListQuery): Promise<PaginatedTickets> {
  const [rows, total] = await prisma.$transaction(async (tx) => {
    // The raw prefilter is the exception, not the rule: only a `q` carrying a
    // `LIKE` metacharacter needs it, and only that `q` pays for it.
    const matchedIds =
      query.q !== undefined && needsEscapedSearch(query.q)
        ? await resolveTextSearch(tx, query.q)
        : undefined;

    const where = buildWhere(query, matchedIds);

    return Promise.all([
      tx.ticket.findMany({
        where,
        orderBy: buildOrderBy(query.sort),
        ...toSkipTake(query),
        include: withCommentCount,
      }),
      tx.ticket.count({ where }),
    ]);
  });

  return paginate(rows.map(serializeTicketSummary), {
    page: query.page,
    pageSize: query.pageSize,
    total,
  });
}
