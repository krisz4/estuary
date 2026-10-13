import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getAgentConnections, getReadiness } from "../services/system.service.js";
export const systemRouter: Router = Router();
systemRouter.get("/agents", (_req, res) => res.json(getAgentConnections()));
systemRouter.get(
  "/ready",
  asyncHandler(async (_req, res) => res.json(await getReadiness())),
);
