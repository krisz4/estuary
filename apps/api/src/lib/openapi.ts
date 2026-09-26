import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  type RouteConfig,
} from "@asteasolutions/zod-to-openapi";
import {
  ACTOR_HEADER,
  ANONYMOUS_ACTOR,
  apiErrorResponseSchema,
  apiErrorSchema,
  commentSchema,
  decisionSchema,
  eventsResponseSchema,
  floorSnapshotSchema,
  historyResponseSchema,
  nextTaskResponseSchema,
  paginatedTasksSchema,
  taskEventSchema,
  taskFacetsSchema,
  taskSchema,
  taskStatsSchema,
  taskSummarySchema,
  type ApiErrorCode,
} from "@helpdesk/contracts";
import { z } from "zod";

/**
 * The OpenAPI document, **generated from the zod contracts** rather than
 * maintained beside them. Spec: `docs/features/API_Documentation.md`.
 *
 * The point of generating is not convenience. A hand-written spec can describe a
 * response the code does not actually return and nothing catches it; here the
 * schema in `components.schemas.Task` *is* the object `taskSchema.parse()`
 * enforces, so the two cannot disagree.
 *
 * ## Why the metadata lives here and not in `packages/contracts`
 *
 * That package's hard constraint is "zod and nothing else" — it is bundled into
 * browser code. `@asteasolutions/zod-to-openapi` peers `zod ^4`, which means the
 * contract schemas can be annotated **from this side of the boundary** with no
 * runtime dependency added over there. This file plus `routes/*.openapi.ts` is
 * the whole of that annotation layer. (Deferred item D5 in the build log.)
 *
 * ## Why `.meta()` and not `.openapi()`
 *
 * The library's `.openapi()` method arrives by monkey-patching
 * `ZodType.prototype` in `extendZodWithOpenApi()`, and in zod 4 a schema
 * constructed **before** that call does not pick it up — every contract schema is
 * constructed at import time, so `registry.register()` fails with
 * `zodSchema.openapi is not a function` wherever the extension call is placed.
 * zod 4's native `.meta({ id })` is read by the generator as the same thing, needs
 * no patching, and returns a clone instead of mutating a schema the validators
 * share. Both were tried; this is the one that works.
 *
 * A consequence worth knowing: a schema becomes a **named component** only when
 * it is the schema handed to `registerPath` at a request or response boundary. An
 * id on a schema that only ever appears nested (`TaskSummary` inside
 * `PaginatedTasks`) is inlined. That is cosmetic — the shape is still exact —
 * and `NESTED_COMPONENTS` below registers the ones a reader would look for by
 * name, so they are listed under `components.schemas` as well.
 */

/* ------------------------------------------------------------------ *
 * Named components
 * ------------------------------------------------------------------ */

export const CommentComponent = commentSchema.meta({
  id: "Comment",
  description:
    "A comment on a task. Comments are append-only, so there is no updatedAt. `author` is the X-Actor that posted it.",
});

export const DecisionComponent = decisionSchema.meta({
  id: "Decision",
  description:
    "The structured half of needs_user_decision: a question, at least two options, and — once answered — the choice and who made it. A task has at most one open decision.",
});

export const TaskSummaryComponent = taskSummarySchema.meta({
  id: "TaskSummary",
  description:
    "A list row: every column of the task plus the open decision, the unfinished-dependency count, and the comment count — no thread and no relation lists.",
});

export const TaskComponent = taskSchema.meta({
  id: "Task",
  description:
    "A single task: the summary plus its comment thread (oldest first), full decision history (newest first), parent, children, dependencies, and dependents.",
});

export const PaginatedTasksComponent = paginatedTasksSchema.meta({
  id: "PaginatedTasks",
  description:
    "The list envelope. List responses are always { data, meta }; single resources are returned directly.",
});

