import cors from "cors";
import express, { type Express, type Request, type Response, type Router } from "express";

import { env } from "./lib/env.js";
import { actor } from "./middleware/actor.js";
import { apiToken } from "./middleware/apiToken.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFound } from "./middleware/notFound.js";
import { requestId } from "./middleware/requestId.js";
import { commentsRouter } from "./routes/comments.route.js";
import { createDocsRouter } from "./routes/docs.route.js";
import { eventsRouter } from "./routes/events.route.js";
import { floorRouter } from "./routes/floor.route.js";
import { githubRouter, githubWebhookRouter, taskGithubRouter } from "./routes/github.route.js";
import { historyRouter } from "./routes/history.route.js";
import { tasksRouter } from "./routes/tasks.route.js";

/**
 * The API version prefix. `GET /health` deliberately sits outside it, at the
 * root, because a Docker healthcheck should not have to move the day the version
 * does.
 */
export const API_V1 = "/api/v1";

/** Where Swagger UI lives when `DOCS_ENABLED` is true. */
export const DOCS_PATH = "/docs";

/**
 * The resource routers and the paths they are mounted at, as **data**.
 *
 * `createApp()` walks this list, which means the mount prefixes exist exactly
 * once — and it means the set of routes the application actually serves can be
 * enumerated by something other than the application. `routes/openapi.contract.test.ts`
 * does exactly that, comparing the mounted routes against the documented paths,
 * so a route added without a spec entry fails the run.
 *
 * Express 5 does not expose a mounted router's prefix (`layer.path` is
 * `undefined` and the match is a compiled function), so introspecting `app`
 * after the fact cannot recover these strings. Declaring them once, here, is the
 * alternative to a second hand-maintained copy in the test.
 *
 * Order between the two does not matter — `tasksRouter` declares nothing that
 * matches a three-segment path — but comments are listed first so the more
 * specific mount reads first.
 *
 * `githubWebhookRouter` is listed here too, even though `createApp()` mounts
 * it **separately and earlier** (before `apiToken` and `actor` — GitHub can
 * send neither). Listing it is what keeps it visible to
 * `routes/openapi.contract.test.ts`, which walks this array to find every
 * route the app is supposed to document; `createApp()` skips mounting it a
 * second time here.
 */
export const ROUTER_MOUNTS: readonly { path: string; router: Router }[] = [
  { path: `${API_V1}/tasks/:taskId/comments`, router: commentsRouter },
  { path: `${API_V1}/tasks`, router: tasksRouter },
  { path: `${API_V1}/tasks`, router: taskGithubRouter },
  { path: `${API_V1}/events`, router: eventsRouter },
  { path: `${API_V1}/floor`, router: floorRouter },
  { path: `${API_V1}/stats/history`, router: historyRouter },
  { path: `${API_V1}/integrations/github`, router: githubRouter },
  { path: `${API_V1}/integrations/github/webhook`, router: githubWebhookRouter },
];

/**
 * Express application **factory**. It does not call `listen()` — `server.ts`
 * does, and supertest imports this directly. That seam is what lets the whole
 * middleware chain be tested without binding a port (see
 * `docs/engineering/ARCHITECTURE.md` § Testing seams).
 *
 * The chain, in order, and the order is load-bearing:
 *
 * ```
 *   requestId       →  every response, including a body-parser failure, carries an id
 *   cors            →  ALLOWED_ORIGINS
 *   githubWebhook   →  /api/v1/integrations/github/webhook only; its own express.raw(),
 *                       authenticated by HMAC signature — no apiToken, no actor
 *   json            →  BODY_LIMIT; failures surface as entity.parse.failed / entity.too.large
 *   apiToken        →  /api/v1 only, and only when API_TOKEN is set → UNAUTHORIZED
 *   actor           →  /api/v1 only; X-Actor → req.actor, malformed → VALIDATION_ERROR
 *   routers         →  /health at the root, the rest of ROUTER_MOUNTS below /api/v1
 *   notFound        →  unmatched path or verb → NOT_FOUND 404
 *   errorHandler    →  the single exit for every failure
 * ```
 *
 * **The webhook router sits before `json`, and that is load-bearing too.**
 * GitHub signs the exact bytes it sends; `express.json()` would already have
 * parsed and re-serialized the body by the time a route saw it, and
 * re-serializing JSON is not guaranteed to reproduce the same bytes (key
 * order, whitespace, number formatting). The webhook route parses its own body
 * with `express.raw()`, checks the signature against those raw bytes, and only
 * then `JSON.parse`s it. It also runs before `apiToken` and `actor`: GitHub can
 * send neither a bearer token nor `X-Actor`, and the signature is the whole of
 * its authentication.
 *
 * **`cors` precedes `json`, and that is the load-bearing part.** When the JSON
 * parser rejects a body it calls `next(err)`, which skips every remaining
 * non-error middleware — so with `cors` mounted after it, `MALFORMED_JSON` and
 * `PAYLOAD_TOO_LARGE` go out with no `Access-Control-Allow-Origin` header at
 * all. The browser then rejects them as opaque network errors: the web client
 * never sees the code, and cannot read `x-request-id` off the response either.
 * A task description over `BODY_LIMIT` is the realistic way a user hits this.
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
  // `/tasks` and `/tasks/` are the same resource.
  app.set("strict routing", false);

  app.use(requestId);

  app.use(
    cors({
      origin: env.ALLOWED_ORIGINS,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "x-request-id", "x-actor", "authorization"],
      // Without this the browser cannot read the id off a failed response, so a
      // user cannot quote it back.
      exposedHeaders: ["x-request-id"],
      maxAge: 86400,
    }),
  );

  /**
   * The one route mounted before the JSON parser, so its handler sees the raw
   * body bytes rather than a parsed-and-reconstructed one. See `WEBHOOK_PATH`
   * in `services/github.service.ts` for where this string comes from — it is
   * repeated literally here rather than imported so this mount cannot end up
   * pointed anywhere but exactly where the ROUTER_MOUNTS entry below expects.
   */
  app.use(`${API_V1}/integrations/github/webhook`, githubWebhookRouter);

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
   * inside `tasksRouter`, so the two files stay independent of each other and
   * the full URL of every endpoint is readable from `ROUTER_MOUNTS` above.
   */
  if (env.API_TOKEN !== undefined) app.use(API_V1, apiToken(env.API_TOKEN));
  app.use(API_V1, actor);

  for (const mount of ROUTER_MOUNTS) {
    // Mounted separately, above, before the JSON parser and the token/actor
    // gate — mounting it again here would register it twice.
    if (mount.router === githubWebhookRouter) continue;
    app.use(mount.path, mount.router);
  }

  /**
   * Swagger UI. Outside `/api/v1` because it documents the API rather than being
   * part of it, and behind `DOCS_ENABLED` so it can be turned off without a code
   * change — the flag is the whole of the switch, and when it is false the
   * document is never generated and `/docs` is an ordinary 404 `NOT_FOUND`.
   */
  if (env.DOCS_ENABLED) app.use(DOCS_PATH, createDocsRouter());

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
