import { EVENTS_DEFAULT_LIMIT, EVENTS_MAX_LIMIT, eventsQuerySchema } from "@estuary/contracts";
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
  before:
    "Cursor: return only events with an id less than this — paging backwards with order=desc. Send the meta.nextBefore of the previous response.",
  order:
    "asc (default) is the poller's order, oldest first, paged with after. desc is the Logbook's: newest first, paged with before=meta.nextBefore.",
  from: "Only events recorded at or after this instant (inclusive).",
  to: "Only events recorded before this instant (exclusive).",
  taskId: "Only events about this task — including ones recorded after it was deleted.",
  project:
    "Only events of tasks in any of these projects, as recorded on the event at the time — so a task moved or deleted afterwards is still found under the project it had when the event happened. Repeatable, ORed together.",
  actor: "Exact actor that recorded the event, lowercased like the stored value.",
  type: "Only these event types. Repeatable, ORed together.",
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
      "Every write appends an event — task.created/updated/deleted/status_changed/claimed/released, comment.created/deleted, decision.requested/answered/withdrawn, dependency.added/removed, github.pull_request — in the same transaction as the change.",
      "",
      "Oldest first by default, cursor-paged rather than page/pageSize: the feed grows while it is read, and an offset would shift under a poller and skip events. Poll with `after=<meta.nextAfter>`; when nothing happened, nextAfter echoes the cursor back.",
      "",
      "`order=desc` pages newest-first instead, with `before=<meta.nextBefore>` for the next (older) page — the Logbook's event log. `from`/`to` narrow to an instant range (`from` inclusive, `to` exclusive).",
      "",
      "Events are never deleted, and `taskId` is not a foreign key, so the feed still describes deleted tasks. Each event carries `project` — the task's project *when the event was recorded* — which is how `?project=` still finds it afterwards.",
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
