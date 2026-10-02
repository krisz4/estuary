import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACTOR_HEADER,
  API_ERROR_CODES,
  eventsQuerySchema,
  floorQuerySchema,
  historyQuerySchema,
  taskListQuerySchema,
  taskStatsQuerySchema,
} from "@estuary/contracts";
import type { Router } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { ROUTER_MOUNTS, createApp } from "../app.js";
import { BEARER_AUTH, unwrapPreprocessedObject } from "../lib/openapi.js";
import { getOpenApiDocument } from "../openapi.js";
import { EVENTS_QUERY_DESCRIPTIONS } from "./events.openapi.js";
import { FLOOR_QUERY_DESCRIPTIONS } from "./floor.openapi.js";
import { HISTORY_QUERY_DESCRIPTIONS } from "./history.openapi.js";
import { healthResponseSchema } from "./system.openapi.js";
import {
  QUERY_DESCRIPTIONS,
  QUERY_OVERRIDES,
  STATS_QUERY_DESCRIPTIONS,
  buildTaskListQueryParams,
} from "./tasks.openapi.js";

/**
 * **The OpenAPI half of the stage-9 gate, executable.**
 *
 * `docs/features/API_Documentation.md` claims "every route is registered" and
 * "a new endpoint without a registry entry fails the contract test". This file is
 * that test. It is the same shape as `routes/error-codes.test.ts`: a set derived
 * from the application, compared against a set derived from the spec, in both
 * directions — so a documented path with no route fails as loudly as a route with
 * no documentation.
 */

const app = createApp();
const document = getOpenApiDocument();

/* ------------------------------------------------------------------ *
 * What the application actually serves
 * ------------------------------------------------------------------ */

