import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  HUMAN_ATTENTION_STATUSES,
  MAX_PAGE_SIZE,
  formatTaskSort,
  type AnswerDecisionInput,
  type CreateTaskInput,
  type PaginatedTasks,
  type ReleaseTaskInput,
  type Task,
  type TaskFacets,
  type TaskStats,
  type TaskStatsQuery,
  type TransitionInput,
  type UpdateTaskInput,
} from "@helpdesk/contracts";
import { createComment } from "@/api/comments";
import { api, type QueryInput } from "@/api/http";
import { POLL_INTERVAL_MS } from "@/api/polling";
import { queryKeys } from "@/api/queryKeys";
import { type TaskListParams } from "@/pages/tasks-list/useTaskListParams";

/**
 * Task endpoints and their query hooks.
 *
 * Response types come from `@helpdesk/contracts` — never a hand-written
 * interface mirroring the API. The client does not re-`parse()` the body: the
 * server already validated it on the way out, and a `.parse()` here would turn a
 * new optional field on a healthy response into a blank screen.
 */

/* ------------------------------------------------------------------ *
 * Request shaping
 * ------------------------------------------------------------------ */

/**
 * Validated URL state → the wire query.
 *
 * This is the boundary where "the URL may contain anything" becomes "the request
 * contains only what `taskListQuerySchema` accepts". Unknown keys picked up
 * from a shared link never reach it, which is what lets the server stay
 * `.strict()`.
 *
 * Absent filters are omitted rather than sent empty: `?status=` is dropped by
 * the server's preprocessor anyway, but an omitted key keeps the query key —
 * and therefore the cache entry — free of noise.
 */
