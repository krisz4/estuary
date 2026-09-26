import { useEffect } from "react";

export const APP_NAME = "Estuary";

/**
 * Sets `document.title` for the current screen — `Inbox · Estuary`,
 * `TASK-000042 · Estuary`.
 *
 * An SPA does not change the title on navigation by itself, which leaves every
 * browser-history entry and every open tab reading "Estuary". Pass `undefined`
 * while the data a title depends on is still loading; the previous title stays
 * rather than flashing a placeholder.
 */
export const useDocumentTitle = (title: string | undefined): void => {
  useEffect(() => {
    if (title === undefined) return;
    document.title = `${title} · ${APP_NAME}`;
  }, [title]);
};
