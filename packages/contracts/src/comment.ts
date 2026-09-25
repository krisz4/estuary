import { z } from "zod";
import { storedActorSchema } from "./actor.js";
import { TASK_ID_MAX_DIGITS } from "./reference.js";

export const COMMENT_BODY_MIN = 1;
export const COMMENT_BODY_MAX = 5000;

/**
 * What a comment is for. The thread mixes human discussion with agents'
 * working notes; `kind` lets the UI tell them apart and lets a reader filter
 * the noise.
 *
 * - `note` — ordinary discussion (the default)
 * - `progress` — an agent's working log while it holds the task
 * - `qa_feedback` — why a `needs_qa` hand-off was sent back
 */
export const COMMENT_KINDS = ["note", "progress", "qa_feedback"] as const;
export const commentKindSchema = z.enum(COMMENT_KINDS);
export type CommentKind = z.infer<typeof commentKindSchema>;

/**
 * Server → client. Comments are append-only, so there is no `updatedAt`.
 * `author` is the actor that posted it (`X-Actor`), not a free-text name.
 */
export const commentSchema = z
  .object({
    id: z.number().int().positive(),
    taskId: z.number().int().positive(),
    author: storedActorSchema,
    kind: commentKindSchema,
    body: z.string(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type Comment = z.infer<typeof commentSchema>;

/**
 * Client → server for `POST /tasks/:taskId/comments`.
 *
 * `.strict()`: a payload carrying `id`, `taskId`, `author`, or `createdAt` is a
 * `VALIDATION_ERROR`, not a silent strip. `taskId` comes from the path and
 * `author` from the `X-Actor` header.
 */
export const createCommentInputSchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(COMMENT_BODY_MIN, "Comment cannot be empty")
      .max(COMMENT_BODY_MAX, `Comment must be at most ${COMMENT_BODY_MAX} characters`),
    kind: commentKindSchema.default("note"),
  })
  .strict();
export type CreateCommentInput = z.infer<typeof createCommentInputSchema>;
export type CreateCommentInputRaw = z.input<typeof createCommentInputSchema>;

/**
 * `:commentId` — decimal digits only, exactly like `taskIdParamSchema`.
 *
 * A segment that fails this becomes **404 `COMMENT_NOT_FOUND`**, never 422: a
 * malformed id and a missing comment are indistinguishable to a caller, and
 * distinguishing them turns the path into a probe
 * (`docs/engineering/API_ERROR_CONTRACT.md` § Status conventions).
 *
 * Written out here rather than reused from `task.ts` because `task.ts`
 * imports *this* module — a back-import would close the cycle. What is *not*
 * duplicated is the digit bound: `TASK_ID_MAX_DIGITS` comes from
 * `reference.js`, which imports nothing and is therefore reachable from both.
 * `comment.test.ts` asserts this schema, `taskIdParamSchema`, and
 * `parseReference` all agree over one shared input table.
 */
export const commentIdParamSchema = z
  .string()
  .regex(new RegExp(`^\\d{1,${TASK_ID_MAX_DIGITS}}$`))
  .transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));
