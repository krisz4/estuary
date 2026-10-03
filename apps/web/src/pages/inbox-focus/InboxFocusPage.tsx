import {
  ATTENTION_KINDS,
  attentionKindOf,
  type AttentionKind,
  type TaskSummary,
} from "@estuary/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, ExternalLink, Inbox, Map as MapIcon, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { getTask, useInboxQuery, useTaskQuery } from "@/api/tasks";
import { queryKeys } from "@/api/queryKeys";
import { EmptyState } from "@/components/EmptyState";
import { ErrorPanel } from "@/components/ErrorPanel";
import { ReachEyebrow } from "@/components/ReachEyebrow";
import { Button, Skeleton } from "@/components/ui";
import { ActorBadge } from "@/features/tasks/ActorBadge";
import { cn } from "@/lib/cn";
import {
  COMMENT_KIND_LABELS,
  formatAbsolute,
  formatCount,
  formatRelative,
  toDateTimeAttribute,
} from "@/lib/formatting";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { InboxItem } from "@/pages/inbox/InboxItem";
import { ATTENTION_GROUP_META, groupByAttentionKind } from "@/pages/inbox/attentionGroups";
import {
  appendNew,
  parseFocusKind,
  positionOf,
  resolveCurrent,
  stepsFrom,
} from "@/pages/inbox-focus/focusQueue";
import { parseProjects } from "@/pages/tasks-list/useTaskListParams";
import { useRememberProjectScope } from "@/stores/projectScope";

/**
 * `/inbox/focus` — the inbox, one item at a time. Spec: `docs/pages/Inbox_Focus.md`.
 *
 * Same query as the inbox (`useInboxQuery`), same card (`InboxItem`) and so
 * the same one-click clearing controls — what changes is the pace. One item
 * fills the screen with the context needed to decide it (the description and
 * the latest comments, which the inbox card leaves out), and clearing it moves
 * straight on to the next. Skip and Previous step through what is left, from
 * the keyboard too.
 *
 * `?kind=` narrows the session to one attention kind ("review everything
 * waiting for QA"), `?project=` to one repository — both read from the URL, so
 * the inbox's per-group "Focus" links land on exactly that slice.
 */
export const InboxFocusPage = () => {
  useDocumentTitle("Focus");

  const [searchParams] = useSearchParams();
  const projects = parseProjects(searchParams.getAll("project"));
  const kind = parseFocusKind(searchParams.get("kind"));
  useRememberProjectScope(projects);

  // A different slice is a different session: its order and cursor start over.
  return (
    <FocusSession key={`${kind ?? "all"}|${projects.join(",")}`} projects={projects} kind={kind} />
  );
};

/** `/inbox` or `/inbox/focus`, keeping the project scope and, optionally, a kind. */
const inboxHref = (
  pathname: "/inbox" | "/inbox/focus",
  projects: readonly string[],
  kind: AttentionKind | null = null,
) => {
  const params = new URLSearchParams();
  for (const project of projects) params.append("project", project);
  if (kind !== null) params.set("kind", kind);
  const search = params.toString();
  return search === "" ? pathname : `${pathname}?${search}`;
};

const isTypingTarget = (target: EventTarget | null) =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement ||
  (target instanceof HTMLElement && target.isContentEditable);

