import {
  githubImportInputSchema,
  githubIntegrationStatusSchema,
  taskGithubStatusSchema,
  taskIdParamSchema,
} from "@helpdesk/contracts";
import { z } from "zod";

import {
  ACTOR_422_NOTE,
  INTERNAL_ERROR_RESPONSE,
  TaskComponent,
  bodyParserResponses,
  defaultErrorResponse,
  errorResponse,
  registerV1Path,
  registry,
} from "../lib/openapi.js";

/**
 * OpenAPI definitions for `routes/github.route.ts` — the optional GitHub
 * integration (`docs/features/GitHub_Integration.md`).
 *
 * A function rather than an import side effect, for the reason given at the
 * top of `tasks.openapi.ts`.
 */

const IntegrationStatusComponent = githubIntegrationStatusSchema.meta({
  id: "GithubIntegrationStatus",
  description:
    "What the optional GitHub integration is switched on for. Reachable even when the integration is off, so a client can tell why every other operation here answers INTEGRATION_NOT_CONFIGURED.",
});

const TaskGithubStatusComponent = taskGithubStatusSchema.meta({
  id: "TaskGithubStatus",
  description:
    "Live status of every GitHub link on the task. One link's failure never fails the response — it carries `error` instead of `state`.",
});

const NOT_CONFIGURED = () =>
  errorResponse(
    "The GitHub integration is off — neither GITHUB_TOKEN nor GITHUB_WEBHOOK_SECRET is set.",
    ["INTEGRATION_NOT_CONFIGURED"],
  );

function registerIntegrationPaths(): void {
  registerV1Path({
    method: "get",
    path: "/api/v1/integrations/github",
    tags: ["GitHub"],
    summary: "GitHub integration status",
    description:
      "What is switched on. Unlike every other operation in this tag, this one answers even when the integration is off (enabled: false) rather than INTEGRATION_NOT_CONFIGURED — a client needs a way to ask why.",
    responses: {
      200: {
        description: "Integration status.",
        content: { "application/json": { schema: IntegrationStatusComponent } },
      },
      422: errorResponse(`Only the X-Actor header can fail here. ${ACTOR_422_NOTE}`, [
        "VALIDATION_ERROR",
      ]),
    },
  });

  registerV1Path({
    method: "post",
    path: "/api/v1/integrations/github/import",
    tags: ["GitHub"],
    summary: "Import a GitHub issue as a task",
    description: [
      "Fetches the issue, then creates a task through the same path as POST /tasks: `title` from the issue title, `description` from its body (falling back to a line naming the source when empty), and a link back. `project` defaults to the repository name as a slug (null if that name is not one).",
      "",
      "Idempotent per issue, the same way `idempotencyKey` on POST /tasks is: importing the same open issue twice returns the task the first import made, 200 instead of 201.",
    ].join("\n"),
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: githubImportInputSchema } },
      },
    },
    responses: {
      200: {
        description: "Idempotent replay: this issue was already imported, and this is that task.",
        content: { "application/json": { schema: TaskComponent } },
      },
      201: {
        description: "Imported. The Location header points at the new task.",
        headers: {
          Location: { description: "URL of the created task.", schema: { type: "string" } },
        },
        content: { "application/json": { schema: TaskComponent } },
      },
      ...bodyParserResponses(),
      404: errorResponse(
        "GITHUB_NOT_FOUND: GitHub has no such issue, or it is private and the token cannot see it.",
        ["GITHUB_NOT_FOUND", "INTEGRATION_NOT_CONFIGURED"],
      ),
      422: errorResponse(
        `A field failed validation, or \`issue\` names a pull request rather than an issue. ${ACTOR_422_NOTE}`,
        ["VALIDATION_ERROR"],
      ),
      502: errorResponse(
        "GITHUB_UNAVAILABLE: GitHub did not answer, answered with an error, or rate-limited the request.",
        ["GITHUB_UNAVAILABLE"],
      ),
    },
  });

  registerV1Path({
    method: "get",
    path: "/api/v1/tasks/{taskId}/github",
    tags: ["GitHub"],
    summary: "Live status of a task's GitHub links",
    description:
      "Resolves every link on the task that is a GitHub PR or issue URL against the live API (60s cache per URL, ~5s timeout per call). A link GitHub could not resolve carries `error` instead of `state` rather than failing the whole response.",
    request: { params: z.object({ taskId: taskIdParamSchema }) },
    responses: {
      200: {
        description: "Live status of the task's GitHub links.",
        content: { "application/json": { schema: TaskGithubStatusComponent } },
      },
      404: errorResponse("No such task.", ["TASK_NOT_FOUND", "INTEGRATION_NOT_CONFIGURED"]),
      422: errorResponse(`Only the X-Actor header can fail here. ${ACTOR_422_NOTE}`, [
        "VALIDATION_ERROR",
      ]),
    },
  });
}

