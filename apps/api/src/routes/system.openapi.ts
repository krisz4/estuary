import { z } from "zod";

import {
  INTERNAL_ERROR_RESPONSE,
  defaultErrorResponse,
  errorResponse,
  registry,
} from "../lib/openapi.js";

/**
 * OpenAPI definitions for the two things that are not a resource: the health
 * probe, and what the API does with a request that matches nothing.
 */

/**
 * `GET /health` is the one response shape with no schema in
 * `packages/contracts`, and deliberately so — no client consumes it, only Docker
 * and a human with `curl`. Putting it in the shared contracts package would put
 * a shape in the browser bundle that the browser has no use for.
 *
 * It is therefore the one place the spec could drift from the handler without a
 * schema binding them, so `routes/openapi.contract.test.ts` issues a real
 * request and parses the response through **this** schema.
 *
 * Safe at module scope: it is a plain zod object, with none of the internals
 * reading that keeps the rest of the spec layer inside functions.
 */
export const healthResponseSchema = z
  .object({
    status: z.literal("ok"),
    uptime: z.number().nonnegative().meta({ description: "Process uptime in seconds." }),
    timestamp: z.iso.datetime(),
  })
  .strict()
  .meta({ id: "HealthResponse" });

/**
 * Registers the health probe and the catch-all. A function rather than an import
 * side effect, for the reason given at the top of `tickets.openapi.ts`.
 */
export function registerSystemPaths(): void {
  registry.registerPath({
    method: "get",
    path: "/health",
    tags: ["System"],
    summary: "Liveness probe",
    description:
      'Sits at the root, **outside** /api/v1, because the Docker healthcheck hits it and a versioned health endpoint would have to move the day the version does. It touches no database on purpose: it answers "is the process up", not "is the data reachable".',
    responses: {
      200: {
        description: "The process is up.",
        content: { "application/json": { schema: healthResponseSchema } },
      },
      500: INTERNAL_ERROR_RESPONSE,
      default: defaultErrorResponse,
    },
  });

  /**
   * The catch-all, documented as a path because it is real behaviour a client
   * will meet and OpenAPI has nowhere else to put it.
   *
   * It is also the only home for `NOT_FOUND`. That code comes from the
   * `notFound` middleware rather than from any handler, so no operation above
   * can honestly list it — `GET /api/v1/tickets` cannot return `NOT_FOUND`, and
   * claiming it could would be exactly the kind of plausible-but-false line a
   * generated spec exists to avoid. `routes/openapi.contract.test.ts` knows this
   * path is synthetic and excludes it from the "documented paths equal mounted
   * routes" comparison.
   */
  registry.registerPath({
    method: "get",
    path: "/api/v1/{unmatchedPath}",
    tags: ["System"],
    summary: "Anything the API does not implement",
    description:
      "Any path or verb with no route — including a verb this spec does not list on a path it does — falls through to a 404 NOT_FOUND in the standard envelope. Express does not generate 405s, so an unimplemented verb is a 404, not a METHOD_NOT_ALLOWED.",
    request: {
      params: z.object({
        unmatchedPath: z.string().meta({ description: "Any unmatched path segment." }),
      }),
    },
    responses: {
      404: errorResponse("No route matches this path and verb.", ["NOT_FOUND"]),
      500: INTERNAL_ERROR_RESPONSE,
      default: defaultErrorResponse,
    },
  });
}
