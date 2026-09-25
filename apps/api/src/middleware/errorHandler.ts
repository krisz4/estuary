import { type ApiErrorBody, type ApiErrorCode, API_ERROR_STATUS } from "@helpdesk/contracts";
import type { NextFunction, Request, Response } from "express";
import type { ZodError } from "zod";

import { ApiError, isZodError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { getRequestId } from "./requestId.js";

/**
 * The **single exit path for every failure**. Nothing else in the codebase
 * writes an error body — see `docs/features/Error_Handling.md`.
 *
 * | Thrown | Becomes |
 * | ------ | ------- |
 * | `ApiError` | its own code + status |
 * | `ZodError` | `VALIDATION_ERROR` 422 with flattened field errors |
 * | body-parser `entity.parse.failed` | `MALFORMED_JSON` 400 |
 * | body-parser `entity.too.large` | `PAYLOAD_TOO_LARGE` 413 |
 * | Prisma `P2025` | `NOT_FOUND` 404 (a backstop, not the intended route) |
 * | anything else | `INTERNAL_ERROR` 500, generic message, stack to the log only |
 *
 * The two body-parser rows are handled here rather than being retrofitted once
 * routes exist: they are `http-errors` instances carrying a `type` string, they
 * never reach a route handler, and without them malformed JSON returns 500
 * while the contract advertises 400.
 */

interface Resolved {
  code: ApiErrorCode;
  message: string;
  details?: unknown;
}

/** `err.type` is what body-parser signals with — never branch on its message. */
const bodyParserType = (err: unknown): string | null => {
  if (typeof err !== "object" || err === null) return null;
  const type = (err as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
};

/**
 * Duck-typed rather than `instanceof PrismaClientKnownRequestError`, so
 * `middleware/` does not import the generated Prisma client (see the layer
 * table in `docs/engineering/ARCHITECTURE.md`).
 */
const prismaErrorCode = (err: unknown): string | null => {
  if (typeof err !== "object" || err === null) return null;
  const { code, clientVersion } = err as { code?: unknown; clientVersion?: unknown };
  return typeof code === "string" && typeof clientVersion === "string" ? code : null;
};

/** zod's flattened field errors, in the `Record<field, string[]>` shape the contract pins. */
const zodDetails = (err: ZodError): Record<string, string[]> => {
  const details: Record<string, string[]> = {};

  for (const issue of err.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "_";
    (details[key] ??= []).push(issue.message);
  }

  return details;
};

const resolve = (err: unknown): Resolved => {
  if (err instanceof ApiError) {
    return err.details === undefined
      ? { code: err.code, message: err.message }
      : { code: err.code, message: err.message, details: err.details };
  }

  if (isZodError(err)) {
    return {
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
      details: zodDetails(err),
    };
  }

  switch (bodyParserType(err)) {
    case "entity.parse.failed":
      return { code: "MALFORMED_JSON", message: "Request body is not valid JSON" };
    case "entity.too.large":
      return { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" };
  }

  // Backstop only. Services check existence explicitly and throw the specific
  // 404, because this handler has no way to tell a missing task from a
  // missing comment.
  if (prismaErrorCode(err) === "P2025") {
    return { code: "NOT_FOUND", message: "Resource not found" };
  }

  // Deliberately generic: no stack, no SQL, no file paths, no Prisma text.
  return { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again" };
};

export const errorHandler = (
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  // Streaming already started — the status line is long gone, so the only
  // correct move is to let Express destroy the socket.
  if (res.headersSent) {
    next(err);
    return;
  }

  const requestId = getRequestId(req);
  const resolved = resolve(err);
  const status = API_ERROR_STATUS[resolved.code];

  const body: ApiErrorBody = {
    code: resolved.code,
    message: resolved.message,
    requestId,
  };
  if (resolved.details !== undefined) body.details = resolved.details;

  const context = {
    requestId,
    method: req.method,
    path: req.path,
    status,
    code: resolved.code,
  };

  if (status >= 500) {
    // The stack goes here and only here, keyed by the same id the client sees.
    logger.error("Unhandled error", { ...context, err });
  } else {
    logger.debug("Request failed", context);
  }

  res.status(status).json({ error: body });
};
