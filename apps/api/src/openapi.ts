import { buildOpenApiDocument, type OpenApiDocument } from "./lib/openapi.js";
import { registerCommentPaths } from "./routes/comments.openapi.js";
import { registerSystemPaths } from "./routes/system.openapi.js";
import { registerTicketPaths } from "./routes/tickets.openapi.js";

/**
 * The one place the per-router registration modules are pulled in.
 *
 * "Is this route documented?" reduces to "is its `register*Paths()` call in the
 * list below?" — so the list lives here, in one file, rather than being repeated
 * by the `/docs` router and the generator script. A path defined in a module
 * nobody calls is invisible, and `routes/openapi.contract.test.ts` fails the run
 * when that happens.
 *
 * **Registration is a call, not an import side effect, and that distinction is
 * load-bearing.** `app.ts` imports `createDocsRouter`, which imports this file,
 * so an import-time registration ran on every boot — including boots with
 * `DOCS_ENABLED=false`. That registration builds the list query's parameters,
 * which means calling `unwrapPreprocessedObject()`, which reads zod internals
 * and throws by design when they change. A `zod ^4` patch bump would therefore
 * have taken down **process startup** on a deployment that had switched docs off
 * and never wanted a spec. Now the blast radius is `/docs` and `openapi:gen`.
 *
 * `lib/openapi.ts` cannot own this itself: the layer table in
 * `docs/engineering/ARCHITECTURE.md` allows `lib/` contracts and third-party
 * packages, not routes.
 */
const REGISTRARS = [registerTicketPaths, registerCommentPaths, registerSystemPaths] as const;

let cached: OpenApiDocument | undefined;

/**
 * The generated document, built once.
 *
 * Memoised because `/docs` serves it on every page load and generation walks
 * every schema. The same flag also keeps the registrars from running twice,
 * which would register every path a second time.
 */
export function getOpenApiDocument(): OpenApiDocument {
  if (cached === undefined) {
    for (const register of REGISTRARS) register();
    cached = buildOpenApiDocument();
  }
  return cached;
}
