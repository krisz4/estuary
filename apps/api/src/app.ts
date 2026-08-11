import cors from "cors";
import express, { type Express, type Request, type Response } from "express";

import { env } from "./lib/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFound } from "./middleware/notFound.js";
import { requestId } from "./middleware/requestId.js";
import { commentsRouter } from "./routes/comments.route.js";
import { ticketsRouter } from "./routes/tickets.route.js";

/**
 * The API version prefix. `GET /health` deliberately sits outside it, at the
 * root, because a Docker healthcheck should not have to move the day the version
 * does.
 */
export const API_V1 = "/api/v1";

/**
 * Express application **factory**. It does not call `listen()` — `server.ts`
 * does, and supertest imports this directly. That seam is what lets the whole
 * middleware chain be tested without binding a port (see
 * `docs/engineering/ARCHITECTURE.md` § Testing seams).
 *
 * The chain, in order, and the order is load-bearing:
 *
 * ```
 *   requestId    →  every response, including a body-parser failure, carries an id
 *   cors         →  ALLOWED_ORIGINS
 *   json         →  BODY_LIMIT; failures surface as entity.parse.failed / entity.too.large
 *   routers      →  /health at the root, /api/v1/tickets(/…/comments) below it
 *   notFound     →  unmatched path or verb → NOT_FOUND 404
 *   errorHandler →  the single exit for every failure
 * ```
 *
 * **`cors` precedes `json`, and that is the load-bearing part.** When the JSON
 * parser rejects a body it calls `next(err)`, which skips every remaining
 * non-error middleware — so with `cors` mounted after it, `MALFORMED_JSON` and
 * `PAYLOAD_TOO_LARGE` go out with no `Access-Control-Allow-Origin` header at
 * all. The browser then rejects them as opaque network errors: the web client
 * never sees the code, and cannot read `x-request-id` off the response either.
 * A ticket description over `BODY_LIMIT` is the realistic way a user hits this.
 *
 * `docs/engineering/ARCHITECTURE.md` and the implementation plan originally
 * specified the opposite order; both were corrected in stage 4 once the
 * consequence was demonstrated.
 *
 * Express 5 forwards a rejected promise from an async handler to the error
 * chain on its own, so there is no `express-async-handler` package here. Route
 * handlers still go through the local one-line `asyncHandler()`
 * (`lib/asyncHandler.ts`) — explicit at the call site, and correct if the
 * framework is ever downgraded.
 */
export function createApp(): Express {
  const app = express();

  // Nothing gains from advertising the framework.
  app.disable("x-powered-by");
  // `/tickets` and `/tickets/` are the same resource.
  app.set("strict routing", false);

  app.use(requestId);

  app.use(
    cors({
      origin: env.ALLOWED_ORIGINS,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "x-request-id"],
      // Without this the browser cannot read the id off a failed response, so a
      // user cannot quote it back.
      exposedHeaders: ["x-request-id"],
      maxAge: 86400,
    }),
  );

  app.use(express.json({ limit: env.BODY_LIMIT }));

  /**
   * Liveness probe. It sits at the **root**, outside `/api/v1`, because the
   * Docker healthcheck hits it and a versioned health endpoint would have to
   * move the day the version does. It touches no database on purpose: it
   * answers "is the process up", not "is the data reachable".
   */
  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({
      status: "ok",
      uptime: Math.round(process.uptime() * 1000) / 1000,
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * `/api/v1`, mounted between the parser and `notFound` because that window is
   * the only place a router keeps both halves of the contract: a request id
   * (assigned above) and the error envelope (written below).
   *
   * The comment router is mounted at its own absolute path rather than nested
   * inside `ticketsRouter`, so the two files stay independent of each other and
   * the full URL of every endpoint is readable here. Order between the two does
   * not matter — `ticketsRouter` declares nothing that matches a three-segment
   * path — but comments are listed first so the more specific mount reads first.
   */
  app.use(`${API_V1}/tickets/:ticketId/comments`, commentsRouter);
  app.use(`${API_V1}/tickets`, ticketsRouter);

  if (env.NODE_ENV === "test") mountDiagnosticRoutes(app);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

/**
 * Routes that exist only to prove the error chain works, mounted **only** under
 * `NODE_ENV=test`.
 *
 * The alternative — asserting the 500 path by monkey-patching a real route —
 * tests the patch rather than the chain, and the alternative after that is
 * having no test for the single most important guarantee in the error contract
 * (that a 500 leaks nothing). Both variants are here because a sync `throw` and
 * a rejected promise take different paths through Express 5.
 */
function mountDiagnosticRoutes(app: Express): void {
  app.get("/__test__/boom", () => {
    throw new Error("boom: synchronous failure with a stack trace in it");
  });

  app.get("/__test__/boom-async", async () => {
    await Promise.resolve();
    throw new Error("boom: rejected promise with a stack trace in it");
  });
}
