import { z } from "zod";
import { TICKET_ID_MAX_DIGITS } from "./reference.js";

export const COMMENT_AUTHOR_NAME_MIN = 2;
export const COMMENT_AUTHOR_NAME_MAX = 80;
export const COMMENT_BODY_MIN = 1;
export const COMMENT_BODY_MAX = 2000;

/** Server → client. Comments are append-only, so there is no `updatedAt`. */
export const commentSchema = z
  .object({
    id: z.number().int().positive(),
    ticketId: z.number().int().positive(),
    authorName: z.string(),
    body: z.string(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type Comment = z.infer<typeof commentSchema>;

/**
 * Client → server for `POST /tickets/:ticketId/comments`.
 *
 * `.strict()`: a payload carrying `id`, `ticketId`, or `createdAt` is a
 * `VALIDATION_ERROR`, not a silent strip. `ticketId` comes from the path.
 */
export const createCommentInputSchema = z
  .object({
    authorName: z
      .string()
      .trim()
      .min(
        COMMENT_AUTHOR_NAME_MIN,
        `Author name must be at least ${COMMENT_AUTHOR_NAME_MIN} characters`,
      )
      .max(
        COMMENT_AUTHOR_NAME_MAX,
        `Author name must be at most ${COMMENT_AUTHOR_NAME_MAX} characters`,
      ),
    body: z
      .string()
      .trim()
      .min(COMMENT_BODY_MIN, "Comment cannot be empty")
      .max(COMMENT_BODY_MAX, `Comment must be at most ${COMMENT_BODY_MAX} characters`),
  })
  .strict();
export type CreateCommentInput = z.infer<typeof createCommentInputSchema>;

/**
 * `:commentId` — decimal digits only, exactly like `ticketIdParamSchema`.
 *
 * A segment that fails this becomes **404 `COMMENT_NOT_FOUND`**, never 422: a
 * malformed id and a missing comment are indistinguishable to a caller, and
 * distinguishing them turns the path into a probe
 * (`docs/engineering/API_ERROR_CONTRACT.md` § Status conventions).
 *
 * Written out here rather than reused from `ticket.ts` because `ticket.ts`
 * imports *this* module — a back-import would close the cycle. What is *not*
 * duplicated is the digit bound: `TICKET_ID_MAX_DIGITS` comes from
 * `reference.js`, which imports nothing and is therefore reachable from both.
 * `comment.test.ts` asserts this schema, `ticketIdParamSchema`, and
 * `parseReference` all agree over one shared input table — the three of them are
 * the only ways user input becomes a ticket or comment id, and any disagreement
 * is a URL that resolves one way through a path and another through search.
 */
export const commentIdParamSchema = z
  .string()
  .regex(new RegExp(`^\\d{1,${TICKET_ID_MAX_DIGITS}}$`))
  .transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));
