import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { type HistoryQueryInput, type HistoryResponse } from "@helpdesk/contracts";
import { api, type QueryInput } from "@/api/http";
import { POLL_INTERVAL_MS } from "@/api/polling";
import { queryKeys } from "@/api/queryKeys";

/**
 * `GET /stats/history` — everything the Logbook's charts need, computed from
 * the events feed. See `docs/pages/Logbook.md` and
 * `packages/contracts/src/history.ts`.
 *
 * One request backs sections 2–6 (flow, throughput, waiting, cycle time,
 * agents): they are all views over the same bucketed rows, so one query with
 * one loading/error state covers all of them, matching what the page renders —
 * a partial history response is not a state the API can produce.
 */
export const getHistory = (
  query: HistoryQueryInput & QueryInput,
  signal?: AbortSignal,
): Promise<HistoryResponse> => api.get<HistoryResponse>("/stats/history", { query, signal });

export const useHistoryQuery = (
  query: HistoryQueryInput & QueryInput,
): UseQueryResult<HistoryResponse> =>
  useQuery({
    queryKey: queryKeys.history.query(query),
    queryFn: ({ signal }) => getHistory(query, signal),
    refetchInterval: POLL_INTERVAL_MS,
  });
