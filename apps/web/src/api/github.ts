import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  type GithubImportInput,
  type GithubIntegrationStatus,
  type Task,
  type TaskGithubStatus,
} from "@estuary/contracts";
import { api } from "@/api/http";
import { queryKeys } from "@/api/queryKeys";

/**
 * The optional GitHub integration's three endpoints.
 *
 * Every read here treats `INTEGRATION_NOT_CONFIGURED` as "disabled" rather
 * than an error — see `useGithubIntegrationQuery` and `useTaskGithubQuery`.
 * The rest of the app must keep working when the integration is off, so
 * nothing here throws for that code; callers branch on `enabled` instead.
 */

export const getGithubIntegrationStatus = (
  signal?: AbortSignal,
): Promise<GithubIntegrationStatus> =>
  api.get<GithubIntegrationStatus>("/integrations/github", { signal });

export const getTaskGithubStatus = (
  taskId: number,
  signal?: AbortSignal,
): Promise<TaskGithubStatus> => api.get<TaskGithubStatus>(`/tasks/${taskId}/github`, { signal });

export type GithubImportResult = { task: Task; created: boolean };

/** `created` is `true` for a 201 (new task), `false` for a 200 (already imported). */
export const importGithubIssue = async (input: GithubImportInput): Promise<GithubImportResult> => {
  const { data, status } = await api.postWithStatus<Task>("/integrations/github/import", input);
  return { task: data, created: status === 201 };
};

/**
 * Whether the integration is on, and what it needs. Powers the "Import
 * GitHub issue" entry point on the list, and gates the per-task badges.
 *
 * A 404 `INTEGRATION_NOT_CONFIGURED` is the expected off-state, not a query
 * failure — `retry: false` keeps a disabled instance from hammering the
 * endpoint, and the UI reads `data === undefined` the same way it would read
 * "disabled" from a 200 with `enabled: false`.
 */
export const useGithubIntegrationQuery = (): UseQueryResult<GithubIntegrationStatus> =>
  useQuery({
    queryKey: queryKeys.github.status(),
    queryFn: ({ signal }) => getGithubIntegrationStatus(signal),
    staleTime: 5 * 60_000,
    retry: false,
  });

/**
 * Live PR/issue state for the GitHub links on one task. Only meaningful once
 * the integration is known to be enabled — callers gate this with `enabled`
 * from `useGithubIntegrationQuery` so a disabled instance issues no request
 * at all, and an instance where it is on but simply has no links yet gets an
 * empty array rather than a spurious retry loop.
 */
export const useTaskGithubQuery = (
  taskId: number,
  options: { enabled: boolean },
): UseQueryResult<TaskGithubStatus> =>
  useQuery({
    queryKey: queryKeys.github.taskStatus(taskId),
    queryFn: ({ signal }) => getTaskGithubStatus(taskId, signal),
    enabled: options.enabled,
    // No automatic retry: a failure surfaces immediately as the quiet inline
    // "Retry GitHub status" control in `TaskLinks`, which is the retry this
    // query gets — a background retry loop for a feature this incidental to
    // the page would just be silent request traffic.
    retry: false,
  });

/**
 * `POST /integrations/github/import` — turns an issue into a task.
 *
 * Idempotent per issue on the server: importing the same open issue twice
 * returns the existing task (200) rather than a duplicate (201), so the
 * caller reads the response status to decide which toast to show.
 */
export const useImportGithubIssueMutation = (): UseMutationResult<
  GithubImportResult,
  Error,
  GithubImportInput
> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: GithubImportInput) => importGithubIssue(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.events.all });
    },
  });
};