export const toTaskListQuery = (params: TaskListParams): QueryInput => ({
  page: params.page,
  pageSize: params.pageSize,
  sort: formatTaskSort(params.sort),
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
 * The inbox's one request: everything waiting on a human, most urgent first.
 *
 * Fixed apart from `project`, its one filter (see `toInboxQuery`) — and it goes
 * through `queryKeys.tasks.list()` like every other list, so a transition
 * anywhere in the app refreshes it through the same `lists()` prefix.
 */
export const INBOX_QUERY: QueryInput = {
  page: 1,
  pageSize: MAX_PAGE_SIZE,
  sort: "priority:desc",
  status: HUMAN_ATTENTION_STATUSES,
};

/* ------------------------------------------------------------------ *
 * Fetchers
 * ------------------------------------------------------------------ */

export const listTasks = (query: QueryInput, signal?: AbortSignal): Promise<PaginatedTasks> =>
  api.get<PaginatedTasks>("/tasks", { query, signal });

export const getTaskFacets = (signal?: AbortSignal): Promise<TaskFacets> =>
  api.get<TaskFacets>("/tasks/facets", { signal });

export const getTaskStats = (query: TaskStatsQuery, signal?: AbortSignal): Promise<TaskStats> =>
  api.get<TaskStats>("/tasks/stats", { query, signal });

export const getTask = (taskId: number, signal?: AbortSignal): Promise<Task> =>
  api.get<Task>(`/tasks/${taskId}`, { signal });

export const createTask = (input: CreateTaskInput): Promise<Task> =>
  api.post<Task>("/tasks", input);

export const updateTask = (taskId: number, input: UpdateTaskInput): Promise<Task> =>
  api.patch<Task>(`/tasks/${taskId}`, input);

export const deleteTask = (taskId: number): Promise<void> => api.delete<void>(`/tasks/${taskId}`);

export const transitionTask = (taskId: number, input: TransitionInput): Promise<Task> =>
  api.post<Task>(`/tasks/${taskId}/transition`, input);

export const claimTask = (taskId: number, input: { expectedVersion?: number }): Promise<Task> =>
  api.post<Task>(`/tasks/${taskId}/claim`, input);

export const releaseTask = (taskId: number, input: ReleaseTaskInput): Promise<Task> =>
  api.post<Task>(`/tasks/${taskId}/release`, input);

export const answerDecision = (taskId: number, input: AnswerDecisionInput): Promise<Task> =>
  api.post<Task>(`/tasks/${taskId}/decision/answer`, input);

export const addDependency = (taskId: number, dependsOnId: number): Promise<Task> =>
  api.post<Task>(`/tasks/${taskId}/dependencies`, { dependsOnId });

export const removeDependency = (taskId: number, dependsOnId: number): Promise<Task> =>
  api.delete<Task>(`/tasks/${taskId}/dependencies/${dependsOnId}`);

/* ------------------------------------------------------------------ *
 * Queries
 *
 * Every read an agent can change polls on `POLL_INTERVAL_MS` — see
 * `api/polling.ts`. Facets do not: the set of projects and people changes on
 * the order of days.
 * ------------------------------------------------------------------ */

/**
 * One page of tasks for the current URL state.
 *
 * `placeholderData: keepPreviousData` is what makes the "dim, don't blank" rule
 * possible: on a page or filter change the previous rows stay mounted while the
 * next ones load, and `isPlaceholderData` tells the page to dim them and set
 * `aria-busy`. Without it the table unmounts to a skeleton on every click, which
 * reads as a page reload.
 */
export const useTasksQuery = (params: TaskListParams): UseQueryResult<PaginatedTasks> => {
  const query = toTaskListQuery(params);

  return useQuery({
    // The key is the *request*, not the URL: two URLs differing only in an
    // unknown key are one cache entry, which is correct — they are one request.
    queryKey: queryKeys.tasks.list(query),
    queryFn: ({ signal }) => listTasks(query, signal),
    placeholderData: keepPreviousData,
    refetchInterval: POLL_INTERVAL_MS,
  });
};

/** `INBOX_QUERY`, narrowed to the given projects (all when empty). */
export const toInboxQuery = (project: readonly string[]): QueryInput =>
  project.length > 0 ? { ...INBOX_QUERY, project: [...project] } : INBOX_QUERY;

/** Everything in `HUMAN_ATTENTION_STATUSES` — the inbox page. */
export const useInboxQuery = (project: readonly string[] = []): UseQueryResult<PaginatedTasks> => {
  const query = toInboxQuery(project);
  return useQuery({
    queryKey: queryKeys.tasks.list(query),
    queryFn: ({ signal }) => listTasks(query, signal),
    refetchInterval: POLL_INTERVAL_MS,
  });
};

/**
 * The assignee, project and creator option lists.
 *
 * The **only** source of those options. All three are matched exactly and
 * case-sensitively (SQLite has no `mode: "insensitive"`), so the client has to
 * send a string the database actually stores — a free-text box would turn
 * "Alice Patel" into a silently empty result set.
 *
 * Five-minute `staleTime`: the set of people and projects changes on the order
 * of days, and this fires on every list-page mount.
 */
export const useTaskFacetsQuery = (): UseQueryResult<TaskFacets> =>
  useQuery({
    queryKey: queryKeys.tasks.facets(),
    queryFn: ({ signal }) => getTaskFacets(signal),
    staleTime: 5 * 60_000,
  });

/** `project` filter → the stats query. Empty means every project, sent as no key. */
const toTaskStatsQuery = (project: readonly string[]): TaskStatsQuery =>
  project.length > 0 ? { project: [...project] } : {};

/**
 * Count per status and the inbox badge, for the given projects (all when empty).
 * Mounted by the header on every screen, scoped to the header's project.
 */
export const useTaskStatsQuery = (project: readonly string[] = []): UseQueryResult<TaskStats> => {
  const query = toTaskStatsQuery(project);
  return useQuery({
    queryKey: queryKeys.tasks.statsFor(query),
    queryFn: ({ signal }) => getTaskStats(query, signal),
    refetchInterval: POLL_INTERVAL_MS,
  });
};

/** One task with its thread and relations — the detail and edit pages' only read. */
export const useTaskQuery = (taskId: number): UseQueryResult<Task> =>
  useQuery({
    queryKey: queryKeys.tasks.detail(taskId),
    queryFn: ({ signal }) => getTask(taskId, signal),
    refetchInterval: POLL_INTERVAL_MS,
  });

/* ------------------------------------------------------------------ *
 * Mutations
 *
 * Every invalidation below goes through `queryKeys`, and the prefix chosen for
 * each write is the table in that file. Two shapes recur:
 *
 * - **Field writes** (create, edit-form save) use `tasks.all`, because a
 *   changed assignee or project can add or drop a `facets` entry.
 * - **Workflow writes** (transition, claim, release, decision answer,
 *   dependency add/remove) use `invalidateAfterWorkflowWrite`: every list,
 *   every mounted detail — a task becoming `done` can auto-unblock *other*
 *   tasks, whose detail pages may be open — the stats, and the events feed.
 *   Not `facets`, which a status change cannot move.
 * ------------------------------------------------------------------ */

/**
 * The prefixes a workflow write can change. Returns the promise so a caller
 * that needs the refreshed data on screen before it drops an optimistic state
 * (e.g. a drag surface) can await it.
 */
export const invalidateAfterWorkflowWrite = (queryClient: QueryClient): Promise<unknown> =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.details() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.stats() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.events.all }),
  ]);

