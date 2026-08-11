import { z } from "zod";

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
