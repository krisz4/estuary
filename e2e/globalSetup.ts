import { API_ORIGIN, E2E_DB_PATH } from "./env";

/**
 * Playwright **global** setup: checks that the API the specs will talk to is
 * reading the freshly built E2E database.
 *
 * The database itself is built by `e2e/prepareDatabase.ts`, which runs as the
 * first half of the API's `webServer` command — Playwright starts the web
 * servers *before* this function, and the API opens its database file at boot,
 * so by the time this runs it is too late to replace the file. See the note at
 * the top of `prepareDatabase.ts`.
 *
 * What is left here is the check. Going through HTTP rather than Prisma is the
 * point: it is the only way to learn whether the *server process* is reading
 * the file that was just written. A wrong answer fails the run at setup with a
 * sentence naming the cause, instead of as `no such table: Task` in the middle
 * of an unrelated spec.
 */
export default async function globalSetup(): Promise<void> {
  const response = await fetch(`${API_ORIGIN}/api/v1/tasks?pageSize=1`).catch(
    (error: unknown) => error as Error,
  );

  if (response instanceof Error) {
    throw new Error(`The E2E API at ${API_ORIGIN} is not answering (${response.message}).`);
  }
  if (!response.ok) {
    throw new Error(
      `The E2E API answered ${response.status} for a seeded list. If this is a missing table, the ` +
        `API opened ${E2E_DB_PATH} before e2e/prepareDatabase.ts built it — see the note at the ` +
        `top of that file.`,
    );
  }

  const { meta } = (await response.json()) as { meta: { total: number } };
  if (meta.total === 0) {
    throw new Error(
      `The E2E API reports 0 tasks immediately after seeding. It is reading a different ` +
        `database than ${E2E_DB_PATH}.`,
    );
  }
}