export const useCreateTaskMutation = (): UseMutationResult<Task, Error, CreateTaskInput> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateTaskInput) => createTask(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.events.all });
    },
  });
};

/**
 * The edit form's save. The caller sends `expectedVersion` — the version the
 * form was loaded at — so a change an agent made in between comes back as
 * `VERSION_CONFLICT` instead of being silently overwritten.
 */
export const useUpdateTaskMutation = (
  taskId: number,
): UseMutationResult<Task, Error, UpdateTaskInput> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateTaskInput) => updateTask(taskId, input),
    onSuccess: (task) => {
      // Seed the detail cache from the response so the page the user lands on
      // renders the saved values immediately, then let the invalidation refresh
      // everything that could have moved.
      queryClient.setQueryData(queryKeys.tasks.detail(taskId), task);
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.events.all });
    },
  });
};

/**
 * `POST /tasks/:taskId/transition` — every status change in the app, from the
 * detail page's picker, the map, and the inbox.
 *
 * **Not bound to one task id**, because the map and the inbox act on many
 * tasks through one hook; hooks cannot be called per card.
 *
 * ## What is optimistic, and what is not
 *
 * **The detail entry is written optimistically**, so a task moved on the map
 * and clicked straight into shows the new status rather than the cached
 * old one while the request is in flight — and is rolled back if the server
 * refuses. Only `status` is patched: the note, claim and decision a transition
 * produces are the server's to compute, and guessing them would put invented
 * text on screen.
 *
 * **List entries are not.** A move changes which *query* a row belongs to on
 * the map, so a caller with its own drag surface holds in-flight moves in its
 * own state instead and the cache stays the server's story about the world.
 *
 * `onSettled` returns the invalidation promise, so `mutateAsync` resolves only
 * once the refetches it triggered have landed. That is what lets a drag
 * surface drop its optimistic entry without a frame in which the card flicks
 * back.
 */
export type TransitionVariables = { taskId: number; input: TransitionInput };

export const useTransitionTaskMutation = (): UseMutationResult<
  Task,
  Error,
  TransitionVariables,
  { previous: Task | undefined }
> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ taskId, input }: TransitionVariables) => transitionTask(taskId, input),

    onMutate: async ({ taskId, input }) => {
      const detailKey = queryKeys.tasks.detail(taskId);

      // Without this, an in-flight GET (or a poll) can resolve after the
      // optimistic write and overwrite it with the pre-change row.
      await queryClient.cancelQueries({ queryKey: detailKey });

      const previous = queryClient.getQueryData<Task>(detailKey);
      if (previous !== undefined) {
        queryClient.setQueryData<Task>(detailKey, { ...previous, status: input.to });
      }
      return { previous };
    },

    onError: (_error, { taskId }, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(queryKeys.tasks.detail(taskId), context.previous);
      }
    },

    // The response is the full task — thread and relations included — so this
    // seeds a complete detail row rather than one that blanks until the refetch.
    onSuccess: (task) => {
      queryClient.setQueryData(queryKeys.tasks.detail(task.id), task);
    },

    onSettled: () => invalidateAfterWorkflowWrite(queryClient),
  });
};

/** A workflow write that is not a transition: same invalidation, no optimism. */
const useWorkflowMutation = <TVariables>(
  mutationFn: (variables: TVariables) => Promise<Task>,
): UseMutationResult<Task, Error, TVariables> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onSuccess: (task) => {
      queryClient.setQueryData(queryKeys.tasks.detail(task.id), task);
    },
    onSettled: () => invalidateAfterWorkflowWrite(queryClient),
  });
};

/** Take an unclaimed `in_progress` task (a crashed agent's lease ran out). */
export const useClaimTaskMutation = (taskId: number) =>
  useWorkflowMutation((input: { expectedVersion?: number }) => claimTask(taskId, input));

/** Give the claim up — the task goes back to `todo`. A human may release anyone's claim. */
export const useReleaseTaskMutation = (taskId: number) =>
  useWorkflowMutation((input: ReleaseTaskInput) => releaseTask(taskId, input));

/**
 * Answer the open decision. Not bound to a task id: the inbox answers many.
 * The task moves to `todo` with the answer as its status note.
 */
export type AnswerDecisionVariables = { taskId: number; input: AnswerDecisionInput };

export const useAnswerDecisionMutation = () =>
  useWorkflowMutation(({ taskId, input }: AnswerDecisionVariables) =>
    answerDecision(taskId, input),
  );

