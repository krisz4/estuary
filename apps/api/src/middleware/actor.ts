import { ACTOR_HEADER, ANONYMOUS_ACTOR, actorSchema } from "@estuary/contracts";
import type { NextFunction, Request, Response } from "express";

import { validationError } from "../lib/errors.js";

/**
 * Resolves `X-Actor` into `req.actor` — who this request acts as.
 *
 * Attribution, not authentication (`docs/features/Actors.md`): the header is
 * self-declared and nothing verifies it. What this middleware guarantees is only
 * that every write downstream has a **well-formed** actor to record, so the
 * services take it as a plain argument and never look at a header.
 *
 * - Absent → `human:anonymous`. The web app sends a name once the viewer sets
 *   one; a curl without the header still works.
 * - Malformed → `VALIDATION_ERROR` with `details["X-Actor"]`. Silently falling
 *   back to anonymous would hide an agent's misconfiguration behind a timeline
 *   full of "anonymous" — the one thing the header exists to prevent.
 * - `system:…` is rejected by `actorSchema`; only the server writes as system.
 *
 * Runs on every `/api/v1` request, reads included, so a bad header fails the
 * same way on a GET as on the POST that would have recorded it.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by the `actor` middleware on every `/api/v1` request. */
      actor: string;
    }
  }
}

const HEADER_KEY = ACTOR_HEADER.toLowerCase();

export const actor = (req: Request, _res: Response, next: NextFunction): void => {
  const raw = req.headers[HEADER_KEY];
  const value = Array.isArray(raw) ? raw[0] : raw;

  if (value === undefined || value.trim() === "") {
    req.actor = ANONYMOUS_ACTOR;
    next();
    return;
  }

  const parsed = actorSchema.safeParse(value);
  if (!parsed.success) {
    next(
      validationError(
        { [ACTOR_HEADER]: parsed.error.issues.map((issue) => issue.message) },
        `Invalid ${ACTOR_HEADER} header`,
      ),
    );
    return;
  }

  req.actor = parsed.data;
  next();
};
