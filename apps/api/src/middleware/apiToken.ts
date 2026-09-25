import { timingSafeEqual } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

import { unauthorized } from "../lib/errors.js";

/**
 * The optional shared-secret gate for self-hosted deployments.
 *
 * With no token configured this is not mounted at all — `createApp()` decides —
 * so localhost development has no auth code on its path. With one, every
 * `/api/v1` request must present `Authorization: Bearer <token>`.
 *
 * `timingSafeEqual` over equal-length buffers: a plain `===` returns faster the
 * earlier the first wrong character is, which is enough to recover a token byte
 * by byte from response timing on a quiet network. The length check leaks only
 * the length, which a 16-character minimum makes uninteresting.
 */
export const apiToken = (token: string) => {
  const expected = Buffer.from(token, "utf8");

  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    const match = typeof header === "string" ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
    const presented = Buffer.from(match?.[1] ?? "", "utf8");

    const ok = presented.length === expected.length && timingSafeEqual(presented, expected);
    next(ok ? undefined : unauthorized());
  };
};