export const TaskFacetsComponent = taskFacetsSchema.meta({
  id: "TaskFacets",
  description:
    "Distinct non-null values actually present in the table. The assignee, project, label, and createdBy filters send values from here, which is what makes case-sensitive exact matching safe.",
});

export const TaskStatsComponent = taskStatsSchema.meta({
  id: "TaskStats",
  description:
    "Task count per status — all ten keys present, zero included — plus needsAttention, the number of tasks waiting on a human (needs_user_decision + needs_user_action + needs_qa).",
});

export const NextTaskResponseComponent = nextTaskResponseSchema.meta({
  id: "NextTaskResponse",
  description:
    "The task just claimed for the caller, or { task: null } when nothing is available — not a 404, since nothing is missing.",
});

export const TaskEventComponent = taskEventSchema.meta({
  id: "TaskEvent",
  description:
    "One entry in the append-only change log. `payload` is type-specific: branch on `type` first. `taskId` is not a foreign key, so events outlive their task.",
});

export const EventsResponseComponent = eventsResponseSchema.meta({
  id: "EventsResponse",
  description:
    "A cursor page of the feed, oldest first. Poll with after=meta.nextAfter; nextAfter equals the incoming cursor when nothing new happened.",
});

export const FloorSnapshotComponent = floorSnapshotSchema.meta({
  id: "FloorSnapshot",
  description:
    "The floor view's snapshot: compact task rows, the dependency edges touching them, cross-scope refs, and meta (status counts, the shipped window, the replay instant, and the events cursor to start polling from).",
});

export const HistoryResponseComponent = historyResponseSchema.meta({
  id: "HistoryResponse",
  description:
    "The Logbook's charts: per-bucket created/completed/deferred/sent-back counts and a CFD status snapshot, human-wait and cycle-time percentiles, the longest waits, recent cycle times, and per-agent activity — all computed from TaskEvent.",
});

export const ErrorResponseComponent = apiErrorResponseSchema.meta({
  id: "ErrorResponse",
  description: "The error envelope. Clients branch on error.code, never on the HTTP status alone.",
});

/**
 * Components that only ever appear **nested** — `TaskSummary` inside
 * `PaginatedTasks`, `Decision` inside `Task`, `TaskEvent` inside
 * `EventsResponse` — and so would be inlined rather than named (see the note at
 * the top of this file). Registering them explicitly puts them in
 * `components.schemas` where a reader, or a client generator, can find them.
 */
const NESTED_COMPONENTS = [TaskSummaryComponent, DecisionComponent, TaskEventComponent];

/* ------------------------------------------------------------------ *
 * Request headers and security
 * ------------------------------------------------------------------ */

/** The name `security` requirements refer to. */
export const BEARER_AUTH = "bearerAuth";

/**
 * `X-Actor`, documented on every `/api/v1` operation because the `actor`
 * middleware parses it on every one of them — reads included, so a malformed
 * header fails the same way on a GET as on the POST that would have recorded
 * it.
 *
 * Documented as a plain pattern string rather than `actorSchema` itself: the
 * schema lowercases before matching, so its regex alone would tell a reader
 * that `Agent:Claude` is invalid when the server in fact accepts it.
 */
export const actorHeaders = (): z.ZodObject =>
  z.object({
    [ACTOR_HEADER]: z
      .string()
      .optional()
      .meta({
        description: `Who is acting: \`agent:<name>\` or \`human:<name>\` (case-insensitive; stored lowercase). Recorded on every write — createdBy, comment author, event actor, claim holder. Absent means \`${ANONYMOUS_ACTOR}\`. Malformed is a 422 VALIDATION_ERROR with details["${ACTOR_HEADER}"]. \`system:\` is reserved for the server.`,
        example: "agent:claude-code",
      }),
  });

/**
 * The bearer requirement, **optional**: `{}` is the "no auth" alternative.
 * Whether the gate is on is a deployment decision (`API_TOKEN`), so the spec
 * says "may be required" rather than claiming either answer for every server.
 */
