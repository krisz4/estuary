import { z } from "zod";
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE,
  MAX_PAGE_SIZE,
  MIN_PAGE_SIZE,
  paginatedSchema,
} from "./pagination.js";
import {
  TICKET_ASSIGNEE_MAX,
  TICKET_EMAIL_MAX,
  ticketCategorySchema,
  ticketPrioritySchema,
  ticketStatusSchema,
  ticketSummarySchema,
} from "./ticket.js";

/* ------------------------------------------------------------------ *
 * Sorting
 * ------------------------------------------------------------------ */

export const TICKET_SORT_FIELDS = [
  "id",
  "createdAt",
  "updatedAt",
  "title",
  "status",
  "priority",
] as const;
export type TicketSortField = (typeof TICKET_SORT_FIELDS)[number];

export const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

export const DEFAULT_TICKET_SORT_FIELD: TicketSortField = "createdAt";
export const DEFAULT_TICKET_SORT_DIRECTION: SortDirection = "desc";
/** The wire form of the default, for link builders and the URL-state helper. */
export const DEFAULT_TICKET_SORT = "createdAt:desc";

export type TicketSort = { field: TicketSortField; direction: SortDirection };

/** `{ field, direction }` → `"createdAt:desc"`. */
export const formatTicketSort = (sort: TicketSort): string => `${sort.field}:${sort.direction}`;

const isSortField = (value: string): value is TicketSortField =>
  (TICKET_SORT_FIELDS as readonly string[]).includes(value);

const isSortDirection = (value: string): value is SortDirection =>
  (SORT_DIRECTIONS as readonly string[]).includes(value);

/**
 * One `field:direction` clause. `status` and `priority` are accepted here but
 * are translated by the service into their integer rank columns — SQLite cannot
 * order a text column by lifecycle or severity.
 */
export const ticketSortSchema = z
  .string()
  .trim()
  .transform((raw, ctx): TicketSort => {
    const [field, direction, ...rest] = raw.split(":");

    if (field === undefined || direction === undefined || rest.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `Sort must be "field:direction", e.g. "${DEFAULT_TICKET_SORT}"`,
      });
      return z.NEVER;
    }
    if (!isSortField(field)) {
      ctx.addIssue({
        code: "custom",
        message: `Unknown sort field "${field}". Expected one of: ${TICKET_SORT_FIELDS.join(", ")}`,
      });
      return z.NEVER;
    }
    if (!isSortDirection(direction)) {
      ctx.addIssue({
        code: "custom",
        message: `Sort direction must be one of: ${SORT_DIRECTIONS.join(", ")}`,
      });
      return z.NEVER;
    }

    return { field, direction };
  })
  .default({ field: DEFAULT_TICKET_SORT_FIELD, direction: DEFAULT_TICKET_SORT_DIRECTION });

/* ------------------------------------------------------------------ *
 * Query-string coercion helpers
 * ------------------------------------------------------------------ */

/**
 * Drops empty values before parsing, so `?page=&status=` behaves exactly like `?`.
 *
 * Browsers, forms, and link builders emit empty params constantly. Without this,
 * `z.coerce.number()` turns `""` into `0`, which then fails `min(1)` and 422s a
 * request the user never meant to make.
 *
 * A repeated param collapses to its non-empty values, and vanishes entirely if
 * none remain. Note the consequence for unknown keys: `?utm_source=slack` is a
 * `VALIDATION_ERROR` from `.strict()`, but `?utm_source=` is simply absent —
 * an empty value carries no intent to reject.
 *
 * Whitespace-only counts as empty. `?q=%20` is what a user typing a space into
 * the search box produces; it carries exactly as little intent as `?q=`, and
 * 422ing one but not the other is a distinction the user cannot see.
 */
const isBlank = (value: unknown): boolean => typeof value === "string" && value.trim() === "";

export const dropEmptyQueryValues = (input: unknown): unknown => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isBlank(value)) continue;
    if (Array.isArray(value)) {
      const kept = value.filter((entry) => !isBlank(entry));
      if (kept.length > 0) result[key] = kept;
      continue;
    }
    result[key] = value;
  }
  return result;
};

/**
 * A repeatable filter: `?status=open&status=in_progress`. Express hands over a
 * bare string for one occurrence and an array for several, so single values are
 * wrapped before the array schema sees them. Values within one param OR
 * together; different params AND together.
 */
const repeatable = <TInner extends z.ZodType>(inner: TInner) =>
  z
    .preprocess((value) => (Array.isArray(value) ? value : [value]), z.array(inner).min(1))
    .optional();