/**
 * `POST /integrations/github/webhook` — registered directly against the
 * registry, **not** through `registerV1Path()`. Every other `/api/v1`
 * operation documents `X-Actor` and the optional bearer requirement because
 * `app.ts` runs those middlewares in front of it; the webhook route is
 * mounted **before** both (GitHub can send neither), so documenting them here
 * would describe a gate that does not exist. `routes/openapi.contract.test.ts`
 * treats this one operation as the documented exception to "every /api/v1
 * operation carries X-Actor and bearer security".
 */
function registerWebhookPath(): void {
  registry.registerPath({
    method: "post",
    path: "/api/v1/integrations/github/webhook",
    tags: ["GitHub"],
    summary: "GitHub webhook delivery",
    description: [
      "GitHub calls this directly, so it carries neither a bearer token nor X-Actor — authentication is the HMAC-SHA256 signature in `X-Hub-Signature-256`, checked against the raw body with GITHUB_WEBHOOK_SECRET.",
      "",
      "`ping` → `{ ok: true }`. `pull_request` (opened, reopened, ready_for_review, closed, edited) → every `TASK-<id>` referenced in the title, body, or head branch gets the PR linked (skipping a URL already present, and the 20-link cap), a `github.pull_request` event, and — for opened/reopened/closed — a one-line comment from `system:github`. Never changes task status. Redeliveries (same `X-GitHub-Delivery`) are no-ops per task. Any other event → `{ ignored: true }`, 202.",
    ].join("\n"),
    request: {
      headers: z.object({
        "X-Hub-Signature-256": z
          .string()
          .optional()
          .meta({ description: "HMAC-SHA256 of the raw body, as `sha256=<hex>`." }),
        "X-GitHub-Event": z.string().optional().meta({ description: "e.g. ping, pull_request." }),
        "X-GitHub-Delivery": z
          .string()
          .optional()
          .meta({ description: "Unique per delivery; redeliveries of the same id are no-ops." }),
      }),
      body: {
        required: true,
        content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
      },
    },
    responses: {
      200: {
        description: "ping, or a pull_request event that was processed.",
        content: {
          "application/json": {
            schema: z.union([
              z.object({ ok: z.literal(true) }),
              z.object({ linkedTasks: z.array(z.number().int().positive()) }),
            ]),
          },
        },
      },
      202: {
        description: "An event type this integration does not act on.",
        content: { "application/json": { schema: z.object({ ignored: z.literal(true) }) } },
      },
      400: errorResponse("The request body is not valid JSON.", ["MALFORMED_JSON"]),
      401: errorResponse("Missing or invalid X-Hub-Signature-256.", ["INVALID_WEBHOOK_SIGNATURE"]),
      404: NOT_CONFIGURED(),
      500: INTERNAL_ERROR_RESPONSE,
      default: defaultErrorResponse,
    },
  });
}

/** Registers every GitHub integration operation. Called once, by `getOpenApiDocument()`. */
export function registerGithubPaths(): void {
  registerIntegrationPaths();
  registerWebhookPath();
}