export const v1Security = (): Record<string, string[]>[] => [{ [BEARER_AUTH]: [] }, {}];

/* ------------------------------------------------------------------ *
 * Error responses
 * ------------------------------------------------------------------ */

/**
 * An error response narrowed to the codes **that operation can actually emit**.
 *
 * `docs/features/API_Documentation.md` requires this rather than a generic
 * "500 Error" entry: someone reading `POST /tasks/{taskId}/decision/answer` should
 * find `NO_OPEN_DECISION` there and nowhere else, because that is the only
 * operation that produces it.
 *
 * The narrowing is `.extend()` on the contract's own envelope, so the
 * message / details / requestId half of the shape still has exactly one source.
 */
export const errorResponse = (
  description: string,
  codes: readonly [ApiErrorCode, ...ApiErrorCode[]],
) => ({
  description,
  content: {
    "application/json": {
      schema: z.object({ error: apiErrorSchema.extend({ code: z.enum(codes) }) }),
    },
  },
});

/**
 * The `default` response every operation carries.
 *
 * Two jobs. It is honest — any failure at all uses this envelope, including ones
 * no operation enumerates (a malformed request line, a verb the router does not
 * implement). And it is what gives `ErrorResponse` a use at a registerPath
 * boundary, which is the only way it becomes a named component rather than being
 * inlined into nine narrowed copies.
 */
export const defaultErrorResponse = {
  description:
    "Any other failure. Every error response in this API uses the ErrorResponse envelope.",
  content: { "application/json": { schema: ErrorResponseComponent } },
};

/**
 * The two failures the **body parser** produces rather than any route, spread
 * into every operation that accepts a body.
 *
 * Shared rather than spelled out four times: they are identical by construction
 * — `express.json()` is mounted once in `app.ts` and every write endpoint sits
 * behind it — so four copies would be four places for the wording to drift from
 * `BODY_LIMIT`'s actual behaviour.
 */
export const bodyParserResponses = () => ({
  400: errorResponse("The request body is not valid JSON.", ["MALFORMED_JSON"]),
  413: errorResponse("The request body is larger than BODY_LIMIT.", ["PAYLOAD_TOO_LARGE"]),
});

/** Every operation can fail this way; `errorHandler` is the only thing that writes it. */
export const INTERNAL_ERROR_RESPONSE = errorResponse(
  "Unexpected server error. The body carries a requestId and never a stack trace.",
  ["INTERNAL_ERROR"],
);

/**
 * Every `/api/v1` operation sits behind the optional `API_TOKEN` gate, which
 * runs before any router — so this is honest on all of them, and on nothing
 * outside `/api/v1`.
 */
export const UNAUTHORIZED_RESPONSE = errorResponse(
  "The server runs with API_TOKEN set and the request carried no `Authorization: Bearer <token>`, or the wrong one. Never returned by a server without API_TOKEN.",
  ["UNAUTHORIZED"],
);

/** Appended to every `/api/v1` 422 description: the X-Actor header is checked first. */
export const ACTOR_422_NOTE = `A malformed ${ACTOR_HEADER} header is also a VALIDATION_ERROR, with details["${ACTOR_HEADER}"].`;

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

/**
 * One registry per process. The `routes/*.openapi.ts` modules push their path
 * definitions into it as an import side effect; `buildOpenApiDocument()` reads
 * it. `registerOpenApiPaths()` below is what makes the import order irrelevant.
 */
export const registry: OpenAPIRegistry = new OpenAPIRegistry();

/**
 * `registry.registerPath` for an operation under `/api/v1`, adding what every
 * one of them shares because of middleware that runs before any router:
 *
 * - the `X-Actor` header parameter (`middleware/actor.ts`),
 * - the optional `bearerAuth` requirement and its 401 (`middleware/apiToken.ts`),
 * - the 500 and the `default` envelope (`middleware/errorHandler.ts`).
 *
 * Centralised so a new operation cannot forget one of them — and so the header
 * and the 401 never leak onto `/health`, which sits outside the gate.
 */
