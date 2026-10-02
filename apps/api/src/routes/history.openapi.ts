import { HISTORY_BUCKETS, HISTORY_MAX_BUCKETS, historyQuerySchema } from "@estuary/contracts";
import type { z } from "zod";

import {
  ACTOR_422_NOTE,
  HistoryResponseComponent,
  describeQueryParams,
  errorResponse,
  registerV1Path,
  unwrapPreprocessedObject,
} from "../lib/openapi.js";

/**
 * OpenAPI definitions for `routes/history.route.ts`. See
 * `docs/features/History_Stats.md`.
 *
 * A function rather than an import side effect — see the note at the top of
 * `tasks.openapi.ts`.
 */

export const HISTORY_QUERY_DESCRIPTIONS: Record<string, string> = {
  project:
    "Repeatable. Scope to these projects, as recorded on each event; omit for every project.",
  from: `Range start (instant, inclusive). Defaults to 7 days before \`to\`. Floored to the start of its bucket boundary — the response echoes back the aligned value.`,
  to: "Range end (instant, exclusive). Defaults to now. Ceiled to the next bucket boundary.",
  bucket: `hour, day, or week (Monday-starting), default day. The aligned range must not produce more than ${HISTORY_MAX_BUCKETS} buckets.`,
};

export const buildHistoryQueryParams = (): z.ZodObject =>
  describeQueryParams(unwrapPreprocessedObject(historyQuerySchema), HISTORY_QUERY_DESCRIPTIONS);

/** Registers `GET /stats/history`. Called once, by `getOpenApiDocument()`. */
export function registerHistoryPaths(): void {
  registerV1Path({
    method: "get",
    path: "/api/v1/stats/history",
    tags: ["Logbook"],
    summary: "History and charts for the Logbook",
    description: [
      "Everything the Logbook's charts need, computed from TaskEvent: per-bucket created/completed/deferred/sent-back counts and a status snapshot at the bucket's end (the cumulative flow diagram), human-wait and cycle-time percentiles, the ten longest human waits, up to 500 recent cycle times, and per-agent activity.",
      "",
      `\`bucket\` is one of ${HISTORY_BUCKETS.join(", ")}. The response's \`from\`/\`to\` are the *aligned* boundaries — floored/ceiled to whole buckets — not the raw query params, and every count in the response covers exactly that aligned range.`,
      "",
      "Status snapshots (per bucket and for the longest-wait / cycle-time lookups) are a full replay of `task.status_changed` events from the beginning of the log, not just the requested window — an old task already `done` before `from` still counts in every bucket's `done` column.",
    ].join("\n"),
    request: { query: buildHistoryQueryParams() },
    responses: {
      200: {
        description: "The charts.",
        content: { "application/json": { schema: HistoryResponseComponent } },
      },
      422: errorResponse(
        `An unknown parameter, an inverted range (\`to\` at or before \`from\`), or a range producing more than ${HISTORY_MAX_BUCKETS} buckets. ${ACTOR_422_NOTE}`,
        ["VALIDATION_ERROR"],
      ),
    },
  });
}
