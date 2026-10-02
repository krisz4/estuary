import { commentIdParamSchema, taskIdParamSchema } from "@estuary/contracts";

import { commentNotFound, taskNotFound } from "./errors.js";

/**
 * Path-parameter parsing, and the one rule that makes it worth its own module:
 * **a malformed id is a 404, not a 422.**
 *
 * `/tasks/abc` and `/tasks/999999` must be indistinguishable to a caller
 * (`docs/engineering/API_ERROR_CONTRACT.md` § Status conventions). A 422 on the
 * first and a 404 on the second tells a prober which ids are well-formed, and it
 * leaks the shape of the key space for no benefit — the client cannot act on the
 * difference either way.
 *
 * So the parse failure is swallowed here and re-thrown as the resource's own
 * not-found error, rather than being allowed to reach `errorHandler` as a
 * `ZodError` (which would become `VALIDATION_ERROR` 422). This is the **only**
 * place in the API where a zod failure is deliberately not a 422.
 *
 * The schemas themselves are decimal-digits-only, not `z.coerce.number()` — see
 * `packages/contracts/src/task.ts`. Loosening them would serve task 42 under
 * `/tasks/0x2a`, `/tasks/1e3`, and `/tasks/%2012%20`, and would disagree
 * with `parseReference()`, the other parser that turns user input into an id.
 */

/**
 * `:taskId` → a positive integer, or `TASK_NOT_FOUND` (404).
 *
 * The parameter is typed `unknown` rather than `string`. Express 5 types
 * `req.params[k]` as `string | string[] | undefined`, and the array case is real
 * — a router mounted with `mergeParams` under a path that names the same
 * parameter twice yields one. Narrowing with a cast would make that case a
 * `TypeError` inside zod; handing it to the schema makes it an ordinary 404,
 * which is what a caller who sent a nonsense path should get.
 */
export const parseTaskId = (raw: unknown): number => {
  const parsed = taskIdParamSchema.safeParse(raw);
  if (!parsed.success) throw taskNotFound();
  return parsed.data;
};

/** `:commentId` → a positive integer, or `COMMENT_NOT_FOUND` (404). Typed as above. */
export const parseCommentId = (raw: unknown): number => {
  const parsed = commentIdParamSchema.safeParse(raw);
  if (!parsed.success) throw commentNotFound();
  return parsed.data;
};