export const registerV1Path = (route: RouteConfig): void => {
  registry.registerPath({
    ...route,
    security: v1Security(),
    request: { ...route.request, headers: actorHeaders() },
    responses: {
      401: UNAUTHORIZED_RESPONSE,
      ...route.responses,
      500: INTERNAL_ERROR_RESPONSE,
      default: defaultErrorResponse,
    },
  });
};

/**
 * Unwraps a `z.preprocess(...)`-wrapped object back to the object carrying the
 * field definitions.
 *
 * `taskListQuerySchema` is a preprocessed schema — a `ZodPipe` — so its twelve
 * query parameters live on the output side. Unwrapping is the difference between
 * a spec that tracks the validator and a spec that tracks whoever last remembered
 * to edit it. It throws rather than degrading: a silent fallback would document
 * zero parameters, and a `GET /tasks` with no documented filters looks
 * plausible enough to ship. `routes/openapi.contract.test.ts` additionally
 * asserts the documented parameter names equal this object's keys.
 */
export const unwrapPreprocessedObject = (schema: z.ZodType): z.ZodObject => {
  const out = (schema as unknown as { _zod?: { def?: { out?: unknown } } })._zod?.def?.out;

  if (!(out instanceof z.ZodObject)) {
    throw new Error(
      "Expected a z.preprocess()-wrapped object schema. If zod changed how z.preprocess " +
        "is represented internally, fix this unwrap — do not hand-copy the parameter list, " +
        "which is precisely the drift it exists to prevent.",
    );
  }

  return out;
};

/**
 * Attaches prose to the fields of a query-parameter object **without retyping
 * them**.
 *
 * A spec whose parameters carry no descriptions is barely worth generating, and
 * the obvious way to add them — writing out twelve `z.string()` parameters with
 * text attached — throws away the bounds, defaults, and enums that came from the
 * validator, which is the entire reason for generating. So the shape is walked
 * and each field is *annotated in place*.
 *
 * `overrides` is the escape hatch for the one field whose validated type is not
 * its wire type (`sort` parses `"createdAt:desc"` into `{ field, direction }`,
 * and documenting the parsed object would tell a reader to send JSON). Both maps
 * are asserted against the real shape's keys in
 * `routes/openapi.contract.test.ts`, so a renamed parameter fails the run rather
 * than quietly losing its description.
 */
export const describeQueryParams = (
  object: z.ZodObject,
  descriptions: Record<string, string>,
  overrides: Record<string, z.ZodType> = {},
): z.ZodObject => {
  const shape = Object.fromEntries(
    Object.entries(object.shape).map(([key, field]) => {
      const base = overrides[key] ?? (field as z.ZodType);
      const description = descriptions[key];
      return [key, description === undefined ? base : base.meta({ description })];
    }),
  );

  return z.object(shape);
};

/* ------------------------------------------------------------------ *
 * The document
 * ------------------------------------------------------------------ */

/**
 * The generated document's type, taken from the generator rather than by adding
 * `openapi3-ts` as a direct dependency. It is a transitive dependency of
 * `@asteasolutions/zod-to-openapi`, and importing a package this workspace does
 * not declare would break the day pnpm's strict resolution is what it already is.
 */
export type OpenApiDocument = ReturnType<OpenApiGeneratorV31["generateDocument"]>;

export const OPENAPI_TITLE = "Task Manager API";
export const OPENAPI_VERSION = "1.0.0";

/**
 * Definitions the generator gets **alongside** the registry rather than through
 * it: the nested components and the bearer scheme.
 *
 * Handed over as raw definitions, not via `registry.register()` /
 * `registerComponent()`, for two reasons. `register()` calls
 * `zodSchema.openapi()`, the monkey-patched method this file avoids (see the
 * top of the file) — it throws `zodSchema.openapi is not a function` at
 * generation time, which took down `/docs` and with it server boot. And not
 * mutating the registry here keeps `buildOpenApiDocument()` free of side
 * effects, so calling it twice cannot register anything twice.
 */
