import type { NextFunction, Request, Response } from "express";

import { ApiError } from "../lib/errors.js";

/**
 * Terminal handler for any path (or verb) no router matched.
 *
 * It **throws into the error handler** rather than writing a body, so an
 * unknown route produces exactly the same envelope as every other failure —
 * `NOT_FOUND` 404 with a `requestId`. That is also why the contract has no
 * `METHOD_NOT_ALLOWED`: Express does not generate one, and an unmatched verb
 * simply arrives here.
 *
 * Mounted after all routers and before `errorHandler`.
 */
/**
 * The path is echoed back in the message, so it is truncated and stripped of
 * control characters first. It is JSON-encoded on the way out, and the web
 * client keys its copy off `code` rather than rendering `message` — but a
 * caller-controlled string in a response deserves the bound anyway.
 */
const MAX_PATH_IN_MESSAGE = 120;

const safePath = (path: string): string =>
  // eslint-disable-next-line no-control-regex
  path.replace(/[\x00-\x1f\x7f]/g, "").slice(0, MAX_PATH_IN_MESSAGE);

export const notFound = (req: Request, _res: Response, next: NextFunction): void => {
  next(new ApiError("NOT_FOUND", `Cannot ${req.method} ${safePath(req.path)}`));
};
