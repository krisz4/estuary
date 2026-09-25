import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { type Comment, type CreateCommentInput } from "@helpdesk/contracts";
import { api } from "@/api/http";
import { queryKeys } from "@/api/queryKeys";

/**
 * Comment writes. There is no read hook and no list endpoint: the thread ships
 * inside `GET /tasks/:taskId` (`docs/features/Comments.md`), so the detail
 * query is the only reader and these mutations invalidate it.
 *
 * **`queryKeys.tasks.detail(taskId)`, not `tasks.all`.** A comment does
 * not bump the task's `version`, so no list row changed position or filter
 * membership. Widening this to `all` would re-issue the list, stats and facets
 * requests on every comment — the narrower key is the correct one, not the lazy
 * one. The task's activity timeline is refreshed too: `comment.created` is an
 * event, and the user should see their own post in it without waiting a poll.
 */

export const createComment = (taskId: number, input: CreateCommentInput): Promise<Comment> =>
  api.post<Comment>(`/tasks/${taskId}/comments`, input);

export const deleteComment = (taskId: number, commentId: number): Promise<void> =>
  api.delete<void>(`/tasks/${taskId}/comments/${commentId}`);

export const useCreateCommentMutation = (
  taskId: number,
): UseMutationResult<Comment, Error, CreateCommentInput> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateCommentInput) => createComment(taskId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.events.task(taskId) });
    },
  });
};

export const useDeleteCommentMutation = (
  taskId: number,
): UseMutationResult<void, Error, number> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (commentId: number) => deleteComment(taskId, commentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.events.task(taskId) });
    },
  });
};
