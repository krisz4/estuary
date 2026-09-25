/**
 * `@helpdesk/contracts` — the single source of truth for the API surface.
 *
 * Hard constraint: **zod and nothing else.** No Express, no Prisma, no React, no
 * `node:*`. This package is bundled into browser code, and a stray runtime
 * import surfaces as a Vite build error pointing at a transitive file.
 *
 * See `docs/features/Validation_And_Contracts.md`.
 */

export * from "./errors.js";
export * from "./pagination.js";
export * from "./reference.js";
export * from "./actor.js";
export * from "./comment.js";
export * from "./decision.js";
export * from "./task.js";
export * from "./task-query.js";
export * from "./task-workflow.js";
export * from "./event.js";