/** `/tasks/:taskId` → `/tasks/{taskId}`, the OpenAPI spelling. */
const toOpenApiPath = (expressPath: string): string =>
  expressPath.replaceAll(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");

interface Operation {
  method: string;
  path: string;
}

const key = ({ method, path }: Operation): string => `${method.toUpperCase()} ${path}`;

/** Every `router.get/post/...` declared on a router, with its mount prefix applied. */
const routerOperations = (mountPath: string, router: Router): Operation[] => {
  const stack = (router as unknown as { stack: RouterLayer[] }).stack;

  return stack.flatMap((layer) => {
    if (layer.route === undefined) return [];
    // A route path of "/" contributes nothing — the mount path is the whole URL.
    const suffix = layer.route.path === "/" ? "" : layer.route.path;
    return Object.keys(layer.route.methods)
      .filter((method) => method !== "_all")
      .map((method) => ({ method, path: toOpenApiPath(`${mountPath}${suffix}`) }));
  });
};

interface RouterLayer {
  route?: { path: string; methods: Record<string, boolean> };
  /** Present when the layer is a mounted sub-router rather than a plain handler. */
  handle?: { stack?: unknown[] };
}

const appStack = (): RouterLayer[] =>
  (app as unknown as { router: { stack: RouterLayer[] } }).router.stack;

/** App-level `app.use(path, someRouter)` layers, as opposed to plain middleware. */
const mountedSubRouters = (): RouterLayer[] =>
  appStack().filter((layer) => layer.route === undefined && Array.isArray(layer.handle?.stack));

/**
 * Routes declared directly on the app rather than inside a mounted router —
 * `GET /health` is the only real one.
 *
 * The `/__test__/` diagnostics are excluded because they exist only under
 * `NODE_ENV=test` and documenting them would advertise a route that is absent
 * from every environment a reader of the spec can reach.
 */
const appLevelOperations = (): Operation[] => {
  return appStack().flatMap((layer) => {
    if (layer.route === undefined) return [];
    if (layer.route.path.startsWith("/__test__/")) return [];
    return Object.keys(layer.route.methods)
      .filter((method) => method !== "_all")
      .map((method) => ({ method, path: toOpenApiPath(layer.route!.path) }));
  });
};

const mountedOperations: Operation[] = [
  ...appLevelOperations(),
  ...ROUTER_MOUNTS.flatMap((mount) => routerOperations(mount.path, mount.router)),
];

/* ------------------------------------------------------------------ *
 * What the spec documents
 * ------------------------------------------------------------------ */

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"] as const;

const documentedOperations: Operation[] = Object.entries(document.paths ?? {}).flatMap(
  ([path, item]) =>
    HTTP_METHODS.filter((method) => method in (item as Record<string, unknown>)).map((method) => ({
      method,
      path,
    })),
);

/**
 * Paths that are documented on purpose and have no Express route behind them.
 *
 * Exactly one entry, and it needs a reason: `NOT_FOUND` comes from the
 * `notFound` middleware rather than from any handler, so no operation can
 * honestly list it — `GET /api/v1/tasks` cannot return `NOT_FOUND`, and saying
 * it could would be the plausible-but-false line a generated spec exists to
 * avoid. Documenting the catch-all gives the code a home and tells a reader what
 * an unmatched request does. Anything else appearing here is a bug.
 */
const SYNTHETIC_PATHS = new Set(["/api/v1/{unmatchedPath}"]);

/* ------------------------------------------------------------------ *
 * Coverage
 * ------------------------------------------------------------------ */

/**
 * Routers mounted on the app that `ROUTER_MOUNTS` does not list, and therefore
 * that `mountedOperations` cannot see.
 *
 * Exactly one is allowed — the Swagger UI router, which serves the spec rather
 * than being part of the API it describes and has no operations to document.
 * Anything else here is a resource router that `mountedOperations` is blind to,
 * which would make the whole coverage check above pass while the new endpoints
 * went undocumented.
 */
const ALLOWED_UNLISTED_MOUNTS = 1; // /docs

describe("every mounted router is visible to this test", () => {
  const listed = new Set<unknown>(ROUTER_MOUNTS.map((mount) => mount.router));

  it("finds mounted sub-routers at all", () => {
    // `ROUTER_MOUNTS` plus `/docs`. If Express stops exposing `handle.stack`,
    // this fires instead of the assertion below silently seeing nothing.
    expect(mountedSubRouters().length).toBeGreaterThanOrEqual(
      ROUTER_MOUNTS.length + ALLOWED_UNLISTED_MOUNTS,
    );
  });

  /**
   * The gap this closes: `mountedOperations` walks `ROUTER_MOUNTS`, so a router
   * attached with a bare `app.use("/api/v1/attachments", attachmentsRouter)` —
   * exactly how `/docs` is mounted — is invisible to it. The suite would stay
   * green while a whole resource went undocumented, which is the opposite of
   * what `API_Documentation.md` promises.
   */
  it("mounts no router outside ROUTER_MOUNTS beyond the allowed /docs", () => {
    const unlisted = mountedSubRouters().filter((layer) => !listed.has(layer.handle));

    expect(
      unlisted,
      "a router is mounted directly in app.ts — add it to ROUTER_MOUNTS so its routes are checked against the spec",
    ).toHaveLength(ALLOWED_UNLISTED_MOUNTS);
  });

  it("confirms the one allowed unlisted mount really is the docs UI", async () => {
    const res = await request(app).get("/docs/openapi.json");

    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
  });
});

describe("the spec covers every mounted route", () => {
  it("finds routes to check at all", () => {
    // Without this the comparison below passes vacuously the day the
    // introspection stops working — which is exactly what Express 5 changing its
    // layer internals would do.
    expect(mountedOperations.length).toBeGreaterThanOrEqual(19);
    expect(mountedOperations.map(key)).toContain("GET /health");
  });

  it("documents exactly the operations the app mounts — no gaps, no strays", () => {
    const mounted = mountedOperations.map(key).sort();
    const documented = documentedOperations
      .filter((operation) => !SYNTHETIC_PATHS.has(operation.path))
      .map(key)
      .sort();

    expect(documented).toEqual(mounted);
  });

  it("declares every synthetic path deliberately", () => {
    const documented = new Set(documentedOperations.map((operation) => operation.path));
    for (const path of SYNTHETIC_PATHS) expect(documented).toContain(path);
  });
});

describe("the spec covers every error code", () => {
  /**
   * Codes are collected from the **explicit status responses only**. The
   * `default` response on every operation references the full `ErrorResponse`
   * envelope, which enumerates every code — counting it would make this test
   * pass no matter what the per-operation responses said, which is the failure
   * mode the build log calls "a test that could not fail".
   */
  const documentedCodes = new Set<string>();

  for (const item of Object.values(document.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = (item as Record<string, { responses?: Record<string, unknown> }>)[method];
      if (operation?.responses === undefined) continue;

      for (const [status, response] of Object.entries(operation.responses)) {
        if (status === "default") continue;
        const schema = (
          response as {
            content?: { "application/json"?: { schema?: Record<string, unknown> } };
          }
        ).content?.["application/json"]?.schema;

        const codes = (
          schema?.properties as
            { error?: { properties?: { code?: { enum?: string[]; const?: string } } } } | undefined
        )?.error?.properties?.code;

        if (codes?.enum !== undefined) for (const code of codes.enum) documentedCodes.add(code);
        if (codes?.const !== undefined) documentedCodes.add(codes.const);
      }
    }
  }

  it("names every ApiErrorCode on at least one concrete operation response", () => {
    expect([...documentedCodes].sort()).toEqual([...API_ERROR_CODES].sort());
  });
});

/* ------------------------------------------------------------------ *
 * Query parameters
 * ------------------------------------------------------------------ */

describe("the list query is documented from the real schema", () => {
  /**
   * **Written out on purpose, and the reason is a test that could not fail.**
   *
   * The first version of this block compared the documented parameter names
   * against `Object.keys(unwrapPreprocessedObject(taskListQuerySchema).shape)`
   * — the same call the production annotation layer makes. Making that unwrap
   * degrade to an empty object (instead of throwing) was then invisible: both
   * sides of the comparison became `[]` together and every assertion passed. It
   * was caught by breaking the unwrap and watching *nothing* fire.
   *
   * So the expected set is an independent literal, and each name below is also
   * fed through the real schema to prove it is genuinely a parameter rather than
   * a string somebody typed here.
   */
  const EXPECTED_QUERY_PARAMS: Record<string, unknown> = {
    page: "2",
    pageSize: "10",
    sort: "priority:desc",
    status: "todo",
    priority: "high",
    project: "estuary",
    label: "web",
    assignee: "Priya Nair",
    assigneeIsNull: undefined, // exclusive with `assignee`; probed on its own below
    createdBy: "agent:claude-code",
    claimedBy: "agent:claude-code",
    parentId: "42",
    parentIsNull: undefined, // exclusive with `parentId`; probed on its own below
    attention: "true",
    dependsOn: "7",
    dependencyOf: "7",
    q: "printer",
    createdFrom: "2026-01-01",
    createdTo: "2026-12-31",
  };

  const expectedNames = Object.keys(EXPECTED_QUERY_PARAMS).sort();
  const schemaKeys = Object.keys(unwrapPreprocessedObject(taskListQuerySchema).shape).sort();

  it("names only parameters taskListQuerySchema actually accepts", () => {
    for (const [name, sample] of Object.entries(EXPECTED_QUERY_PARAMS)) {
      const input =
        name === "assigneeIsNull" || name === "parentIsNull"
          ? { [name]: "true" }
          : { [name]: sample };
      const parsed = taskListQuerySchema.safeParse(input);
      expect(
        parsed.success,
        `?${name}= was rejected: ${JSON.stringify(parsed.error?.issues)}`,
      ).toBe(true);
    }

    // The other half: `.strict()` is what makes the list above exhaustive rather
    // than merely valid.
    expect(taskListQuerySchema.safeParse({ notAParameter: "x" }).success).toBe(false);
  });

  it("documents exactly those parameters in the query string, plus the X-Actor header", () => {
    const parameters = (document.paths?.["/api/v1/tasks"]?.get?.parameters ?? []) as unknown as {
      name: string;
      in: string;
    }[];
    const query = parameters.filter((parameter) => parameter.in === "query");

    expect(query.map((parameter) => parameter.name).sort()).toEqual(expectedNames);
    expect(parameters.filter((parameter) => parameter.in !== "query").map((p) => p.name)).toEqual([
      ACTOR_HEADER,
    ]);
  });

  it("takes its parameter set from the schema, so a new filter cannot go undocumented", () => {
    expect(schemaKeys).toEqual(expectedNames);
  });

  it("describes every parameter, and describes nothing that does not exist", () => {
    expect(Object.keys(QUERY_DESCRIPTIONS).sort()).toEqual(expectedNames);
    expect(Object.keys(buildTaskListQueryParams().shape).sort()).toEqual(expectedNames);
  });

  it("overrides only parameters that exist", () => {
    for (const name of Object.keys(QUERY_OVERRIDES)) expect(expectedNames).toContain(name);
  });

  it("keeps the validated bounds rather than flattening everything to a string", () => {
    const parameters = (document.paths?.["/api/v1/tasks"]?.get?.parameters ?? []) as unknown as {
      name: string;
      schema: Record<string, unknown>;
    }[];

    const pageSize = parameters.find((parameter) => parameter.name === "pageSize");
    // Straight off `MAX_PAGE_SIZE`. If this ever reads `undefined`, the
    // annotation layer has started retyping parameters instead of annotating them.
    expect(pageSize?.schema.maximum).toBe(100);
    expect(pageSize?.schema.default).toBe(20);
  });
});

describe("the other query surfaces are documented from their schemas", () => {
  const documentedParams = (path: string): string[] =>
    ((document.paths?.[path]?.get?.parameters ?? []) as unknown as { name: string; in: string }[])
      .filter((parameter) => parameter.in === "query")
      .map((parameter) => parameter.name)
      .sort();

  it.each([
    ["/api/v1/tasks/stats", taskStatsQuerySchema, STATS_QUERY_DESCRIPTIONS, ["project"]],
    [
      "/api/v1/events",
      eventsQuerySchema,
      EVENTS_QUERY_DESCRIPTIONS,
      ["actor", "after", "before", "from", "limit", "order", "project", "taskId", "to", "type"],
    ],
    [
      "/api/v1/floor",
      floorQuerySchema,
      FLOOR_QUERY_DESCRIPTIONS,
      [
        "assignee",
        "assigneeIsNull",
        "at",
        "attention",
        "claimedBy",
        "createdBy",
        "createdFrom",
        "createdTo",
        "dependencyOf",
        "dependsOn",
        "label",
        "parentId",
        "parentIsNull",
        "priority",
        "project",
        "q",
        "shipped",
        "status",
      ],
    ],
    [
      "/api/v1/stats/history",
      historyQuerySchema,
      HISTORY_QUERY_DESCRIPTIONS,
      ["bucket", "from", "project", "to"],
    ],
  ] as const)(
    "%s documents exactly its schema's parameters, each described",
    (path, schema, descriptions, expected) => {
      expect(Object.keys(unwrapPreprocessedObject(schema).shape).sort()).toEqual(expected);
      expect(documentedParams(path)).toEqual(expected);
      expect(Object.keys(descriptions).sort()).toEqual(expected);
    },
  );
});

/* ------------------------------------------------------------------ *
 * What every /api/v1 operation shares
 * ------------------------------------------------------------------ */

/**
 * The one `/api/v1` operation GitHub calls directly rather than a client of
 * this API (`docs/features/GitHub_Integration.md`). It carries neither
 * `X-Actor` nor a bearer token — `app.ts` mounts it before both of those
 * middlewares, because GitHub can send neither — so it is the documented
 * exception to "every /api/v1 operation carries X-Actor and bearer security".
 */
const WEBHOOK_PATH = "/api/v1/integrations/github/webhook";

describe("cross-cutting request metadata", () => {
  const operations = Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
    HTTP_METHODS.filter((method) => method in (item as Record<string, unknown>)).map((method) => ({
      path,
      method,
      operation: (item as Record<string, Record<string, unknown>>)[method]!,
    })),
  );
  const v1 = operations.filter(
    (entry) =>
      entry.path.startsWith("/api/v1/") &&
      !SYNTHETIC_PATHS.has(entry.path) &&
      entry.path !== WEBHOOK_PATH,
  );

  it("finds /api/v1 operations to check", () => {
    expect(v1.length).toBeGreaterThanOrEqual(18);
  });

  it("documents the X-Actor header on every /api/v1 operation", () => {
    for (const { path, method, operation } of v1) {
      const headers = ((operation.parameters ?? []) as { name: string; in: string }[]).filter(
        (parameter) => parameter.in === "header",
      );
      expect(
        headers.map((header) => header.name),
        `${method} ${path}`,
      ).toEqual([ACTOR_HEADER]);
    }
  });

  it("marks every /api/v1 operation as optionally bearer-authenticated, with a 401", () => {
    for (const { path, method, operation } of v1) {
      expect(operation.security, `${method} ${path}`).toEqual([{ [BEARER_AUTH]: [] }, {}]);
      expect(Object.keys(operation.responses as object), `${method} ${path}`).toContain("401");
    }
    expect(document.components?.securitySchemes?.[BEARER_AUTH]).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
  });

  it("keeps the header and the gate off /health, which sits outside /api/v1", () => {
    const health = document.paths?.["/health"]?.get;

    expect(health?.parameters).toBeUndefined();
    expect(health?.security).toBeUndefined();
    expect(Object.keys(health?.responses ?? {})).not.toContain("401");
  });

  it("keeps X-Actor and the bearer gate off the GitHub webhook — GitHub can send neither", () => {
    const webhook = document.paths?.[WEBHOOK_PATH]?.post;

    expect(
      ((webhook?.parameters ?? []) as { name: string; in: string }[])
        .filter((parameter) => parameter.in === "header")
        .map((parameter) => parameter.name),
    ).not.toContain(ACTOR_HEADER);
    expect(webhook?.security).toBeUndefined();

    // It does have its own 401 — INVALID_WEBHOOK_SIGNATURE, not the bearer gate's
    // UNAUTHORIZED — so the check is on the *code*, not on the status being absent.
    const responses = webhook?.responses as Record<string, unknown> | undefined;
    const unauthorized = responses?.["401"] as
      | { content?: { "application/json"?: { schema?: { properties?: Record<string, unknown> } } } }
      | undefined;
    const codeSchema = unauthorized?.content?.["application/json"]?.schema?.properties?.error as
      { properties?: { code?: { enum?: string[] } } } | undefined;
    expect(codeSchema?.properties?.code?.enum).toEqual(["INVALID_WEBHOOK_SIGNATURE"]);
  });

  it("no longer documents the retired INVALID_STATUS_TRANSITION anywhere", () => {
    expect(JSON.stringify(document)).not.toContain("INVALID_STATUS_TRANSITION");
  });

  it("describes the X-Actor header and the optional token in the document description", () => {
    const description = document.info.description ?? "";

    expect(description).toContain("X-Actor");
    expect(description).toContain("API_TOKEN");
    expect(description).not.toMatch(/there is no authentication/i);
  });
});