/**
 * The inbox's "Send back": a `needs_qa` task goes back to `todo`, and the
 * reason is recorded twice — as the transition's `reason` (the status note the
 * next agent reads first) and as a `qa_feedback` comment (which survives the
 * next transition). See `docs/features/Comments.md` § kinds.
 *
 * One mutation rather than two chained hooks, because the two writes are one
 * user action and the inbox item that started it **unmounts** the moment the
 * transition's invalidation lands (the task has left the inbox) — a second
 * hook-driven request fired from that component would be racing its own
 * teardown.
 *
 * The transition goes first. If it fails, nothing was written and the error is
 * thrown. If the comment then fails, the feedback is already on the task as
 * its status note, so that is reported back as `commentError` rather than
 * thrown — the send-back itself happened.
 */
export type SendBackResult = { task: Task; commentError: unknown };

/**
 * `acceptanceCriteria` is for a task that has none yet: `→ todo` requires them,
 * and a task can reach `needs_qa` without ever having been `todo`.
 */
export type SendBackVariables = { taskId: number; reason: string; acceptanceCriteria?: string };

export const useSendBackMutation = (): UseMutationResult<
  SendBackResult,
  Error,
  SendBackVariables
> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ taskId, reason, acceptanceCriteria }) => {
      const task = await transitionTask(taskId, {
        to: "todo",
        reason,
        ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
      });
      try {
        await createComment(taskId, { body: reason, kind: "qa_feedback" });
        return { task, commentError: null };
      } catch (commentError) {
        return { task, commentError };
      }
    },
    onSettled: () => invalidateAfterWorkflowWrite(queryClient),
  });
};

export const useAddDependencyMutation = (taskId: number) =>
  useWorkflowMutation((dependsOnId: number) => addDependency(taskId, dependsOnId));

export const useRemoveDependencyMutation = (taskId: number) =>
  useWorkflowMutation((dependsOnId: number) => removeDependency(taskId, dependsOnId));

export const useDeleteTaskMutation = (): UseMutationResult<void, Error, number> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (taskId: number) => deleteTask(taskId),
    /**
     * The one write that does **not** invalidate `tasks.all` or `details()`,
     * and the reason is measured rather than stylistic.
     *
     * A mutation's own `onSuccess` runs before the per-call one, so at this
     * moment the detail page is still mounted and still observing
     * `detail(taskId)`. Invalidating the whole tree therefore refetches the
     * task that was just deleted — a guaranteed 404, issued between the
     * DELETE and the navigation away. Confirmed in a production build: the
     * delete flow issued `DELETE /tasks/65` followed by `GET /tasks/65`.
     *
     * `removeQueries` is not the fix either, and for the same reason: removing
     * a query that still has an observer makes that observer create a fresh one
     * and fetch it.
     *
     * So the detail entry is marked stale with `refetchType: "none"` — no
     * request now, and a guaranteed refetch if the user ever navigates back to
     * that URL, which is what turns a cached deleted task into the documented
     * not-found state. The prefixes a deletion actually changes are
     * invalidated normally. Still through `queryKeys`: the rule is "no inline
     * key arrays", not "always the root".
     */
    onSuccess: (_data, taskId) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.detail(taskId),
        refetchType: "none",
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.facets() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.stats() });
      // `refetchType: "none"` for the same reason as the detail entry: the
      // page's own activity timeline is still mounted, and a refetch now is a
      // request for a task the user is in the act of leaving.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.events.all,
        refetchType: "none",
      });
    },
  });
};

/* ------------------------------------------------------------------ *
 * Archive (Logbook § Archive)
 * ------------------------------------------------------------------ */

export type ArchiveQuery = {
  project: readonly string[];
  q: string;
  page: number;
  pageSize: number;
};

/**
 * Done and deferred tasks, sorted by `completedAt` desc — the Logbook's
 * archive, and where the floor's "+N in the Logbook" crate leads. A plain
 * `queryKeys.tasks.list()` entry like every other list, so a transition that
 * moves a task into or out of `done`/`deferred` invalidates it for free.
 */
export const useArchiveQuery = (query: ArchiveQuery): UseQueryResult<PaginatedTasks> => {
  const wire: QueryInput = {
    page: query.page,
    pageSize: query.pageSize,
    sort: "completedAt:desc",
    status: ["done", "deferred"],
    ...(query.project.length > 0 ? { project: query.project } : {}),
    ...(query.q.trim() === "" ? {} : { q: query.q }),
  };

  return useQuery({
    queryKey: queryKeys.tasks.list(wire),
    queryFn: ({ signal }) => listTasks(wire, signal),
    placeholderData: keepPreviousData,
  });
};
