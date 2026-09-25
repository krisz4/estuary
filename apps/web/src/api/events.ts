import {
  useInfiniteQuery,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from "@tanstack/react-query";
import { EVENTS_MAX_LIMIT, type EventsResponse } from "@helpdesk/contracts";
import { api, type QueryInput } from "@/api/http";
import { POLL_INTERVAL_MS } from "@/api/polling";
import { queryKeys } from "@/api/queryKeys";

/**
 * `GET /events` — the append-only activity log, read per task for the detail
 * page's timeline.
 *
 * ## Cursor paging, as an infinite query
 *
 * The feed is cursor-paged, oldest first (`eventsQuerySchema`): there is no
 * `page` and no total, only `meta.nextAfter` to feed back as `after`. That is
 * exactly `useInfiniteQuery`'s model — `getNextPageParam` returns the cursor
 * while `meta.hasMore` says there is more — and it means a poll refetches the
 * pages already loaded in order, so an agent's newest event lands at the end of
 * the last page without the timeline being rebuilt from scratch.
 *
 * `EVENTS_MAX_LIMIT` per page: one task's history rarely passes 200 entries,
 * so almost every timeline is a single request.
 */

export const listEvents = (query: QueryInput, signal?: AbortSignal): Promise<EventsResponse> =>
  api.get<EventsResponse>("/events", { query, signal });

export const useTaskEventsQuery = (
  taskId: number,
): UseInfiniteQueryResult<InfiniteData<EventsResponse, number | undefined>> =>
  useInfiniteQuery({
    queryKey: queryKeys.events.task(taskId),
    queryFn: ({ pageParam, signal }) =>
      listEvents(
        {
          taskId,
          limit: EVENTS_MAX_LIMIT,
          ...(pageParam === undefined ? {} : { after: pageParam }),
        },
        signal,
      ),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.meta.hasMore ? last.meta.nextAfter : undefined),
    refetchInterval: POLL_INTERVAL_MS,
  });
