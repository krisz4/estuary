import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { type Comment, type CreateCommentInput } from "@helpdesk/contracts";
import { api } from "@/api/http";
import { queryKeys } from "@/api/queryKeys";

/**
 * Comment writes. There is no read hook and no list endpoint: the thread ships
 * inside `GET /tickets/:ticketId` (`docs/features/Comments.md`), so the detail
 * query is the only reader and these mutations invalidate it.
 *
 * **`queryKeys.tickets.detail(ticketId)`, not `tickets.all`.** A comment does
 * not move `Ticket.updatedAt`, so no list row changed position, count, or
 * filter membership. Widening this to `all` would re-issue the list and facets
 * requests on every comment — the narrower key is the correct one, not the lazy
 * one.
 */

export const createComment = (ticketId: number, input: CreateCommentInput): Promise<Comment> =>
  api.post<Comment>(`/tickets/${ticketId}/comments`, input);

export const deleteComment = (ticketId: number, commentId: number): Promise<void> =>
  api.delete<void>(`/tickets/${ticketId}/comments/${commentId}`);

export const useCreateCommentMutation = (
  ticketId: number,
): UseMutationResult<Comment, Error, CreateCommentInput> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateCommentInput) => createComment(ticketId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tickets.detail(ticketId) });
    },
  });
};

export const useDeleteCommentMutation = (
  ticketId: number,
): UseMutationResult<void, Error, number> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (commentId: number) => deleteComment(ticketId, commentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tickets.detail(ticketId) });
    },
  });
};
