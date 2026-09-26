import { useQueryClient } from "@tanstack/react-query";
import { type Comment } from "@helpdesk/contracts";
import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useDeleteCommentMutation } from "@/api/comments";
import { queryKeys } from "@/api/queryKeys";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Badge, Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { errorCopy } from "@/lib/errorMessages";
import {
  COMMENT_KIND_LABELS,
  actorDisplayName,
  formatAbsolute,
  formatRelative,
  toDateTimeAttribute,
} from "@/lib/formatting";
import { CommentComposer } from "@/features/comments/CommentComposer";
import { ActorBadge } from "@/features/tasks/ActorBadge";

/**
 * The comment thread and its composer.
 *
 * Ordering is the server's — `createdAt` ascending with an `id` tiebreaker
 * (`docs/features/Comments.md`). The client does **not** re-sort: the seed
 * deliberately creates comments inside the same millisecond, and a client-side
 * `sort` on `createdAt` alone would reorder them differently from the API on
 * every render.
 *
 * Agents and humans share the thread. Each comment names its author with an
 * agent/human badge, and a non-`note` kind — an agent's `progress` log, a
 * `qa_feedback` send-back — carries a tag, so a reader can tell working notes
 * from discussion without opening each one.
 *
 * Bodies render as text nodes. There is no markdown pass and no
 * `dangerouslySetInnerHTML` anywhere in this app — `whitespace-pre-wrap` is what
 * preserves the author's line breaks, and it is a CSS property, so a body
 * containing `<img src=x onerror=…>` is displayed rather than parsed.
 */

export type CommentThreadProps = {
  taskId: number;
  comments: readonly Comment[];
};

export const CommentThread = ({ taskId, comments }: CommentThreadProps) => {
  const [pendingDelete, setPendingDelete] = useState<Comment | null>(null);
  const [focusCommentId, setFocusCommentId] = useState<number | null>(null);

  const queryClient = useQueryClient();
  const deleteMutation = useDeleteCommentMutation(taskId);

  return (
    <section className="flex flex-col gap-4" aria-labelledby="comments-heading">
      <h2 id="comments-heading" className="text-base font-semibold text-foreground">
        Comments{comments.length === 0 ? "" : ` (${comments.length})`}
      </h2>

      {comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments yet.</p>
      ) : (
        <ul aria-label="Comment thread" className="flex flex-col gap-3">
          {comments.map((comment) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              autoFocus={comment.id === focusCommentId}
              onDelete={() => setPendingDelete(comment)}
            />
          ))}
        </ul>
      )}

      <CommentComposer taskId={taskId} onCreated={(comment) => setFocusCommentId(comment.id)} />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete this comment?"
        description={
          pendingDelete === null
            ? ""
            : `The comment by ${actorDisplayName(pendingDelete.author)} will be removed. This can't be undone.`
        }
        confirmLabel="Delete comment"
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (pendingDelete === null) return;
          deleteMutation.mutate(pendingDelete.id, {
            onSuccess: () => {
              setPendingDelete(null);
              toast.success("Comment deleted");
            },
            onError: (error) => {
              setPendingDelete(null);
              const copy = errorCopy(error);
              toast.error(copy.title, { description: copy.description });

              // The thread on screen is now known to be wrong, and for the
              // likeliest failure it is *guaranteed* wrong: COMMENT_NOT_FOUND
              // means it was already deleted somewhere else, so the row the
              // user just tried to remove is stale. Without this it stays
              // there, and every retry reproduces the same 404 forever.
              void queryClient.invalidateQueries({
                queryKey: queryKeys.tasks.detail(taskId),
              });
            },
          });
        }}
      />
    </section>
  );
};

const CommentItem = ({
  comment,
  autoFocus,
  onDelete,
}: {
  comment: Comment;
  autoFocus: boolean;
  onDelete: () => void;
}) => {
  const ref = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  return (
    <li
      ref={ref}
      // Focused programmatically after a successful post so a screen reader lands
      // on the comment it just created. `-1` keeps it out of the tab order —
      // a thread of 20 comments must not cost 20 tab stops.
      tabIndex={-1}
      className="group flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2.5 shadow-raised"
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <h3 className="text-sm font-semibold break-words text-foreground">
            <ActorBadge actor={comment.author} plain className="text-sm text-foreground" />
          </h3>
          {comment.kind === "note" ? null : (
            <Badge tone={comment.kind === "qa_feedback" ? "warning" : "info"}>
              {COMMENT_KIND_LABELS[comment.kind]}
            </Badge>
          )}
          <time
            dateTime={toDateTimeAttribute(comment.createdAt)}
            title={formatAbsolute(comment.createdAt)}
            className="text-xs text-muted-foreground"
          >
            {formatRelative(comment.createdAt)}
          </time>
        </div>

        <Button
          variant="ghost"
          size="icon"
          aria-label={`Delete comment by ${actorDisplayName(comment.author)}`}
          onClick={onDelete}
          className={cn(
            "size-8 shrink-0 text-muted-foreground hover:text-destructive",
            /*
              Visible by default; hidden only where a pointer can bring it back.
              `can-hover:` is `@media (hover: hover)` (defined in index.css) —
              Tailwind's own `group-hover:`/`focus-visible:` already compile
              inside that same query, so only the *hiding* half needs the guard.
              On a touch device none of these match and the button stays visible,
              which is the only way it is reachable there.
            */
            "transition-opacity",
            "can-hover:opacity-0",
            "group-hover:opacity-100",
            "group-focus-within:opacity-100",
            "focus-visible:opacity-100",
          )}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>

      {/* Text node + `whitespace-pre-wrap`. Never `dangerouslySetInnerHTML`. */}
      <p className="text-sm whitespace-pre-wrap text-foreground">{comment.body}</p>
    </li>
  );
};