/** The library does not export its definition type; this is it, taken from the registry. */
type OpenApiDefinition = OpenAPIRegistry["definitions"][number];

const extraDefinitions = (): OpenApiDefinition[] => [
  // The component name is the schema's `.meta({ id })`.
  ...NESTED_COMPONENTS.map((schema): OpenApiDefinition => ({ type: "schema", schema })),
  {
    type: "component",
    componentType: "securitySchemes",
    name: BEARER_AUTH,
    component: {
      type: "http",
      scheme: "bearer",
      description:
        "Only when the server sets API_TOKEN: every /api/v1 request must then send `Authorization: Bearer <API_TOKEN>`, or it gets 401 UNAUTHORIZED. /health and /docs stay open. It is one shared secret for every caller — who did what is still the X-Actor header.",
    },
  },
];

/**
 * Paths are written in full (`/api/v1/tasks`) with the server at the origin
 * root, rather than as `/tasks` under a `/api/v1` server entry. `GET /health`
 * sits **outside** the version prefix on purpose — a Docker healthcheck should
 * not move the day the version does — and a spec whose server URL was `/api/v1`
 * could not describe it without a second server entry covering exactly one path.
 */
export function buildOpenApiDocument(): OpenApiDocument {
  return new OpenApiGeneratorV31([...registry.definitions, ...extraDefinitions()]).generateDocument(
    {
      openapi: "3.1.0",
      info: {
        title: OPENAPI_TITLE,
        version: OPENAPI_VERSION,
        description: [
          "REST API for the AI task manager — used by the web app, by agents through the MCP server, and by scripts.",
          "",
          "**Identity is attribution, not authentication.** Every request may send an `X-Actor` header (`agent:<name>` or `human:<name>`); it is recorded on every write and defaults to `human:anonymous`. Nothing verifies it — it exists so the timeline can tell an agent's change from a human's, and so agents can be kept from overwriting each other's claimed work.",
          "",
          "**Optional access gate.** A self-hosted server may set `API_TOKEN`; every `/api/v1` request must then carry `Authorization: Bearer <token>` (the `bearerAuth` scheme). Without it the API is open — right for localhost, wrong for anything reachable from a network you do not control.",
          "",
          "- Status changes go through `POST /api/v1/tasks/{taskId}/transition`, never PATCH. What a status requires is the shape of its payload.",
          "- Writes that accept `expectedVersion` fail with `VERSION_CONFLICT` when the task changed since it was read.",
          "- List responses are enveloped as `{ data, meta }`; single resources are returned directly. The events feed is cursor-paged instead.",
          "- Failures always use the `ErrorResponse` envelope with a `SCREAMING_SNAKE` `code`. Branch on the code, not on the status alone.",
          "- Dates are ISO 8601 UTC strings.",
          "- Task ids are also task numbers: task `42` renders as `TASK-000042`.",
        ].join("\n"),
      },
      servers: [{ url: "/", description: "This server" }],
      tags: [
        { name: "Tasks", description: "Create, read, update, delete, filter, sort, and page" },
        {
          name: "Workflow",
          description:
            "Status transitions, claims and leases, next-task, decisions, and dependencies",
        },
        { name: "Comments", description: "Append-only comment threads on a task" },
        { name: "Events", description: "The append-only change feed, cursor-paged" },
        { name: "Floor", description: "The compact, graph-aware snapshot behind /tasks/floor" },
        { name: "Logbook", description: "History and charts computed from the events feed" },
        {
          name: "GitHub",
          description:
            "The optional GitHub integration: link status, issue import, and the inbound webhook. Off unless GITHUB_TOKEN and/or GITHUB_WEBHOOK_SECRET is set.",
        },
        { name: "System", description: "Liveness, and what happens to an unmatched request" },
      ],
    },
  );
}
