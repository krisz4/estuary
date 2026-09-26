import { floorQuerySchema } from "@helpdesk/contracts";
import { Router } from "express";

import { asyncHandler } from "../lib/asyncHandler.js";
import { getFloorSnapshot } from "../services/floor.service.js";

/**
 * `/api/v1/floor` — one compact snapshot for the floor view. Read-only.
 * `docs/features/Floor_Snapshot.md`.
 */

export const floorRouter: Router = Router();

floorRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = floorQuerySchema.parse(req.query);
    res.status(200).json(await getFloorSnapshot(query));
  }),
);