/**
 * `z.coerce.boolean()` is wrong for query strings — it follows JS truthiness, so
 * `"false"` parses as `true`. Only the four unambiguous spellings are accepted;
 * anything else is a `VALIDATION_ERROR` rather than a silently inverted filter.
 */
const queryBoolean = z.union([
  z.boolean(),
  z.enum(["true", "false", "1", "0"]).transform((value) => value === "true" || value === "1"),
]);

/* ------------------------------------------------------------------ *
 * The list query
 * ------------------------------------------------------------------ */

export const TICKET_Q_MAX = 120;

const ticketListQueryObjectSchema = z
  .object({
    page: z.coerce
      .number()
      .int()
      .min(1, "Page must be at least 1")
      // Bounded for the same reason `pageSize` is, plus a concrete one: the
      // service computes `skip = (page - 1) * pageSize`, and Prisma's `skip` is
      // an Int32 in the query engine. An unbounded `page` turns a nonsense URL
      // into a 500 instead of the documented empty page.
      .max(MAX_PAGE, `Page must be at most ${MAX_PAGE}`)
      .default(DEFAULT_PAGE),
    pageSize: z.coerce
      .number()
      .int()
      .min(MIN_PAGE_SIZE, `Page size must be at least ${MIN_PAGE_SIZE}`)
      // Rejected, not clamped: a client asking for 500 rows has a bug worth surfacing.
      .max(MAX_PAGE_SIZE, `Page size must be at most ${MAX_PAGE_SIZE}`)
      .default(DEFAULT_PAGE_SIZE),
    sort: ticketSortSchema,

    status: repeatable(ticketStatusSchema),
    priority: repeatable(ticketPrioritySchema),
    category: repeatable(ticketCategorySchema),

    // Exact and case-sensitive. Send a value from `GET /tickets/facets`.
    assignee: z.string().trim().min(1).max(TICKET_ASSIGNEE_MAX).optional(),
    assigneeIsNull: queryBoolean.optional(),

    requesterEmail: z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.email("Enter a valid email address").max(TICKET_EMAIL_MAX))
      .optional(),

    q: z.string().trim().min(1).max(TICKET_Q_MAX).optional(),

    // Date-only, UTC. The service expands `createdTo` to an exclusive next-day
    // bound so the named day is included.
    createdFrom: z.iso.date("Expected a date in YYYY-MM-DD form").optional(),
    createdTo: z.iso.date("Expected a date in YYYY-MM-DD form").optional(),
  })
  // Unknown params are rejected rather than ignored: a typo'd filter silently
  // returning everything is worse than an error.
  .strict()
  .superRefine((value, ctx) => {
    if (value.assignee !== undefined && value.assigneeIsNull !== undefined) {
      // A sentinel like `assignee=none` would collide with a real person, so the
      // two are separate params — which makes them mutually exclusive.
      const message = "Send either assignee or assigneeIsNull, not both";
      ctx.addIssue({ code: "custom", path: ["assignee"], message });
      ctx.addIssue({ code: "custom", path: ["assigneeIsNull"], message });
    }

    // An inverted range is always empty. Silently returning nothing reads to the
    // user as "no tickets exist" rather than "your two date pickers disagree".
    if (value.createdFrom !== undefined && value.createdTo !== undefined) {
      if (value.createdFrom > value.createdTo) {
        ctx.addIssue({
          code: "custom",
          path: ["createdTo"],
          message: "createdTo must be on or after createdFrom",
        });
      }
    }
  });

/**
 * `GET /tickets` query parameters. All optional; `page`, `pageSize`, and `sort`
 * come back filled with their defaults.
 *
 * Server-side only. `useTicketListParams()` on the web **picks the keys it
 * knows** out of `useSearchParams()` instead of feeding raw params in here — a
 * shared link carrying `?utm_source=slack` must not fail the whole parse and
 * silently reset every filter the recipient was meant to see.
 */
export const ticketListQuerySchema = z.preprocess(
  dropEmptyQueryValues,
  ticketListQueryObjectSchema,
);

export type TicketListQuery = z.infer<typeof ticketListQuerySchema>;
export type TicketListQueryInput = z.input<typeof ticketListQuerySchema>;

/** The enveloped list response: ticket summaries plus pagination `meta`. */
export const paginatedTicketsSchema = paginatedSchema(ticketSummarySchema);
export type PaginatedTickets = z.infer<typeof paginatedTicketsSchema>;
