import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Forwards a rejected promise from an `async` handler to the error chain.
 *
 * **Express 5 already does this** — `apps/api/src/app.test.ts` proves it with
 * `GET /__test__/boom-async`, which reaches `errorHandler` unaided. The wrapper
 * is here because `docs/features/Error_Handling.md` asks for it and the reason
 * survives scrutiny: it makes the behaviour explicit at every call site and it
 * survives a downgrade to Express 4, where an unhandled rejection is a hung
 * request rather than a 500.
 *
 * It is a **local one-liner, deliberately not `express-async-handler`**. A
 * package for `.catch(next)` is a supply-chain dependency for something the
 * language does in six tokens.
 *
 * `void` on the promise rather than `return`: an Express handler's return value
 * is ignored, and returning a promise from a `RequestHandler` trips
 * `@typescript-eslint/no-misused-promises` at the mount site.
 */
export const asyncHandler =
  (
    handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
  ): RequestHandler =>
  (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
