import { eventsQuerySchema } from "@helpdesk/contracts";
import { Router } from "express";

import { asyncHandler } from "../lib/asyncHandler.js";
import { listEvents } from "../services/task-events.js";

/**
 * `/api/v1/events` — the change feed. Read-only; events are written by the
 * services, in the same transaction as the change they describe.
 *
 * Cursor-paged rather than `page`/`pageSize` — see `eventsQuerySchema` in
 * contracts for why an offset page is wrong for a feed that grows while read.
 */

export const eventsRouter: Router = Router();

eventsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = eventsQuerySchema.parse(req.query);
    res.status(200).json(await listEvents(query));
  }),
);
