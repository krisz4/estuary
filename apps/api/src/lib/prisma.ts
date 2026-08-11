import { PrismaClient } from "@prisma/client";

import { env } from "./env.js";

/**
 * The single Prisma client for the process.
 *
 * **It is constructed at import time**, from `DATABASE_URL` as parsed by
 * `lib/env.ts`. That is deliberate, and it has one consequence worth stating
 * loudly because it is the kind of thing that eats a developer's local data:
 *
 * > By the time any test hook runs, this module has already been imported and
 * > the client is already bound to whatever `DATABASE_URL` said. Tests must
 * > therefore set `DATABASE_URL` in a vitest `setupFiles` entry — which runs
 * > *before* test modules are imported — and never in a `beforeAll`.
 *
 * See `docs/engineering/TESTING.md`.
 */
export const prisma = new PrismaClient({
  datasourceUrl: env.DATABASE_URL,
  log: env.LOG_LEVEL === "debug" ? ["query", "warn", "error"] : ["warn", "error"],
});

export type { PrismaClient };
