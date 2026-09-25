import { useEffect } from "react";

export const APP_NAME = "Tasks";

/**
 * Sets `document.title` for the current screen — `Inbox · Tasks`,
 * `TASK-000042 · Tasks`.
 *
 * An SPA does not change the title on navigation by itself, which leaves every
 * browser-history entry and every open tab reading "Tasks". Pass `undefined`
 * while the data a title depends on is still loading; the previous title stays
 * rather than flashing a placeholder.
 */
export const useDocumentTitle = (title: string | undefined): void => {
  useEffect(() => {
    if (title === undefined) return;
    document.title = `${title} · ${APP_NAME}`;
  }, [title]);
};