const FocusSession = ({ projects, kind }: { projects: string[]; kind: AttentionKind | null }) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data, error, isPending, isFetching, refetch } = useInboxQuery(projects);

  const allTasks = data?.data ?? [];
  // Inbox reading order — by kind, then priority — so a session that starts
  // fresh walks the queue exactly as the inbox page lists it.
  const ordered = groupByAttentionKind(allTasks)
    .filter((group) => kind === null || group.kind === kind)
    .flatMap((group) => group.tasks);
  const byId = new Map(ordered.map((task) => [task.id, task]));
  const live = new Set(byId.keys());

  // The ids this session has seen, in first-seen order — see `focusQueue.ts`.
  // Adjusted during render (React's "storing information from previous
  // renders" pattern), so the first frame with data already has an item.
  const [order, setOrder] = useState<readonly number[]>([]);
  const merged = appendNew(
    order,
    ordered.map((task) => task.id),
  );
  if (merged !== order) setOrder(merged);

  const [cursor, setCursor] = useState<number | null>(null);
  const currentId = resolveCurrent(merged, live, cursor);
  // Pin the cursor to what is shown: once an item is cleared and the view has
  // moved on, it must not jump back if that item ever reappears.
  if (currentId !== cursor && currentId !== null) setCursor(currentId);

  const current = currentId === null ? undefined : byId.get(currentId);
  const steps = currentId === null ? null : stepsFrom(merged, live, currentId);
  const cleared = merged.length - live.size;

  // Which item a wrap-around Skip landed on — the notice belongs to that item
  // only, and goes once the view moves anywhere else.
  const [wrappedTo, setWrappedTo] = useState<number | null>(null);
  const goTo = (id: number | null, wraps = false) => {
    if (id === null) return;
    setWrappedTo(wraps ? id : null);
    setCursor(id);
  };
  const skip = () => goTo(steps?.next ?? null, steps?.nextWraps ?? false);
  const previous = () => goTo(steps?.previous ?? null);

  // Warm the next item's thread, so Skip (or clearing this one) lands on a
  // fully loaded card instead of a skeleton.
  const nextId = steps?.next ?? null;
  useEffect(() => {
    if (nextId === null) return;
    void queryClient.prefetchQuery({
      queryKey: queryKeys.tasks.detail(nextId),
      queryFn: ({ signal }) => getTask(nextId, signal),
    });
  }, [nextId, queryClient]);

  // Every item after the first starts at the top, progress in view. And when
  // the change came from a clear, that item's buttons are gone and focus has
  // fallen to <body>: bring it to the new item, so the keyboard carries on
  // from here. A field that focused itself (Refine's criteria box) keeps it.
  // Not on arrival — the page opens like any other, scrolled to the top.
  const itemRef = useRef<HTMLDivElement>(null);
  const shownId = useRef<number | null>(null);
  useEffect(() => {
    if (currentId === null) return;
    const isFirst = shownId.current === null;
    shownId.current = currentId;
    if (isFirst) return;
    const active = document.activeElement;
    if (active === null || active === document.body)
      itemRef.current?.focus({ preventScroll: true });
    // A Refine card's autofocused field has already scrolled to itself; leave it be.
    if (!isTypingTarget(document.activeElement)) window.scrollTo({ top: 0 });
  }, [currentId]);

  // j/→ skip, k/← previous, o open the task, Esc back to the inbox. Never
  // while typing (Esc there just leaves the field), and never under a dialog —
  // Send back, the transition dialog, and the confirm dialog own the keyboard.
  const previousId = steps?.previous ?? null;
  const nextWraps = steps?.nextWraps ?? false;
  const exitHref = inboxHref("/inbox", projects);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]') !== null) return;
      if (isTypingTarget(event.target)) {
        if (event.key === "Escape") (event.target as HTMLElement).blur();
        return;
      }
      switch (event.key) {
        case "j":
        case "ArrowRight":
          if (nextId === null) return;
          event.preventDefault();
          setWrappedTo(nextWraps ? nextId : null);
          setCursor(nextId);
          break;
        case "k":
        case "ArrowLeft":
          if (previousId === null) return;
          event.preventDefault();
          setWrappedTo(null);
          setCursor(previousId);
          break;
        case "o":
          if (currentId !== null) void navigate(`/tasks/${currentId}`);
          break;
        case "Escape":
          void navigate(exitHref);
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, nextId, nextWraps, previousId, currentId, exitHref]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <ReachEyebrow name="Focus" place="one pool at a time" />
            <h1 className="text-2xl font-semibold text-foreground">
              {kind === null ? "Focus" : `Focus: ${ATTENTION_GROUP_META[kind].title}`}
            </h1>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to={inboxHref("/inbox", projects)}>
              <X aria-hidden="true" />
              Exit
            </Link>
          </Button>
        </div>

        <KindFilter tasks={allTasks} kind={kind} projects={projects} />

        {merged.length > 0 ? (
          <Progress
            cleared={cleared}
            total={merged.length}
            remaining={live.size}
            position={currentId === null ? null : positionOf(merged, live, currentId)}
          >
            {/* Up here, not under the card: a decision or a thread can run a
                screen long, and stepping should never need a scroll. */}
            {current === undefined ? null : (
              <nav aria-label="Focus" className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 sm:flex-none"
                  disabled={steps?.previous === null}
                  onClick={previous}
                >
                  <ArrowLeft aria-hidden="true" />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 sm:flex-none"
                  disabled={steps?.next === null}
                  onClick={skip}
                >
                  Skip
                  <ArrowRight aria-hidden="true" />
                </Button>
              </nav>
            )}
          </Progress>
        ) : null}
      </header>

      {error !== null && data !== undefined ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} isRetrying={isFetching} />
      ) : null}

      {isPending ? (
        <FocusSkeleton />
      ) : error !== null && data === undefined ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} isRetrying={isFetching} />
      ) : current === undefined ? (
        <Finished
          cleared={cleared}
          kind={kind}
          projects={projects}
          othersWaiting={
            kind === null ? 0 : allTasks.filter((t) => attentionKindOf(t) !== null).length
          }
        />
      ) : (
        <>
          {/* Announces each new item; the card's own heading says the rest. */}
          <p aria-live="polite" className="sr-only">
            {`${current.reference}: ${current.title}`}
          </p>

          {wrappedTo === current.id ? (
            <p className="text-sm text-muted-foreground">
              Back to the start of what&apos;s left — these are the ones you skipped.
            </p>
          ) : null}

          <div
            ref={itemRef}
            tabIndex={-1}
            aria-label="Current item"
            className="flex flex-col gap-4 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <InboxItem key={current.id} task={current} />
            <FocusContext task={current} kind={attentionKindOf(current)} />
          </div>

          <p className="hidden text-xs text-muted-foreground sm:block">
            <Kbd>j</Kbd> / <Kbd>→</Kbd> skip · <Kbd>k</Kbd> / <Kbd>←</Kbd> previous · <Kbd>o</Kbd>{" "}
            open task · <Kbd>Esc</Kbd> leave a field, then exit
          </p>
        </>
      )}
    </div>
  );
};

