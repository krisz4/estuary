import {
  formatReference,
  type Comment,
  type Ticket,
  type TicketCategory,
  type TicketPriority,
  type TicketStatus,
  type TicketSummary,
} from "@helpdesk/contracts";

/**
 * The single boundary between a database row and the wire.
 *
 * Two jobs, both of which are silent bugs when a route forgets them:
 *
 * 1. **`Date` → ISO 8601 UTC string.** `JSON.stringify` happens to call
 *    `Date.prototype.toJSON`, so forgetting this looks fine until a value is
 *    reshaped on the way out and a raw `Date` reaches a client as `{}`.
 * 2. **`reference`** (`HD-000042`) is computed here, never stored — see
 *    `docs/features/Ticket_Numbering.md`.
 *
 * It also drops the two columns that exist only so SQLite can sort:
 * `statusRank` and `priorityRank` are storage detail and are never serialized.
 *
 * There is one function per shape rather than a serializer per route, so no
 * route can forget. Routes call these; nothing else builds a response body.
 */

/* ------------------------------------------------------------------ *
 * Row shapes
 *
 * Declared structurally rather than imported from `@prisma/client` so this
 * module stays honest about what it needs, and so `lib/` does not depend on a
 * generated client to typecheck. Prisma's own row types satisfy them.
 * ------------------------------------------------------------------ */

export interface CommentRow {
  id: number;
  ticketId: number;
  authorName: string;
  body: string;
  createdAt: Date;
}

export interface TicketRow {
  id: number;
  title: string;
  description: string;
  /** Constrained to `TicketStatus` by the zod enums on every write path. */
  status: string;
  /** Constrained to `TicketPriority` by the zod enums on every write path. */
  priority: string;
  /** Constrained to `TicketCategory` by the zod enums on every write path. */
  category: string | null;
  requesterName: string;
  requesterEmail: string;
  assignee: string | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  closedAt: Date | null;
}

/* ------------------------------------------------------------------ *
 * Date helpers
 * ------------------------------------------------------------------ */

export const toIso = (value: Date): string => value.toISOString();

export const toIsoOrNull = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

/* ------------------------------------------------------------------ *
 * Serializers
 * ------------------------------------------------------------------ */

export const serializeComment = (row: CommentRow): Comment => ({
  id: row.id,
  ticketId: row.ticketId,
  authorName: row.authorName,
  body: row.body,
  createdAt: toIso(row.createdAt),
});

/**
 * The fields shared by `Ticket` and `TicketSummary`.
 *
 * The enum casts are safe by construction: `status`, `priority`, and `category`
 * are `String` columns whose only writers parse through the zod enums in
 * `packages/contracts` (see `docs/engineering/DATABASE.md`). Re-parsing here
 * would turn a data problem into a `ZodError` on a **read** path, which the
 * error handler would then report as a 422 on a `GET`.
 */
const serializeTicketFields = (row: TicketRow, commentCount: number): TicketSummary => ({
  id: row.id,
  reference: formatReference(row.id),
  title: row.title,
  description: row.description,
  status: row.status as TicketStatus,
  priority: row.priority as TicketPriority,
  category: row.category as TicketCategory | null,
  requesterName: row.requesterName,
  requesterEmail: row.requesterEmail,
  assignee: row.assignee,
  createdAt: toIso(row.createdAt),
  updatedAt: toIso(row.updatedAt),
  resolvedAt: toIsoOrNull(row.resolvedAt),
  closedAt: toIsoOrNull(row.closedAt),
  commentCount,
});

/**
 * List rows: no `comments` array, so the list can never fan out into N comment
 * queries. `commentCount` comes from a Prisma `_count` aggregate.
 *
 * `_count` is **required**, not defaulted to zero. This module exists so no
 * route can forget a field; a default would turn a forgotten
 * `_count: { select: { comments: true } }` into every ticket in the list quietly
 * reporting 0 comments, instead of a type error at the call site.
 */
export const serializeTicketSummary = (
  row: TicketRow & { _count: { comments: number } },
): TicketSummary => serializeTicketFields(row, row._count.comments);

/**
 * Single ticket: the comment thread is included, oldest-first, and
 * `commentCount` defaults to its length when no `_count` aggregate was selected.
 */
export const serializeTicket = (
  row: TicketRow & { comments: CommentRow[]; _count?: { comments: number } },
): Ticket => ({
  ...serializeTicketFields(row, row._count?.comments ?? row.comments.length),
  comments: row.comments.map(serializeComment),
});
