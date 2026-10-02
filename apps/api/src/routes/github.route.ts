import { githubImportInputSchema } from "@estuary/contracts";
import express, { Router } from "express";

import { asyncHandler } from "../lib/asyncHandler.js";
import { malformedJson } from "../lib/errors.js";
import { parseTaskId } from "../lib/params.js";
import {
  assertValidWebhookRequest,
  getIntegrationStatus,
  getTaskGithubStatus,
  importGithubIssue,
  processGithubWebhook,
} from "../services/github.service.js";

/**
 * `/api/v1/integrations/github` and `/api/v1/tasks/:taskId/github` — the HTTP
 * layer for the optional GitHub integration
 * (`docs/features/GitHub_Integration.md`).
 *
 * Three routers, because the webhook needs a body-parsing and authentication
 * story none of the others share:
 *
 * - {@link githubRouter} — status and issue import. Ordinary `/api/v1`
 *   requests: JSON body, `X-Actor`, the optional bearer gate.
 * - {@link githubWebhookRouter} — GitHub calls this itself, so it can send
 *   neither the bearer token nor `X-Actor`. `app.ts` mounts it **before**
 *   both of those middlewares, with its own `express.raw()` so the HMAC check
 *   runs against the exact bytes GitHub signed.
 * - {@link taskGithubRouter} — `GET /tasks/:taskId/github`. A separate router
 *   rather than a new route on `tasks.route.ts`, which this change does not
 *   touch; mounted at the same `/api/v1/tasks` prefix as `tasksRouter` and
 *   reached only when nothing there matches.
 */

export const githubRouter: Router = Router();

/** `GET /integrations/github` — reachable even when the integration is off. */
githubRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.status(200).json(getIntegrationStatus());
  }),
);

/** `POST /integrations/github/import` — turn a GitHub issue into a task. */
githubRouter.post(
  "/import",
  asyncHandler(async (req, res) => {
    const input = githubImportInputSchema.parse(req.body);
    const { task, created } = await importGithubIssue(input, req.actor);

    res
      .status(created ? 201 : 200)
      .location(`/api/v1/tasks/${task.id}`)
      .json(task);
  }),
);

export const taskGithubRouter: Router = Router();

/** `GET /tasks/:taskId/github` — live status of every GitHub link on the task. */
taskGithubRouter.get(
  "/:taskId/github",
  asyncHandler(async (req, res) => {
    const id = parseTaskId(req.params.taskId);
    res.status(200).json(await getTaskGithubStatus(id));
  }),
);

export const githubWebhookRouter: Router = Router();

/**
 * `POST /integrations/github/webhook` — mounted by `app.ts` **before** the
 * `apiToken` and `actor` middlewares, so it authenticates itself: the HMAC
 * signature is the whole of the gate. `express.raw()` here, not the global
 * `express.json()` mounted later, is what makes the signature check run
 * against the exact bytes GitHub signed.
 */
githubWebhookRouter.post(
  "/",
  express.raw({ type: "application/json" }),
  asyncHandler(async (req, res) => {
    const raw = req.body instanceof Buffer ? req.body : Buffer.alloc(0);
    assertValidWebhookRequest(raw, req.header("x-hub-signature-256"));

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8")) as unknown;
    } catch {
      throw malformedJson();
    }

    const eventName = req.header("x-github-event") ?? "";
    const deliveryId = req.header("x-github-delivery") ?? "";

    const result = await processGithubWebhook({ name: eventName, deliveryId, payload });
    res.status(result.status).json(result.body);
  }),
);