/* ------------------------------------------------------------------ *
 * The committed artifact
 * ------------------------------------------------------------------ */

describe("openapi.json", () => {
  const committedPath = join(
    dirname(dirname(fileURLToPath(import.meta.url))),
    "..",
    "openapi.json",
  );

  it("is committed and matches what the generator produces right now", () => {
    const committed: unknown = JSON.parse(readFileSync(committedPath, "utf8"));

    // The failure message people will actually see, so it says what to do.
    expect(
      committed,
      "openapi.json is stale — run `pnpm --filter @estuary/api openapi:gen` and commit the result",
    ).toEqual(JSON.parse(JSON.stringify(document)));
  });
});

/* ------------------------------------------------------------------ *
 * The one shape with no contract schema
 * ------------------------------------------------------------------ */

describe("GET /health", () => {
  /**
   * Every other documented response is generated from the schema the handler
   * validates with, so the two cannot disagree. `/health` has no contract schema
   * — no client consumes it — so it is the one place drift is possible, and the
   * only way to rule it out is to issue the request.
   */
  it("returns a body that matches its documented schema", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    const parsed = healthResponseSchema.safeParse(res.body);
    expect(parsed.success, `body did not match HealthResponse: ${JSON.stringify(res.body)}`).toBe(
      true,
    );
  });
});
