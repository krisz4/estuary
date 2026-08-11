import { QueryClient } from "@tanstack/react-query";
import { isApiClientError } from "@/api/http";

/**
 * Retry policy, per `docs/features/Error_Handling.md` § Retries.
 *
 * Queries retry twice, **and only for failures a retry could fix**: a network
 * error or a 5xx. Retrying a 404 or a 422 costs the user three round trips to
 * see the same error, and on a detail page for a deleted ticket it turns an
 * instant "not found" into a two-second stall.
 */
const shouldRetryQuery = (failureCount: number, error: unknown): boolean => {
  if (failureCount >= 2) return false;
  if (!isApiClientError(error)) return false;
  return error.code === "NETWORK_ERROR" || error.status >= 500;
};

/**
 * Created once at module scope, not inside a component.
 *
 * A `new QueryClient()` in a render body is discarded and rebuilt on every
 * re-render, which throws away the entire cache each time — the symptom is a
 * refetch on every keystroke and a UI that never settles
 * (`docs/pages/App_Shell.md`).
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: shouldRetryQuery,
      /**
       * A helpdesk list that refetches every time the user alt-tabs back from
       * their mail client is noise, and it fights the "keep previous data
       * visible" rule on the list page.
       */
      refetchOnWindowFocus: false,
    },
    mutations: {
      /** Never. A retried `POST /tickets` creates two tickets. */
      retry: 0,
    },
  },
});
