import { randomUUID } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

/**
 * Attaches a request id to every request: the incoming `x-request-id` when a
 * proxy or a client supplied one, otherwise a fresh uuid.
 *
 * It is echoed on the response header **and** embedded in `error.requestId`, so
 * "request 8f2c-… failed" is enough to find the stack in the server log without
 * anything sensitive crossing the wire. See
 * `docs/engineering/API_ERROR_CONTRACT.md`.
 *
 * This is the first middleware in the chain on purpose: the body parser can
 * fail, and a `MALFORMED_JSON` response still has to carry an id.
 */

export const REQUEST_ID_HEADER = "x-request-id";

/** Long enough for a uuid or a trace id, short enough not to be a log-injection vector. */
const MAX_INCOMING_LENGTH = 128;

/** Printable ASCII without whitespace — a header value must not smuggle CR/LF. */
const SAFE_ID = /^[\x21-\x7e]+$/;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Always set — `requestId` middleware runs before everything else. */
      requestId: string;
    }
  }
}

const fromHeader = (value: unknown): string | null => {
  // A repeated header arrives as an array; take the first and ignore the rest.
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;

  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INCOMING_LENGTH) return null;
  if (!SAFE_ID.test(trimmed)) return null;

  return trimmed;
};

export const requestId = (req: Request, res: Response, next: NextFunction): void => {
  const id = fromHeader(req.headers[REQUEST_ID_HEADER]) ?? randomUUID();

  req.requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);

  next();
};

/**
 * Reads the id off a request without asserting the middleware ran. Used by the
 * error handler, which must produce a valid envelope even if it is reached from
 * a path where the chain was assembled wrongly.
 */
export const getRequestId = (req: Request): string =>
  typeof req.requestId === "string" && req.requestId.length > 0 ? req.requestId : "unknown";
