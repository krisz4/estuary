import { Router } from "express";
import swaggerUi from "swagger-ui-express";

import { OPENAPI_TITLE } from "../lib/openapi.js";
import { getOpenApiDocument } from "../openapi.js";

/**
 * `GET /docs` — Swagger UI, and `GET /docs/openapi.json` — the raw spec.
 *
 * Mounted only when `DOCS_ENABLED` is true (`app.ts` decides; this module has no
 * opinion). It stays open even when `API_TOKEN` is set: the token gates
 * `/api/v1` only, and the page documents how to send it (the `bearerAuth`
 * scheme) — see `docs/features/API_Documentation.md`.
 *
 * **The document served here is generated at runtime from the same zod schemas
 * the handlers validate with**, not read from the committed `openapi.json`. Two
 * reasons: the committed file is a build artifact for consumers and CI, and it
 * lives at a path that is awkward to resolve from `dist/` inside a container —
 * but mainly, serving the generated document is what makes "the spec cannot
 * describe a shape the code does not return" true of the page a reader is
 * actually looking at. `openapi.contract.test.ts` asserts the committed file
 * still matches, so the two cannot drift apart unnoticed.
 *
 * Swagger UI's assets come from `swagger-ui-dist`, which is bundled rather than
 * loaded from a CDN: the container has no guarantee of outbound network access,
 * and a docs page that renders blank offline is worse than no docs page. The
 * cost is ~11 MB in the runtime image — noted for stage 14.
 */

/**
 * A **factory**, not a module-level router, so that nothing is generated when
 * `DOCS_ENABLED=false`: `swaggerUi.setup()` wants the finished document, and
 * building it at import time would walk every schema on every boot including the
 * boots that will never serve the page.
 */
export function createDocsRouter(): Router {
  const router = Router();

  /**
   * Declared before the UI mount. `swaggerUi.serve` is a static-file middleware
   * that answers for the whole subtree, so a JSON route declared after it would
   * never run.
   */
  router.get("/openapi.json", (_req, res) => {
    res.status(200).json(getOpenApiDocument());
  });

  /**
   * **Scopes the UI to the paths it actually serves.**
   *
   * `swaggerUi.setup()` is a plain handler, not a router: reached for any path,
   * it renders the page. So a bare `router.use("/", swaggerUi.serve, setup)`
   * answers `200 text/html` to *everything* under `/docs` — including
   * `GET /docs/openapi.jso` (a typo, which a client then tries to parse as the
   * spec) and `POST /docs/whatever`. That contradicts the catch-all documented
   * in `system.openapi.ts`, which promises an unmatched path is a 404
   * `NOT_FOUND` in the standard envelope.
   *
   * `next("router")` exits this router entirely rather than continuing inside
   * it, so a non-matching request falls through to `notFound` in `app.ts` and
   * gets the envelope like every other unknown path.
   *
   * `swagger-ui-dist` lays its files out flat — `swagger-ui-bundle.js`,
   * `swagger-ui.css`, `favicon-32x32.png`, the `.map` siblings,
   * `oauth2-redirect.html` — plus the `swagger-ui-init.js` the middleware
   * generates. One segment with a known extension covers all of them. `.json` is
   * deliberately **not** in the list: `/openapi.json` is handled above, and
   * admitting the extension here would send every other mistyped `.json` to the
   * UI instead of the 404 a client can parse.
   */
  const UI_ASSET = /^\/[A-Za-z0-9._-]+\.(?:js|css|map|png|html|txt)$/;

  router.use((req, _res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next("router");
    if (req.path === "/" || UI_ASSET.test(req.path)) return next();
    return next("router");
  });

  router.use(
    "/",
    swaggerUi.serve,
    swaggerUi.setup(getOpenApiDocument(), {
      customSiteTitle: OPENAPI_TITLE,
      swaggerOptions: {
        // Collapsed by default would hide the thing the page exists to show;
        // "list" expands the operations without expanding every schema.
        docExpansion: "list",
        defaultModelsExpandDepth: 0,
        displayRequestDuration: true,
        tryItOutEnabled: true,
      },
    }),
  );

  return router;
}
