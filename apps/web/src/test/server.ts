import { setupServer } from "msw/node";

/**
 * The one MSW server for a test file.
 *
 * Lifecycle (`listen` / `resetHandlers` / `close`) is wired in
 * `vitest.setup.ts`, which runs once per test file, so a test body only ever
 * calls `mockApi()` from `src/test/harness.tsx` to install handlers.
 *
 * It starts with **no** handlers on purpose. `onUnhandledRequest: "error"` then
 * makes a request from a test that never declared an API surface a loud
 * failure, where the previous hand-rolled `fetch` stub simply was not installed
 * and the request went to the real network (or, under jsdom, to a connection
 * refused that surfaced as a generic `NETWORK_ERROR` several layers away).
 */
export const server = setupServer();

/**
 * Harness-level faults raised from inside an MSW resolver.
 *
 * A resolver cannot fail a test by throwing: the throw becomes a rejected
 * request, the app under test turns it into a `NETWORK_ERROR`, and a test
 * asserting on an error state then **passes for the wrong reason**. So faults
 * are recorded here and `vitest.setup.ts`'s `afterEach` fails the test on them,
 * which no application-level error handling can swallow.
 */
export const harnessFaults: string[] = [];
