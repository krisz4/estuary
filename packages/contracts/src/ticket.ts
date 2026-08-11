import { z } from "zod";
import { commentSchema } from "./comment.js";

/* ------------------------------------------------------------------ *
 * Enums
 *
 * SQLite has no enum type, so `status` / `priority` / `category` are
 * `String` columns. These zod enums are the real constraint: a service
 * must never write a value that did not come from the matching `.parse()`.
 * ------------------------------------------------------------------ */

/** Lifecycle order. The index in this array is the persisted `statusRank`. */
export const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
export const ticketStatusSchema = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof ticketStatusSchema>;

/** Severity order, ascending. The index in this array is the persisted `priorityRank`. */
export const TICKET_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const ticketPrioritySchema = z.enum(TICKET_PRIORITIES);
export type TicketPriority = z.infer<typeof ticketPrioritySchema>;

/**
 * Category is a closed enum rather than free text so exact-match filtering
 * works: SQLite's `equals` is case-sensitive and Prisma's SQLite connector has
 * no `mode: "insensitive"`, so free-text categories would make `?category=Network`
 * silently miss rows stored as `network`.
 */
export const TICKET_CATEGORIES = [
  "hardware",
  "software",
  "network",
  "access",
  "email",
  "other",
] as const;
export const ticketCategorySchema = z.enum(TICKET_CATEGORIES);
export type TicketCategory = z.infer<typeof ticketCategorySchema>;

export const DEFAULT_TICKET_STATUS: TicketStatus = "open";
export const DEFAULT_TICKET_PRIORITY: TicketPriority = "medium";

/* ------------------------------------------------------------------ *
 * Field bounds
 * ------------------------------------------------------------------ */

export const TICKET_TITLE_MIN = 5;
export const TICKET_TITLE_MAX = 120;
export const TICKET_DESCRIPTION_MIN = 10;
export const TICKET_DESCRIPTION_MAX = 5000;
export const TICKET_REQUESTER_NAME_MIN = 2;
export const TICKET_REQUESTER_NAME_MAX = 80;
export const TICKET_ASSIGNEE_MIN = 2;
export const TICKET_ASSIGNEE_MAX = 80;
export const TICKET_EMAIL_MAX = 254;

/**
 * Wraps an optional string-ish field so that an empty (or whitespace-only)
 * string becomes `null` rather than `""`.
 *
 * This is load-bearing, not cosmetic. Clearing a field in the edit form posts
 * `""`; stored as an empty string, that ticket then matches neither
 * `assigneeIsNull=true` nor any name filter and disappears from every assignee
 * view. **Any new optional string field gets the same treatment.**
 *
 * The trim happens in the preprocessor so the length bounds below see the
 * trimmed value.
 */
export const emptyStringToNull = <TInner extends z.ZodType>(inner: TInner) =>
  z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }, inner);

export const assigneeInputSchema = emptyStringToNull(
  z
    .string()
    .min(TICKET_ASSIGNEE_MIN, `Assignee must be at least ${TICKET_ASSIGNEE_MIN} characters`)
    .max(TICKET_ASSIGNEE_MAX, `Assignee must be at most ${TICKET_ASSIGNEE_MAX} characters`)
    .nullable(),
);

export const categoryInputSchema = emptyStringToNull(ticketCategorySchema.nullable());

export const titleInputSchema = z
  .string()
  .trim()
  .min(TICKET_TITLE_MIN, `Title must be at least ${TICKET_TITLE_MIN} characters`)
  .max(TICKET_TITLE_MAX, `Title must be at most ${TICKET_TITLE_MAX} characters`);

export const descriptionInputSchema = z
  .string()
  .trim()
  .min(TICKET_DESCRIPTION_MIN, `Description must be at least ${TICKET_DESCRIPTION_MIN} characters`)
  .max(TICKET_DESCRIPTION_MAX, `Description must be at most ${TICKET_DESCRIPTION_MAX} characters`);

export const requesterNameInputSchema = z
  .string()
  .trim()
  .min(
    TICKET_REQUESTER_NAME_MIN,
    `Requester name must be at least ${TICKET_REQUESTER_NAME_MIN} characters`,
  )
  .max(
    TICKET_REQUESTER_NAME_MAX,
    `Requester name must be at most ${TICKET_REQUESTER_NAME_MAX} characters`,
  );

/**
 * Trimmed and lowercased **in the schema**, not in the service, so the API and
 * the client agree on the canonical value that case-sensitive exact-match
 * filtering compares against.
 */
