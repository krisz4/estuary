import { EVENTS_DEFAULT_LIMIT, EVENTS_MAX_LIMIT, eventsQuerySchema } from "@helpdesk/contracts";
import type { z } from "zod";

import {
  ACTOR_422_NOTE,
  EventsResponseComponent,
  describeQueryParams,
  errorResponse,
  registerV1Path,
  unwrapPreprocessedObject,
} from "../lib/openapi.js";

/**
 * OpenAPI definitions for `routes/events.route.ts` — the change feed.
 *
 * A function rather than an import side effect, for the reason given at the top
 * of `tasks.openapi.ts`: the query unwrap reads zod internals, and nothing in
 * the spec layer may run while `app.ts` is still loading its import graph.
 */

export const EVENTS_QUERY_DESCRIPTIONS: Record<string, string> = {
  after:
    "Cursor: return only events with an id greater than this. Send the meta.nextAfter of the previous response; omit (or 0) to start from the beginning.",
  taskId: "Only events about this task — including ones recorded after it was deleted.",
  limit: `Events per page, 1–${EVENTS_MAX_LIMIT}, default ${EVENTS_DEFAULT_LIMIT}. meta.hasMore says whether another page is waiting.`,
};

export const buildEventsQueryParams = (): z.ZodObject =>
  describeQueryParams(unwrapPreprocessedObject(eventsQuerySchema), EVENTS_QUERY_DESCRIPTIONS);

/** Registers the feed. Called once, by `getOpenApiDocument()`. */
export function registerEventPaths(): void {
  registerV1Path({
    method: "get",
    path: "/api/v1/events",
    tags: ["Events"],
    summary: "Read the change feed",
    description: [
      "Every write appends an event — task.created/updated/deleted/status_changed/claimed/released, comment.created/deleted, decision.requested/answered/withdrawn, dependency.added/removed — in the same transaction as the change.",
      "",
      "Oldest first, cursor-paged rather than page/pageSize: the feed grows while it is read, and an offset would shift under a poller and skip events. Poll with `after=<meta.nextAfter>`; when nothing happened, nextAfter echoes the cursor back.",
      "",
      "Events are never deleted, and `taskId` is not a foreign key, so the feed still describes deleted tasks.",
    ].join("\n"),
    request: { query: buildEventsQueryParams() },
    responses: {
      200: {
        description: "A page of events and the cursor to poll from next.",
        content: { "application/json": { schema: EventsResponseComponent } },
      },
      422: errorResponse(
        `An unknown parameter, a cursor or taskId that is not decimal digits, or a limit out of range. ${ACTOR_422_NOTE}`,
        ["VALIDATION_ERROR"],
      ),
    },
  });
}
