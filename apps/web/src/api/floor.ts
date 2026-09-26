import { useCallback } from "react";
import { keepPreviousData, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { type FloorSnapshot } from "@helpdesk/contracts";
import { api, type QueryInput } from "@/api/http";
import { POLL_INTERVAL_MS } from "@/api/polling";
import { queryKeys } from "@/api/queryKeys";
import { type FloorParams } from "@/pages/tasks-map/useFloorParams";

/**
 * `FloorParams` (URL state) → the wire query. Same boundary rule as
 * `toTaskListQuery`: only fields `floorQuerySchema` accepts, absent filters
 * omitted rather than sent empty.
 */
export const toFloorQuery = (params: FloorParams): QueryInput => ({
  shipped: params.shipped,
  ...(params.at === undefined ? {} : { at: params.at }),
  ...(params.status.length > 0 ? { status: params.status } : {}),
  ...(params.priority.length > 0 ? { priority: params.priority } : {}),
  ...(params.project.length > 0 ? { project: params.project } : {}),
  ...(params.label.length > 0 ? { label: params.label } : {}),
  ...(params.assignee === undefined ? {} : { assignee: params.assignee }),
  ...(params.assigneeIsNull === undefined ? {} : { assigneeIsNull: params.assigneeIsNull }),
  ...(params.createdBy === undefined ? {} : { createdBy: params.createdBy }),
  ...(params.q === undefined ? {} : { q: params.q }),
  ...(params.createdFrom === undefined ? {} : { createdFrom: params.createdFrom }),
  ...(params.createdTo === undefined ? {} : { createdTo: params.createdTo }),
  ...(params.parentId === undefined ? {} : { parentId: params.parentId }),
  ...(params.parentIsNull === undefined ? {} : { parentIsNull: params.parentIsNull }),
  ...(params.dependsOn === undefined ? {} : { dependsOn: params.dependsOn }),
  ...(params.dependencyOf === undefined ? {} : { dependencyOf: params.dependencyOf }),
});

/**
 * `GET /floor` — one compact snapshot for the floor view. Spec:
 * `docs/pages/Floor_And_Logbook_Plan.md`.
 *
 * Response types come straight from `@helpdesk/contracts`; no re-parsing here,
 * same rule as `api/tasks.ts`.
 */
export const getFloor = (query: QueryInput, signal?: AbortSignal): Promise<FloorSnapshot> =>
  api.get<FloorSnapshot>("/floor", { query, signal });

/**
 * The floor's one read, from the floor's URL state. Polls like every other
 * agent-driven view (`api/polling.ts`), and is invalidated by every task write
 * through `tasks.all` / `invalidateAfterWorkflowWrite` because its key lives
 * under `queryKeys.tasks.floor()`.
 *
 * `queryKeys.tasks.floor()` is typed as `FloorQueryInput` — the *wire* shape —
 * but that type is `z.input` of a `z.preprocess`-wrapped schema (`unknown`, by
 * how zod types a preprocess), so the plain `QueryInput` this module builds is
 * assignable to it without a cast.
 *
 * Does not poll while replaying (`params.at` set): a historical snapshot never
 * changes, so refetching it every `POLL_INTERVAL_MS` would just be fifteen
 * identical requests a minute for no reason.
 *
 * `placeholderData: keepPreviousData` — the same "dim, don't blank" rule as
 * the list. Every scrub or replay tick is a new `at`, so a new query key; without
 * it the page falls back to `isPending` and swaps the whole hero for a
 * skeleton, unmounting the tide scrubber mid-drag or mid-playback.
 */
export const useFloorQuery = (params: FloorParams): UseQueryResult<FloorSnapshot> => {
  const query = toFloorQuery(params);
  return useQuery({
    queryKey: queryKeys.tasks.floor(query),
    queryFn: ({ signal }) => getFloor(query, signal),
    refetchInterval: params.at === undefined ? POLL_INTERVAL_MS : false,
    placeholderData: keepPreviousData,
  });
};

/**
 * Warms the snapshot for another `at` under the same filters — the tide
 * scrubber calls it with the next replay step, so the step's refetch is a
 * cache hit and its bead travel starts on the beat.
 */
export const usePrefetchFloorAt = (params: FloorParams): ((at: string) => void) => {
  const queryClient = useQueryClient();
  return useCallback(
    (at: string) => {
      const query = toFloorQuery({ ...params, at });
      void queryClient.prefetchQuery({
        queryKey: queryKeys.tasks.floor(query),
        queryFn: ({ signal }) => getFloor(query, signal),
      });
    },
    [queryClient, params],
  );
};