export const requesterEmailInputSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Enter a valid email address").max(TICKET_EMAIL_MAX));

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

/**
 * Client → server for `POST /tickets`.
 *
 * `.strict()` matters here: a payload containing a server-owned field (`id`,
 * `createdAt`, `status`, `resolvedAt`, …) is rejected with `VALIDATION_ERROR`
 * rather than silently stripped. Silent stripping hides client bugs — the
 * caller believes it set a field that was thrown away.
 *
 * `status` is absent by design: a new ticket is always `open`.
 */
export const createTicketInputSchema = z
  .object({
    title: titleInputSchema,
    description: descriptionInputSchema,
    priority: ticketPrioritySchema.default(DEFAULT_TICKET_PRIORITY),
    category: categoryInputSchema.optional(),
    requesterName: requesterNameInputSchema,
    requesterEmail: requesterEmailInputSchema,
    assignee: assigneeInputSchema.optional(),
  })
  .strict();
export type CreateTicketInput = z.infer<typeof createTicketInputSchema>;

/**
 * Client → server for `PATCH /tickets/:ticketId`. Every field optional.
 *
 * An **empty body is deliberately valid here.** `{}` must surface as
 * `AT_LEAST_ONE_FIELD` (422), which is its own error code with no field
 * details — enforcing it as a zod refinement would collapse it into
 * `VALIDATION_ERROR`. The route checks emptiness after parsing;
 * `hasAtLeastOneField()` below is that check.
 *
 * `resolvedAt` / `closedAt` are absent: they are derived by the status
 * transition logic and never accepted from a client.
 */
export const updateTicketInputSchema = z
  .object({
    title: titleInputSchema.optional(),
    description: descriptionInputSchema.optional(),
    status: ticketStatusSchema.optional(),
    priority: ticketPrioritySchema.optional(),
    category: categoryInputSchema.optional(),
    requesterName: requesterNameInputSchema.optional(),
    requesterEmail: requesterEmailInputSchema.optional(),
    assignee: assigneeInputSchema.optional(),
  })
  .strict();
export type UpdateTicketInput = z.infer<typeof updateTicketInputSchema>;

/** `true` when a parsed PATCH body carries at least one field. */
export const hasAtLeastOneField = (input: UpdateTicketInput): boolean =>
  Object.keys(input).length > 0;

/**
 * `:ticketId` — a non-numeric segment fails here and becomes 404, never 422.
 *
 * Decimal digits only, deliberately not `z.coerce.number()`: coercion accepts
 * `"0x2a"`, `"1e3"`, and `" 12 "`, which would serve ticket 42 under three alias
 * URLs. It would also disagree with `parseReference()`, the other entry point
 * that turns user input into a ticket id — and two disagreeing parsers for the
 * same concept is how `q=1e3` and `/tickets/1e3` end up resolving differently.
 */
export const ticketIdParamSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));

/* ------------------------------------------------------------------ *
 * Responses
 * ------------------------------------------------------------------ */

/**
 * Server → client, single ticket. `reference` is computed at serialization
 * time; `statusRank` / `priorityRank` are DB-only and never serialized — the
 * wire shape is allowed to differ from the Prisma model, and deriving one from
 * the other would couple the API surface to storage.
 */
export const ticketSchema = z
  .object({
    id: z.number().int().positive(),
    reference: z.string(),
    title: z.string(),
    description: z.string(),
    status: ticketStatusSchema,
    priority: ticketPrioritySchema,
    category: ticketCategorySchema.nullable(),
    requesterName: z.string(),
    requesterEmail: z.string(),
    assignee: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    resolvedAt: z.iso.datetime().nullable(),
    closedAt: z.iso.datetime().nullable(),
    commentCount: z.number().int().nonnegative(),
    comments: z.array(commentSchema),
  })
  .strict();
export type Ticket = z.infer<typeof ticketSchema>;

/**
 * List rows. Derived, not retyped — the list must never fan out into N comment
 * queries, so `comments` is dropped and only `commentCount` survives.
 */
export const ticketSummarySchema = ticketSchema.omit({ comments: true });
export type TicketSummary = z.infer<typeof ticketSummarySchema>;

/**
 * `GET /tickets/facets` — distinct non-null values actually present in the
 * table, sorted. It is the only source of options for the assignee filter, and
 * sending an exact stored value is what makes case-sensitive equality safe.
 */
export const ticketFacetsSchema = z
  .object({
    assignees: z.array(z.string()),
    categories: z.array(ticketCategorySchema),
  })
  .strict();
export type TicketFacets = z.infer<typeof ticketFacetsSchema>;