const Kbd = ({ children }: { children: string }) => (
  <kbd className="rounded border border-border bg-muted px-1 font-mono text-[11px] text-foreground">
    {children}
  </kbd>
);

/**
 * "All (12) · Decide (2) · Review (7) …" — links to the other slices, counted
 * from the whole loaded queue (not just this session's kind), so the way to
 * the rest of the work is always one click away.
 */
const KindFilter = ({
  tasks,
  kind,
  projects,
}: {
  tasks: TaskSummary[];
  kind: AttentionKind | null;
  projects: string[];
}) => {
  const counts = new Map<AttentionKind, number>();
  for (const task of tasks) {
    const taskKind = attentionKindOf(task);
    if (taskKind !== null) counts.set(taskKind, (counts.get(taskKind) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (total === 0) return null;

  const chips: { value: AttentionKind | null; label: string; count: number }[] = [
    { value: null, label: "All", count: total },
    ...ATTENTION_KINDS.filter((value) => (counts.get(value) ?? 0) > 0 || value === kind).map(
      (value) => ({
        value,
        label: ATTENTION_GROUP_META[value].title,
        count: counts.get(value) ?? 0,
      }),
    ),
  ];

  return (
    <nav aria-label="Focus on" className="flex flex-wrap gap-1.5">
      {chips.map((chip) => {
        const isActive = chip.value === kind;
        return (
          <Link
            key={chip.value ?? "all"}
            to={inboxHref("/inbox/focus", projects, chip.value)}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset",
              isActive
                ? "bg-primary text-primary-foreground ring-primary"
                : "bg-card text-foreground ring-border hover:bg-muted",
            )}
          >
            {chip.label}
            <span className={cn("tabular-nums", !isActive && "text-muted-foreground")}>
              {chip.count}
            </span>
          </Link>
        );
      })}
    </nav>
  );
};

const Progress = ({
  cleared,
  total,
  remaining,
  position,
  children,
}: {
  cleared: number;
  total: number;
  remaining: number;
  position: number | null;
  /** Previous / Skip, on the same row on `sm` and up, below it on a phone. */
  children: ReactNode;
}) => (
  <div className="flex flex-col gap-2">
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p className="flex items-baseline gap-3 text-sm">
        <span className="font-medium text-foreground tabular-nums">
          {position === null ? "All clear" : `${position} of ${remaining} left`}
        </span>
        <span className="text-muted-foreground tabular-nums">{cleared} cleared</span>
      </p>
      {children}
    </div>
    <div
      role="progressbar"
      aria-label="Cleared this session"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={cleared}
      className="h-1.5 overflow-hidden rounded-full bg-muted"
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-300"
        style={{ width: `${total === 0 ? 0 : (cleared / total) * 100}%` }}
      />
    </div>
  </div>
);

/** How many of the latest comments the context panel shows. */
const RECENT_COMMENTS = 3;

/**
 * What the inbox card leaves out and a decision often needs: the task's
 * description (unless the card already shows it — a Suggested item does) and
 * the latest few comments, from the task's own detail query. Its own loading
 * and error states, so a slow thread never holds up the actions above it.
 */
const FocusContext = ({ task, kind }: { task: TaskSummary; kind: AttentionKind | null }) => {
  const { data, error, isPending, isFetching, refetch } = useTaskQuery(task.id);
  const showDescription = kind !== "suggested";
  const comments = data?.comments.slice(-RECENT_COMMENTS) ?? [];
  const older = (data?.comments.length ?? 0) - comments.length;

  return (
    <section
      aria-label="Context"
      className="flex flex-col gap-3 rounded-lg border border-border bg-background/60 p-4"
    >
      {showDescription ? (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Description
          </h4>
          <p className="max-h-60 overflow-y-auto text-sm whitespace-pre-wrap text-foreground">
            {task.description}
          </p>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Latest comments
          </h4>
          <Link
            to={`/tasks/${task.id}`}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            Open task
            <ExternalLink className="size-3" aria-hidden="true" />
          </Link>
        </div>
        {isPending ? (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading comments">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : error !== null && data === undefined ? (
          <p className="text-sm text-muted-foreground">
            Couldn&apos;t load the thread.{" "}
            <button
              type="button"
              className="font-medium text-primary hover:underline disabled:opacity-60"
              disabled={isFetching}
              onClick={() => void refetch()}
            >
              Retry
            </button>
          </p>
        ) : comments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No comments yet.</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {older > 0 ? (
              <li className="text-xs text-muted-foreground">
                {formatCount(older, "earlier comment")} on the task page
              </li>
            ) : null}
            {comments.map((comment) => (
              <li key={comment.id} className="flex flex-col gap-0.5 text-sm">
                <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <ActorBadge actor={comment.author} plain />
                  {comment.kind === "note" ? null : (
                    <span>{COMMENT_KIND_LABELS[comment.kind]}</span>
                  )}
                  <time
                    dateTime={toDateTimeAttribute(comment.createdAt)}
                    title={formatAbsolute(comment.createdAt)}
                  >
                    {formatRelative(comment.createdAt)}
                  </time>
                </p>
                <p className="line-clamp-6 whitespace-pre-wrap text-foreground">{comment.body}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
};

/**
 * Nothing left in this slice. Three different messages: the queue was empty
 * from the start (the inbox's own "nothing needs you"), this session cleared
 * it, or a `kind` slice is clear while other kinds still wait — then the next
 * step is the rest of the queue, not the map.
 */
const Finished = ({
  cleared,
  kind,
  projects,
  othersWaiting,
}: {
  cleared: number;
  kind: AttentionKind | null;
  projects: string[];
  othersWaiting: number;
}) => {
  const action =
    othersWaiting > 0 ? (
      <Button asChild>
        <Link to={inboxHref("/inbox/focus", projects)}>
          <ArrowRight aria-hidden="true" />
          Focus on everything else ({othersWaiting})
        </Link>
      </Button>
    ) : (
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button asChild variant="outline">
          <Link to={inboxHref("/inbox", projects)}>
            <Inbox aria-hidden="true" />
            Back to the inbox
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/tasks/map">
            <MapIcon aria-hidden="true" />
            Go to the map
          </Link>
        </Button>
      </div>
    );

  const scope = kind === null ? "" : ` in ${ATTENTION_GROUP_META[kind].title}`;
  return (
    <EmptyState
      art="still-water"
      title={
        cleared > 0
          ? `All clear — ${formatCount(cleared, "item")} cleared`
          : `Nothing${scope} needs you`
      }
      description={
        cleared > 0
          ? `That's everything${scope} that was waiting on you. Anything an agent asks next shows up here and in the inbox.`
          : "Slack water: no questions, manual steps, or work waiting for review. When an agent needs a human, it shows up here."
      }
      action={action}
    />
  );
};

const FocusSkeleton = () => (
  <div
    className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-raised"
    aria-busy="true"
    aria-label="Loading focus"
  >
    <Skeleton className="h-3 w-24" />
    <Skeleton className="h-5 w-3/4" />
    <Skeleton className="h-24 w-full" />
    <div className="flex gap-2">
      <Skeleton className="h-9 w-28" />
      <Skeleton className="h-9 w-24" />
    </div>
  </div>
);
