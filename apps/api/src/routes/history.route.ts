import { historyQuerySchema } from "@estuary/contracts";
import { Router } from "express";

import { asyncHandler } from "../lib/asyncHandler.js";
import { getTaskHistory } from "../services/history.service.js";

/**
 * `/api/v1/stats/history` — the Logbook's charts. Read-only.
 * `docs/features/History_Stats.md`.
 */

export const historyRouter: Router = Router();

historyRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = historyQuerySchema.parse(req.query);
    res.status(200).json(await getTaskHistory(query));
  }),
);
